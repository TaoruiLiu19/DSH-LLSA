/**
 * The data source — this is where DSH's own activity becomes a hud-v1 snapshot.
 *
 * Two sources, one wire shape (`contracts/hud-v1.schema.json`):
 *
 * 1. **hud** — an orchestrator that already speaks hud-v1 (§2.1). The Host half
 *    can be pointed at such an endpoint (`hudEndpoint`); a valid answer is passed
 *    through untouched, because the contract is frozen on the orchestrator's side.
 * 2. **core** — the degraded source. It is what makes the plugin installable in
 *    a clean DSH (§5.2, §5.3): DSH's durable `session/event` feed, `agent/status`
 *    and the published sub-agents are folded into the same event vocabulary the
 *    orchestrator emits (`turn.start`, `tool.start`, `tool.end`, `state.changed`,
 *    `attention.*`, `agent.register`).
 *
 * Everything the core source emits derives from a committed session event or an
 * explicit status transition. There is deliberately no "quiet for N ms ⇒ idle"
 * rule (§5.5): `stalled` is computed the way the contract defines it — from
 * `lastActivity`, by the producer, never by the client — and no tool output is
 * parsed (§5.6).
 */
import { hudLabel } from './labels.js';
import { ALIAS_VERSION } from './materials.js';

/** The event window of §2.1. Older events are dropped, and `eventsFromSeq` moves. */
export const EVENT_WINDOW = 256;

/** How many sessions the Host half keeps warm. */
export const MAX_SESSIONS = 32;

/** The contract's default stall horizon (`stalledAfterMs`). */
export const STALLED_AFTER_MS = 20000;

const TEXT_CAP = 240;
const TOOL_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

function iso(time) {
  const value = typeof time === 'number' && Number.isFinite(time) ? time : Date.now();
  return new Date(value).toISOString();
}

/** The contract's `tool` type: a native id, or null when the event carries none. */
export function safeTool(value) {
  return typeof value === 'string' && TOOL_PATTERN.test(value) ? value : null;
}

/** First text block of a user message, flattened. Tool output is never read. */
export function textOfMessage(message) {
  if (message === null || typeof message !== 'object') return '';
  const blocks = Array.isArray(message.content) ? message.content : [];
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      const line = block.text.replace(/\s+/g, ' ').trim();
      if (line !== '') return line.length > TEXT_CAP ? line.slice(0, TEXT_CAP) : line;
    }
  }
  return '';
}

function createAgent(id, options = {}) {
  return {
    id,
    label: typeof options.label === 'string' ? options.label : hudLabel({ role: options.role ?? 'worker' }),
    role: typeof options.role === 'string' ? options.role : 'worker',
    parentId: options.parentId ?? null,
    ticketId: options.ticketId ?? null,
    state: 'idle',
    since: iso(options.at ?? Date.now()),
    lastEvent: null,
    lastActivity: options.at ?? Date.now(),
    turn: null,
    tools: new Map(),
    attention: new Set(),
  };
}

function createSessionState(id) {
  return {
    id,
    seq: 0,
    events: [],
    agents: new Map(),
    taskText: '',
    lastActivity: Date.now(),
    /** Last observed `Session`, used to re-derive the pending question. */
    session: null,
    /** Set when the log may have moved; cleared once attention is reconciled. */
    dirty: false,
  };
}

/**
 * The core collector: one instance per Host plugin activation.
 *
 * @param options.maxSessions - sessions kept warm (oldest activity is evicted).
 */
