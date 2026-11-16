const EVENT_LIMIT = 256;
const AGENT_LIMIT = 64;
const TURN_LIMIT = 32;
const TOOL_LIMIT = 32;
const STALLED_AFTER_MS = 20000;

const HOOKS = new Set(['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'Interrupt',
  'SubagentStart', 'SubagentStop', 'PreToolUse', 'PostToolUse', 'PermissionRequest']);
const ROLES = new Map([['worker', 'Worker'], ['explorer', 'Explorer'], ['researcher', 'Researcher'],
  ['reviewer', 'Reviewer'], ['tester', 'Tester'], ['implementer', 'Implementer']]);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : null;

/** Select only fields that can affect the projection. Input/output content never enters the journal. */
export function hookEvent(input) {
  const kind = input?.hook_event_name;
  const session = identifier(input?.session_id);
  if (!HOOKS.has(kind) || !session) return null;
  const event = { kind, session, turn: identifier(input.turn_id) };
  if (kind === 'SubagentStart' || kind === 'SubagentStop') {
    event.child = identifier(input.agent_id);
    if (!event.child || event.child === session) return null;
    event.role = ROLES.has(input.agent_type) ? input.agent_type : 'agent';
  }
  if (['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Interrupt'].includes(kind) && input.agent_id != null) {
    event.agent = identifier(input.agent_id);
    if (!event.agent) return null;
  }
  if (kind === 'PreToolUse' || kind === 'PostToolUse' || kind === 'PermissionRequest') {
    event.tool = identifier(input.tool_name);
    event.call = identifier(input.tool_use_id);
    if (!event.tool || (kind !== 'PermissionRequest' && !event.call)) return null;
  }
  if (kind === 'SessionStart') event.resumed = input.source === 'resume' || input.source === 'clear';
  return event;
}