export function createCollector(options = {}) {
  const maxSessions = Number.isFinite(options.maxSessions) ? options.maxSessions : MAX_SESSIONS;
  const sessions = new Map();

  function stateFor(sessionId) {
    const id = String(sessionId);
    let state = sessions.get(id);
    if (state === undefined) {
      state = createSessionState(id);
      sessions.set(id, state);
      if (sessions.size > maxSessions) {
        let oldest = null;
        for (const [key, value] of sessions) {
          if (key === id) continue;
          if (oldest === null || value.lastActivity < oldest[1].lastActivity) oldest = [key, value];
        }
        if (oldest !== null) sessions.delete(oldest[0]);
      }
    }
    return state;
  }

  function emit(state, agentId, kind, at, extra = {}) {
    state.seq += 1;
    const event = { seq: state.seq, agentId: String(agentId), kind, at: iso(at), tool: safeTool(extra.tool) };
    if (extra.from !== undefined) event.from = extra.from;
    if (extra.to !== undefined) event.to = extra.to;
    if (extra.reason !== undefined) event.reason = extra.reason;
    if (extra.synthetic === true) event.synthetic = true;
    if (extra.label !== undefined) event.label = extra.label;
    state.events.push(event);
    if (state.events.length > EVENT_WINDOW) state.events.splice(0, state.events.length - EVENT_WINDOW);
    state.lastActivity = typeof at === 'number' ? at : state.lastActivity;
    return event;
  }

  function agentFor(state, id, options = {}) {
    const key = String(id);
    let agent = state.agents.get(key);
    if (agent === undefined) {
      agent = createAgent(key, { role: options.role ?? 'worker', parentId: options.parentId ?? null, at: options.at });
      state.agents.set(key, agent);
    }
    if (options.label !== undefined && options.label !== '') agent.label = hudLabel({ assignmentTitle: options.label, role: agent.role });
    if (options.parentId !== undefined) agent.parentId = options.parentId;
    return agent;
  }

  function change(state, agent, next, reason, at) {
    if (!['idle', 'running', 'waiting-human', 'done', 'failed'].includes(next)) return;
    if (agent.state === next) return;
    const from = agent.state;
    agent.state = next;
    agent.since = iso(at);
    agent.lastEvent = emit(state, agent.id, 'state.changed', at, { from, to: next, reason });
  }

  function activity(state, agent, kind, at, extra = {}) {
    agent.lastActivity = at;
    agent.lastEvent = emit(state, agent.id, kind, at, extra);
  }

  /** Close every open tool with a synthetic `tool.end` (an interrupted call). */
  function closeTools(state, agent, at, reason = 'interrupted') {
    for (const name of agent.tools.values()) {
      activity(state, agent, 'tool.end', at, { tool: name, reason, synthetic: true });
    }
    agent.tools.clear();
  }

  function clearAttention(state, agent, at, reason) {
    for (const attentionId of [...agent.attention]) {
      agent.attention.delete(attentionId);
      agent.lastEvent = emit(state, agent.id, 'attention.resolved', at, { reason, synthetic: true });
    }
  }

  /**
   * Resolve every open question and move the agent back to work.
   *
   * Clearing the set alone would leave `state` on `waiting-human`: the state is
   * only recomputed by `change`, so an answered question would keep the yellow
   * light until the next turn boundary.
   */
  function settleAttention(state, agent, at, reason) {
    if (agent.attention.size === 0) return;
    clearAttention(state, agent, at, reason);
    change(state, agent, agent.turn === null ? 'idle' : 'running', 'confirmation_resolved', at);
  }

  /**
   * Seed the task line from the session log.
   *
   * A plugin activated mid-turn never sees the `user/message` that started it, so
   * the centre would fall back to a generic word. `deriveMessages()` is a public
   * read of the same log; it runs once per session and only for the last user
   * message (never for tool output).
   */
  function seedFromSession(state, session) {
    if (state.taskText !== '' || session === null || session === undefined) return;
    if (typeof session.deriveMessages !== 'function') return;
    try {
      const messages = session.deriveMessages();
      if (!Array.isArray(messages)) return;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message === null || typeof message !== 'object' || message.role !== 'user') continue;
        const text = textOfMessage(message);
        if (text === '') continue;
        state.taskText = text;
        const agent = state.agents.get(state.id);
        if (agent !== undefined) agent.label = hudLabel({ assignmentTitle: text, role: agent.role });
        return;
      }
    } catch {
      // A session that cannot derive messages simply has no task line.
    }
  }

  /** One durable `session/event`. Unknown types are ignored on purpose. */
  function observeEvent(sessionId, event, session) {
    if (event === null || typeof event !== 'object') return;
    const state = stateFor(sessionId);
    // Keep the log handle: the pending question is derived from it, not from the
    // tool's return value, and it is the same source the host projection uses.
    if (session !== null && session !== undefined) state.session = session;
    state.dirty = true;
    seedFromSession(state, session);
    const data = event.data !== null && typeof event.data === 'object' ? event.data : {};
    const at = Number.isFinite(event.time) ? event.time : Date.now();
    const agent = agentFor(state, sessionId, { role: 'root', at, label: state.taskText });

    switch (event.type) {
      case 'user/message': {
        state.taskText = textOfMessage(data);
        if (state.taskText !== '') {
          agent.label = hudLabel({ assignmentTitle: state.taskText, role: 'root' });
        }
        // The answer to a question arrives as a user message: that is the record
        // which closes it, not the tool's return value.
        settleAttention(state, agent, at, 'answered');
        break;
      }
      case 'turn/start': {
        if (agent.turn === data.turn) break;
        if (agent.turn !== null) {
          closeTools(state, agent, at);
          activity(state, agent, 'turn.end', at, { reason: 'superseded', synthetic: true });
        }
        agent.turn = Number.isFinite(data.turn) ? data.turn : agent.turn;
        activity(state, agent, 'turn.start', at);
        change(state, agent, agent.attention.size > 0 ? 'waiting-human' : 'running', 'turn_started', at);
        break;
      }
      case 'tool/call': {
        const name = safeTool(data.name);
        if (name === null) break;
        if (agent.turn === null) {
          // Joined mid-turn: the Host half was activated after `turn.start`, so
          // the first thing it sees is a tool call. Adopting the turn is what
          // makes installing (or restarting) the plugin mid-run show the field
          // instead of staying blank until the next command.
          agent.turn = -1;
          activity(state, agent, 'turn.start', at);
          change(state, agent, agent.attention.size > 0 ? 'waiting-human' : 'running', 'turn_started', at);
        }
        const callId = data.callId === undefined ? `call-${state.seq + 1}` : String(data.callId);
        if (agent.tools.has(callId)) break;
        agent.tools.set(callId, name);
        activity(state, agent, 'tool.start', at, { tool: name });
        if (name === 'ask_user_question') {
          // Raise on the call only. The result is *not* evidence of an answer: a
          // timed-out wait returns `{ pending: true }` and the question stays
          // answerable, so resolving on the result is what lost the yellow light.
          const attentionId = `question:${callId}`;
          if (!agent.attention.has(attentionId)) {
            agent.attention.add(attentionId);
            activity(state, agent, 'attention.raised', at);
            change(state, agent, 'waiting-human', 'confirmation_pending', at);
          }
        }
        break;
      }
      case 'tool/result': {
        const message = data.message !== null && typeof data.message === 'object' ? data.message : {};
        const callId = message.toolCallId === undefined ? String(data.callId ?? '') : String(message.toolCallId);
        const name = agent.tools.get(callId);
        if (name === undefined) break;
        agent.tools.delete(callId);
        activity(state, agent, 'tool.end', at, { tool: name });
        if (name === 'ask_user_question') {
          // The call ended, but "ended" is not "answered": the result is either a
          // real answer (which then arrives as a user message) or `pending: true`.
          // Reconciliation against the log decides; never the return value.
          state.dirty = true;
        }
        break;
      }
      case 'turn/end': {
        if (agent.turn === null) break;
        const reason = data.reason !== null && typeof data.reason === 'object' ? String(data.reason.kind ?? '') : '';
        const outcome = reason === 'completed'
          ? 'completed'
          : ['error', 'timeout', 'max-tokens'].includes(reason)
            ? 'failed'
            : reason === 'aborted' ? 'cancelled' : 'idle';
        closeTools(state, agent, at);
        agent.turn = null;
        activity(state, agent, 'turn.end', at, { reason: outcome });
        if (outcome === 'cancelled') {
          clearAttention(state, agent, at, 'cancelled');
          change(state, agent, 'idle', 'cancelled', at);
        } else {
          change(state, agent, agent.attention.size > 0 ? 'waiting-human' : outcome === 'completed' ? 'done' : outcome === 'failed' ? 'failed' : 'idle', 'turn_ended', at);
        }
        break;
      }
      default:
        break;
    }
  }

  /** Explicit status only; `running` starts nothing by itself. */
  function observeStatus(sessionId, status) {
    const state = stateFor(sessionId);
    const agent = state.agents.get(String(sessionId));
    if (agent === undefined) return;
    if (status === 'running' && agent.turn === null && agent.state === 'idle') {
      // The agent woke without a turn event in this window: treat it as activity
      // for stall accounting, but do not invent a running state (a turn.start
      // will arrive and change it).
      agent.lastActivity = Date.now();
    }
  }

  /**
   * The question that is still open in the log, or `undefined` when the log
   * cannot be read.
   *
   * Authoritative rule from the host contract: an answer is steered into the
   * agent as a **user message**, and that message is the record that closes the
   * question. So the log decides: the last ask call after the last user message
   * is still waiting. A timed-out call returns `{ pending: true }` — the question
   * stays answerable, so it must stay open here too. The tool's own output is
   * never inspected.
   */
  function openQuestionFromLog(session) {
    if (session === null || session === undefined || typeof session.deriveMessages !== 'function') return undefined;
    let open = null;
    let sawToolCall = false;
    try {
      const messages = session.deriveMessages();
      if (!Array.isArray(messages)) return undefined;
      for (const message of messages) {
        if (message === null || typeof message !== 'object') continue;
        if (message.role === 'user') {
          open = null;
          continue;
        }
        const blocks = Array.isArray(message.content) ? message.content : [];
        for (const block of blocks) {
          if (block === null || typeof block !== 'object') continue;
          const kind = String(block.type ?? block.kind ?? '');
          if (kind !== 'tool-call' && kind !== 'tool_call') continue;
          sawToolCall = true;
          const name = block.name ?? block.toolName;
          if (name !== 'ask_user_question') continue;
          const callId = block.id ?? block.callId ?? block.toolCallId;
          open = callId === undefined ? 'question:unknown' : `question:${String(callId)}`;
        }
      }
    } catch {
      return undefined;
    }
    // No tool-call block anywhere means the projection uses a shape this build
    // does not know: reporting "answered" would clear a real question, so report
    // "unknown" and let the event-derived set stand.
    if (!sawToolCall) return undefined;
    return open;
  }

  /**
   * Rebuild the attention set from the log.
   *
   * Every snapshot runs this when the log moved, so a dropped resolution event (a
   * gap in the event window) cannot pin "waiting for the human" forever, and a
   * pending-result question cannot be cleared by its own return value.
   */
  function reconcileAttention(state, agent, at) {
    if (agent === null || agent === undefined) return;
    const open = openQuestionFromLog(state.session);
    if (open === undefined) return;
    if (open === null) {
      settleAttention(state, agent, at, 'answered');
      return;
    }
    if (agent.attention.has(open)) return;
    agent.attention.add(open);
    activity(state, agent, 'attention.raised', at);
    change(state, agent, 'waiting-human', 'confirmation_pending', at);
  }

  /** Published sub-agents join the run as worker agents with their own states. */
  function noteChildren(sessionId, children) {
    const state = stateFor(sessionId);
    return (Array.isArray(children) ? children : []).filter(child => child !== null && typeof child === 'object' && child.id !== undefined).map(child => {
      const id = String(child.id);
      const childState = sessions.get(id);
      const childAgent = childState === undefined ? undefined : childState.agents.get(id);
      // A child's raw label can be an assignment title or a filesystem path; it
      // gets the same sanitiser and 12-code-point cap as every other label, or it
      // would escape the contract's `label` budget.
      const label = hudLabel({ assignmentTitle: typeof child.label === 'string' ? child.label : '', role: 'worker' });
      return { id, label, state: childAgent === undefined ? 'running' : childAgent.state };
    });
  }

  /** The contract snapshot for one session. */
  function snapshotFor(sessionId, options2 = {}) {
    const state = sessions.get(String(sessionId));
    const now = Number.isFinite(options2.now) ? options2.now : Date.now();
    const selfId = String(sessionId);
    if (state !== undefined && state.dirty === true && now - (state.lastReconcile ?? 0) >= 300) {
      // Recompute "waiting for the human" from the log before answering, so a
      // missed resolution event cannot leave the field stuck on 等你确认. Capped
      // to a few reads per second: the projection is a full pass over the log.
      const root = state.agents.get(selfId);
      reconcileAttention(state, root, now);
      state.dirty = false;
      state.lastReconcile = now;
    }
    const agents = [];
    if (state !== undefined) {
      for (const agent of state.agents.values()) {
        agents.push({
          id: agent.id,
          label: agent.label,
          role: agent.role,
          parentId: agent.parentId,
          ticketId: agent.ticketId,
          state: agent.state,
          since: agent.since,
          stalled: agent.state === 'running' && now - agent.lastActivity > STALLED_AFTER_MS,
          lastEvent: agent.lastEvent === null
            ? null
            : { kind: agent.lastEvent.kind, at: agent.lastEvent.at, tool: safeTool(agent.lastEvent.tool) },
        });
      }
    }
    // The run always has its own agent, even before the first event: an idle
    // field is still a field (and the labels fixture expects a label for it).
    if (!agents.some(agent => agent.id === selfId)) {
      agents.unshift({
        id: selfId,
        label: hudLabel({ assignmentTitle: state === undefined ? '' : state.taskText, role: 'root' }),
        role: 'root',
        parentId: null,
        ticketId: null,
        state: 'idle',
        since: iso(now),
        stalled: false,
        lastEvent: null,
      });
    }
    for (const child of noteChildren(sessionId, options2.children)) {
      if (agents.some(agent => agent.id === child.id)) continue;
      agents.push({
        id: child.id,
        label: child.label,
        role: 'worker',
        parentId: selfId,
        ticketId: null,
        state: child.state,
        since: iso(now),
        stalled: false,
        lastEvent: null,
      });
    }
    const events = state === undefined ? [] : state.events.map(event => ({ ...event }));
    return {
      v: 1,
      aliasVersion: ALIAS_VERSION,
      seq: state === undefined ? 0 : state.seq,
      now: iso(now),
      stalledAfterMs: STALLED_AFTER_MS,
      eventsFromSeq: events.length > 0 ? events[0].seq : (state === undefined ? 0 : state.seq),
      agents,
      events,
    };
  }

  return {
    sessions,
    observeEvent,
    observeStatus,
    noteChildren,
    snapshotFor,
    taskTextOf(sessionId) {
      const state = sessions.get(String(sessionId));
      return state === undefined ? '' : state.taskText;
    },
    forget(sessionId) {
      sessions.delete(String(sessionId));
    },
  };
}

/**
 * Pass an orchestrator's hud-v1 snapshot through unchanged, or `undefined` when
 * it is absent or malformed. The contract is frozen, so validation is shallow
 * by design — but it does enforce the required envelope.
 */
export function normalizeHudSnapshot(raw, sessionId) {
  if (raw === null || typeof raw !== 'object') return undefined;
  const snapshot = raw.snapshot !== null && typeof raw.snapshot === 'object' ? raw.snapshot : raw;
  if (snapshot.v !== 1) return undefined;
  if (!Array.isArray(snapshot.agents) || !Array.isArray(snapshot.events)) return undefined;
  if (!Number.isFinite(snapshot.seq) || !Number.isFinite(snapshot.aliasVersion)) return undefined;
  return snapshot;
}

/**
 * Try the orchestrator's endpoint. Never throws: a slow, failed, or malformed
 * answer means "fall back to core", which is the documented degradation (§5.3).
 */
export async function fetchHudSnapshot(template, sessionId, options = {}) {
  if (typeof template !== 'string' || template === '') return undefined;
  const url = template.replace('{session}', encodeURIComponent(String(sessionId)));
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return undefined;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 900;
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
  const timer = setTimeout(() => controller?.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller?.signal, headers: { accept: 'application/json' } });
    if (response === undefined || response.ok !== true) return undefined;
    const body = await response.json();
    return normalizeHudSnapshot(body, sessionId);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