export const canStartRun = event => !event.agent &&
  ['SessionStart', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop'].includes(event.kind);
export const newRun = () => ({ seq: 0, agents: [], events: [] });

/** Reduce one observed, sanitized hook event. The return value identifies newly indexed actors. */
export function observe(run, event, at) {
  const registered = [];
  function emit(agent, kind, tool = null, detail = {}) {
    const item = { seq: ++run.seq, agentId: agent.id, kind, at, tool, ...detail };
    run.events.push(item);
    agent.lastEvent = { kind, at, tool };
  }
  function change(agent, state, reason) {
    if (agent.state === state) return;
    const from = agent.state;
    agent.state = state;
    agent.since = at;
    emit(agent, 'state.changed', null, { from, to: state, reason });
  }
  function register(id, parentId, role) {
    if (run.agents.length >= AGENT_LIMIT) return null;
    const label = parentId === null ? 'Codex' : ROLES.get(role) ?? `Agent ${run.agents.length}`;
    const agent = { id, parentId, role, label, ticketId: null, state: 'idle', since: at, lastEvent: null,
      open: false, turn: null, closedTurns: [], tools: [], completedCalls: [], pending: [] };
    run.agents.push(agent);
    registered.push(id);
    emit(agent, 'agent.register', null, { label });
    return agent;
  }
  function finish(agent, state, reason) {
    if (!agent.open) return;
    for (const { name } of agent.tools) emit(agent, 'tool.end', name, { synthetic: true, reason });
    for (const { name } of agent.pending) emit(agent, 'attention.resolved', name, { synthetic: true, reason });
    agent.tools = [];
    agent.completedCalls = [];
    agent.pending = [];
    if (agent.turn) agent.closedTurns = [...agent.closedTurns, agent.turn].slice(-TURN_LIMIT);
    agent.turn = null;
    agent.open = false;
    emit(agent, 'turn.end', null, { reason });
    change(agent, state, reason);
  }
  function start(agent, turn, inferred = false) {
    agent.open = true;
    agent.turn = turn;
    emit(agent, 'turn.start', null, inferred ? { synthetic: true, reason: 'tool_observed' } : {});
    change(agent, 'running', 'turn_started');
  }
  function activeTurn(agent) {
    if (!event.turn || agent.closedTurns.includes(event.turn)) return false;
    if (!agent.open) start(agent, event.turn, true);
    // Some hook versions report the parent's turn in SubagentStart. Bind on observed child activity.
    agent.turn ??= event.turn;
    return agent.turn === event.turn;
  }
  function observeTool(agent) {
    if (!activeTurn(agent)) return;
    if (event.kind === 'PermissionRequest') {
      const candidates = agent.tools.filter(tool => tool.name === event.tool);
      const call = event.call ?? (candidates.length === 1 ? candidates[0].id : null);
      if (agent.pending.length >= TOOL_LIMIT || agent.pending.some(item => item.name === event.tool && item.call === call)) return;
      agent.pending.push({ name: event.tool, call });
      emit(agent, 'attention.raised', event.tool);
      change(agent, 'waiting-human', 'permission_requested');
      return;
    }
    if (agent.completedCalls.includes(event.call)) return;
    const index = agent.tools.findIndex(tool => tool.id === event.call);
    if (event.kind === 'PreToolUse') {
      if (index >= 0 || agent.tools.length >= TOOL_LIMIT) return;
      agent.tools.push({ id: event.call, name: event.tool });
      emit(agent, 'tool.start', event.tool);
      return;
    }
    if (index >= 0) agent.tools.splice(index, 1);
    agent.completedCalls = [...agent.completedCalls, event.call].slice(-TOOL_LIMIT);
    emit(agent, 'tool.end', event.tool);
    agent.pending = agent.pending.filter(item => {
      // The permission hook may omit a call ID. A same-name completion alone cannot resolve it.
      if (item.name !== event.tool || item.call !== event.call) return true;
      emit(agent, 'attention.resolved', event.tool, { reason: 'tool_completed' });
      return false;
    });
    if (!agent.pending.length) change(agent, 'running', 'permission_no_longer_pending');
  }

  const actor = run.agents.find(agent => agent.id === (event.agent ?? event.session)) ??
    (!run.agents.length && canStartRun(event) ? register(event.session, null, 'coordinator') : null);
  if (!actor) return registered;
  switch (event.kind) {
    case 'SessionStart':
      if (event.resumed) finish(actor, 'idle', 'session_resumed');
      break;
    case 'SessionEnd':
      finish(actor, 'idle', 'session_ended');
      break;
    case 'UserPromptSubmit':
      if (!event.turn || actor.turn === event.turn || actor.closedTurns.includes(event.turn)) break;
      finish(actor, 'idle', 'turn_superseded');
      start(actor, event.turn);
      break;
    case 'Stop':
    case 'Interrupt':
      if (actor.turn !== null && event.turn && actor.turn !== event.turn) break;
      finish(actor, event.kind === 'Stop' ? 'done' : 'idle', event.kind === 'Stop' ? 'stopped' : 'interrupted');
      break;
    case 'SubagentStart':
    case 'SubagentStop': {
      const child = run.agents.find(agent => agent.id === event.child) ?? register(event.child, actor.id, event.role);
      if (!child || child.parentId !== actor.id) break;
      if (event.turn && child.closedTurns.includes(event.turn)) break;
      if (event.kind === 'SubagentStart' && !child.open) start(child, null);
      if (event.kind === 'SubagentStop') {
        if (child.open && !child.turn && event.turn !== actor.turn) child.turn = event.turn;
        if (child.open) finish(child, 'done', 'subagent_stopped');
        else change(child, 'done', 'subagent_stopped');
      }
      break;
    }
    default:
      observeTool(actor);
      break;
  }
  run.events = run.events.slice(-EVENT_LIMIT);
  return registered;
}

export function snapshot(run, now) {
  const timestamp = now.toISOString();
  const agents = run.agents.map(({ id, label, role, parentId, ticketId, state, since, lastEvent }) => ({
    id, label, role, parentId, ticketId, state, since, lastEvent,
    stalled: state === 'running' && now.getTime() - Date.parse(lastEvent?.at ?? since) > STALLED_AFTER_MS,
  }));
  return { v: 1, aliasVersion: 1, seq: run.seq, now: timestamp, agents,
    events: run.events, eventsFromSeq: run.events[0]?.seq ?? run.seq, stalledAfterMs: STALLED_AFTER_MS };
}
