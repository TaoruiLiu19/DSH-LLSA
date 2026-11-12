/**
 * The model — one pure fold from a hud-v1 snapshot to the view the canvas draws.
 *
 * Everything here is deterministic and clock-injected: the browser passes
 * `performance.now()`, tests pass fixed numbers. The model never reads the wall
 * clock, never infers a state from silence, and never parses tool output (§5.5,
 * §5.6). `stalled` is copied from the snapshot — whoever produced it owns that
 * judgement (§2.1).
 *
 * Two entry points, deliberately separate:
 *
 * - {@link foldSnapshot} turns new contract data into state transitions and
 *   pulses. It runs once per poll, never per frame.
 * - {@link stepLifecycle} advances fades and heat from elapsed time. It is
 *   frame-rate driven and touches no contract field.
 *
 * The contract vocabulary this reads is `contracts/hud-v1.schema.json`:
 * `agent.register`, `turn.start`, `tool.start`, `tool.end`, `attention.raised`,
 * `attention.resolved`, `state.changed`, `turn.end`, `agent.cancel`,
 * `agent.recovered`.
 */
import {
  ALIAS_VERSION,
  colorOf,
  isAgentAlias,
  materialForTool,
  materialLabel,
  stateLabel,
  verbFor,
} from './materials.js';

/** Every duration of §4.2 in one place, so the tests can read the contract. */
export const TIMING = Object.freeze({
  /** material: fade in while being touched. */
  materialFadeInMs: 160,
  /** material: idle time before it starts to fade. */
  materialHoldMs: 2400,
  /** material: fade-out constant. */
  materialFadeOutMs: 560,
  /** agent: visibility grace after leaving `running` (the anti-flicker debounce). */
  agentDebounceMs: 420,
  /** agent: fade-out after that grace. */
  agentFadeOutMs: 320,
  /** pulse: at most one per node inside this window. */
  pulseGapMs: 300,
  /** pulse: how long a travelling dot lives. */
  pulseTtlMs: 1600,
});

/** Hard caps: a long session must not grow the view without bound. */
export const CAPS = Object.freeze({ pulses: 32, agents: 12, taskTextChars: 26 });

/** The states a node can hold (§4.1). `idle` means "not drawn". */
const STATES = new Set(['idle', 'running', 'waiting-human', 'done', 'failed']);

/** Terminal states keep their node visible until the next task starts (§4.3). */
const TERMINAL = new Set(['done', 'failed']);

function modelLanguage(locale) {
  return typeof locale === 'string' && /^en\b/i.test(locale) ? 'en' : 'zh';
}

function pick(locale, zh, en) {
  return modelLanguage(locale) === 'en' ? en : zh;
}

function finite(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Contract timestamps are ISO strings; a numeric epoch is tolerated by fixtures. */
function timeOf(at, fallback) {
  if (typeof at === 'number' && Number.isFinite(at)) return at;
  if (typeof at === 'string') {
    const parsed = Date.parse(at);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function normalizeState(state) {
  return STATES.has(state) ? state : 'idle';
}

/** A blank view for one session. */
export function createView(options = {}) {
  const now = finite(options.now, 0);
  return {
    sessionId: typeof options.sessionId === 'string' ? options.sessionId : null,
    locale: typeof options.locale === 'string' ? options.locale : 'zh',
    source: 'none',
    /** last contract sequence seen by the snapshot, and the last one applied. */
    seq: 0,
    cursor: 0,
    aliasVersion: 0,
    aliasOk: false,
    /** set when a fold had to skip animation because the window had a hole. */
    gap: false,
    stalled: false,
    pending: false,
    state: 'idle',
    taskId: null,
    taskText: '',
    endedAt: 0,
    frameAt: now,
    /** last material that failed, used for the 「卡在哪」 line. */
    failedMaterial: null,
    materials: new Map(),
    agents: new Map(),
    pulses: [],
  };
}

/** Reset in place, so a session switch cannot leak the previous session's field. */
export function resetView(view, options = {}) {
  const fresh = createView({ ...options, now: finite(options.now, view.frameAt) });
  for (const key of Object.keys(fresh)) {
    if (key === 'materials' || key === 'agents') continue;
    view[key] = fresh[key];
  }
  view.materials = fresh.materials;
  view.agents = fresh.agents;
  view.pulses = [];
  return view;
}

function ensureMaterial(view, id, alias) {
  let node = view.materials.get(id);
  if (node === undefined) {
    node = {
      id,
      label: materialLabel(id, view.locale),
      alias: alias ?? null,
      state: 'idle',
      verb: '',
      lastAt: 0,
      hits: 0,
      alpha: 0,
      heat: 0,
      lastPulseAt: -Infinity,
      phase: (view.materials.size * 1.7) % 6.283,
    };
    view.materials.set(id, node);
  }
  node.label = materialLabel(id, view.locale);
  if (alias !== null && alias !== undefined) node.alias = alias;
  return node;
}

function ensureAgent(view, id, label, role) {
  const key = String(id ?? '');
  let node = view.agents.get(key);
  if (node === undefined) {
    node = {
      id: key,
      label: typeof label === 'string' ? label : '',
      role: typeof role === 'string' ? role : 'worker',
      parentId: null,
      state: 'idle',
      stalled: false,
      sinceAt: 0,
      lastAt: 0,
      alpha: 0,
      heat: 0,
      phase: (view.agents.size * 2.1) % 6.283,
    };
    view.agents.set(key, node);
  }
  if (typeof label === 'string' && label !== '') node.label = label;
  if (typeof role === 'string' && role !== '') node.role = role;
  return node;
}

/** Start a new task: release every node and reset the conclusion. */
function startTask(view, { at, taskId, text }) {
  view.taskId = taskId;
  view.state = 'running';
  view.pending = false;
  view.failedMaterial = null;
  view.endedAt = 0;
  if (typeof text === 'string' && text.trim() !== '') view.taskText = text.trim();
  // A new command starts a new field: the previous task's materials release
  // their pins and fade out naturally instead of leaking into this one.
  for (const node of view.materials.values()) node.state = 'idle';
  for (const node of view.agents.values()) {
    if (node.state === 'waiting-human' || TERMINAL.has(node.state)) {
      node.state = 'running';
      node.lastAt = at;
    }
  }
}

function applyEvent(view, event, options) {
  const rawTime = timeOf(event.at, NaN);
  // Contract timestamps are absolute while the frame clock is local, so every
  // event is rebased onto the caller's clock through the snapshot's `now`.
  const at = Number.isFinite(rawTime) ? rawTime + options.skew : options.now;
  const animate = options.animate === true;
  const agentId = typeof event.agentId === 'string' ? event.agentId : '';
  switch (event.kind) {
    case 'agent.register': {
      const agent = ensureAgent(view, agentId, event.label);
      agent.state = 'idle';
      agent.lastAt = at;
      break;
    }
    case 'turn.start': {
      startTask(view, { at, taskId: `t${finite(event.seq, view.cursor)}` });
      if (agentId !== '') {
        const agent = ensureAgent(view, agentId);
        agent.state = 'running';
        agent.lastAt = at;
      }
      break;
    }
    case 'tool.start': {
      const resolved = materialForTool(event.tool, { aliasVersion: view.aliasVersion });
      if (resolved.material === null) {
        // A delegation lights a seat in the inner ring; an ask lights nothing —
        // it stops the field instead, and its pose comes from the state event.
        if (isAgentAlias(resolved.alias) && agentId !== '') {
          const seat = ensureAgent(view, agentId);
          seat.lastAt = at;
          seat.heat = Math.min(1, seat.heat + 0.5);
          if (animate) view.pulses.push({ to: null, agentId, at, intent: 'dispatch' });
        }
        break;
      }
      const node = ensureMaterial(view, resolved.material, resolved.alias);
      node.state = 'running';
      node.alias = resolved.alias;
      node.verb = verbFor(resolved.alias, view.locale);
      node.lastAt = at;
      node.hits += 1;
      node.heat = Math.min(1, node.heat + 0.6);
      if (animate && at - node.lastPulseAt >= TIMING.pulseGapMs) {
        node.lastPulseAt = at;
        view.pulses.push({ to: node.id, agentId: agentId === '' ? null : agentId, at, intent: resolved.alias });
      }
      break;
    }
    case 'tool.end': {
      const resolved = materialForTool(event.tool, { aliasVersion: view.aliasVersion });
      if (resolved.material === null) break;
      const node = view.materials.get(resolved.material);
      if (node === undefined) break;
      // A synthetic/interrupted close still ends the call: the run's own state
      // (cancel/restart) carries the meaning, not a red ring.
      node.state = 'done';
      node.lastAt = at;
      if (event.reason === 'interrupted') node.interrupted = true;
      break;
    }
    case 'attention.raised':
      // attention.* says only "something changed"; the state itself comes from
      // the following `state.changed`, never from an event count (§4.6).
      view.pending = true;
      break;
    case 'attention.resolved':
      view.pending = false;
      break;
    case 'state.changed': {
      const next = normalizeState(event.to);
      const previous = normalizeState(event.from);
      if (agentId !== '') {
        const agent = ensureAgent(view, agentId);
        if (agent.state !== next) {
          agent.state = next;
          agent.lastAt = at;
        }
      }
      if (next === 'waiting-human') view.pending = true;
      else if (previous === 'waiting-human') view.pending = false;
      if (TERMINAL.has(next)) {
        view.state = next;
        view.endedAt = at;
      }
      break;
    }
    case 'turn.end':
      // The authoritative state arrives as `state.changed`; `turn.end` only
      // records the reason. Nothing to draw here.
      break;
    default:
      break;
  }
}

/** Server-declared agent data is authoritative and always applied. */
function syncAgents(view, snapshot, now) {
  const agents = Array.isArray(snapshot.agents) ? snapshot.agents : [];
  for (const agent of agents) {
    if (agent === null || typeof agent !== 'object' || agent.id === undefined) continue;
    const node = ensureAgent(view, String(agent.id), agent.label, agent.role);
    if (agent.parentId !== undefined) node.parentId = agent.parentId === null ? null : String(agent.parentId);
    node.stalled = agent.stalled === true;
    const next = normalizeState(agent.state);
    if (node.state !== next) {
      node.state = next;
      node.lastAt = now;
    } else if (next === 'running') {
      node.lastAt = now;
    } else if (node.lastAt === 0) {
      node.lastAt = now;
    }
  }
}

/**
 * The field's state, aggregated from the agents the snapshot declares (§4.2).
 *
 * A run may report the root agent, one worker, or several workers; any pending
 * human question outranks activity, and a failure outranks a completion.
 */
export function aggregateState(agents) {
  let waiting = false;
  let running = false;
  let failed = false;
  let done = false;
  let any = false;
  for (const node of agents.values()) {
    any = true;
    if (node.state === 'waiting-human') waiting = true;
    else if (node.state === 'running') running = true;
    else if (node.state === 'failed') failed = true;
    else if (node.state === 'done') done = true;
  }
  if (!any) return 'idle';
  if (waiting) return 'waiting-human';
  if (running) return 'running';
  if (failed) return 'failed';
  if (done) return 'done';
  return 'idle';
}

/**
 * Fold one snapshot into the view.
 *
 * The gap rule of §2.1 lives here: when `eventsFromSeq` is past our cursor + 1
 * the window lost events, so states are synced and animation is skipped.
 *
 * @param meta.sessionId - the session this snapshot belongs to (the contract's
 *   snapshot carries no id; the caller knows it).
 * @param meta.taskText - optional command text for the centre line (degraded
 *   source only; the contract has no field for it).
 * @returns the same view object (mutated), for cheap frame-loop use.
 */
export function foldSnapshot(view, snapshot, now = view.frameAt, meta = {}) {
  if (snapshot === null || typeof snapshot !== 'object') return view;
  const sessionId = typeof meta.sessionId === 'string' ? meta.sessionId : view.sessionId;
  if (sessionId !== view.sessionId) resetView(view, { sessionId, now, locale: view.locale });
  if (typeof meta.taskText === 'string' && meta.taskText.trim() !== '') view.taskText = meta.taskText.trim();
  if (typeof meta.source === 'string') view.source = meta.source;

  view.aliasVersion = finite(snapshot.aliasVersion, view.aliasVersion);
  view.aliasOk = view.aliasVersion === ALIAS_VERSION;
  // Read-only: the producer stamps stalled on each agent (§2.1). The field
  // reports it, and nothing here ever recomputes it from elapsed time.
  view.seq = Math.max(view.seq, finite(snapshot.seq, 0));

  const events = Array.isArray(snapshot.events) ? snapshot.events : [];
  const fresh = events
    .filter(event => event !== null && typeof event === 'object' && Number.isFinite(event.seq) && event.seq > view.cursor)
    .sort((left, right) => left.seq - right.seq);
  const windowStart = finite(snapshot.eventsFromSeq, fresh.length > 0 ? fresh[0].seq : view.cursor + 1);
  const gap = fresh.length > 0 && windowStart > view.cursor + 1;
  view.gap = gap;

  // Rebase: the snapshot's own `now` maps contract time onto the caller's clock,
  // so a fade started by an ISO event timestamp still decays on `performance.now()`.
  const snapshotNow = typeof snapshot.now === 'string' ? Date.parse(snapshot.now) : NaN;
  const skew = Number.isFinite(snapshotNow) ? now - snapshotNow : 0;

  for (const event of fresh) applyEvent(view, event, { animate: !gap, now, skew });

  if (fresh.length > 0) view.cursor = Math.max(view.cursor, fresh[fresh.length - 1].seq);
  else if (view.seq > view.cursor) view.cursor = view.seq;

  syncAgents(view, snapshot, now);
  view.pending = view.pending || [...view.agents.values()].some(node => node.state === 'waiting-human');
  view.stalled = [...view.agents.values()].some(node => node.stalled === true);

  const aggregate = aggregateState(view.agents);
  if (view.pending) {
    view.state = 'waiting-human';
  } else if (aggregate !== 'idle') {
    view.state = aggregate;
  } else if (!TERMINAL.has(view.state)) {
    // Everything settled to idle (a cancel, a restart): the field lets go. A
    // terminal conclusion, by contrast, stays until the next task (§4.3).
    view.state = 'idle';
  }
  if (view.state === 'idle') view.taskId = null;
  else if (view.taskId === null) view.taskId = `s${view.cursor}`;

  if (view.pulses.length > CAPS.pulses) view.pulses = view.pulses.slice(-CAPS.pulses);
  return view;
}

/** Advance fades and heat from elapsed time. Called once per animation frame. */
export function stepLifecycle(view, now) {
  const dt = Math.min(Math.max(now - view.frameAt, 0), 48);
  view.frameAt = now;

  for (const node of view.materials.values()) {
    const pinned = node.state === 'waiting-human' || node.state === 'failed';
    const holding = now - node.lastAt < TIMING.materialHoldMs;
    const target = pinned || node.state === 'running' || holding ? 1 : 0;
    const tau = target > node.alpha ? TIMING.materialFadeInMs : TIMING.materialFadeOutMs;
    node.alpha += (target - node.alpha) * Math.min(1, dt / Math.max(tau, 1));
    node.heat = Math.max(0, node.heat - dt / 520);
    if (node.alpha < 0.004) node.alpha = 0;
  }

  for (const node of view.agents.values()) {
    const pinned = node.state === 'waiting-human' || node.state === 'failed';
    const working = node.state === 'running';
    const inGrace = now - node.lastAt < TIMING.agentDebounceMs;
    const target = pinned || working || inGrace ? 1 : 0;
    const tau = target > node.alpha ? TIMING.materialFadeInMs : TIMING.agentFadeOutMs;
    node.alpha += (target - node.alpha) * Math.min(1, dt / Math.max(tau, 1));
    node.heat = Math.max(0, node.heat - dt / 600);
    if (node.alpha < 0.004) node.alpha = 0;
  }

  if (view.pulses.length > 0) {
    view.pulses = view.pulses.filter(pulse => now - pulse.at < TIMING.pulseTtlMs);
    if (view.pulses.length > CAPS.pulses) view.pulses = view.pulses.slice(-CAPS.pulses);
  }

  if (view.agents.size > CAPS.agents) {
    const retired = [...view.agents.values()]
      .filter(node => node.alpha === 0 && node.state !== 'running' && node.state !== 'waiting-human' && node.state !== 'failed')
      .sort((left, right) => left.lastAt - right.lastAt)
      .slice(0, view.agents.size - CAPS.agents);
    for (const node of retired) view.agents.delete(node.id);
  }
  return view;
}

/** First sentence / first line of the user's command, shortened for the centre. */
export function shortenTask(text) {
  if (typeof text !== 'string') return '';
  const line = text.replace(/\s+/g, ' ').trim();
  if (line === '') return '';
  const cut = line.search(/[。！？!?；;\n]/);
  const sentence = cut > 0 ? line.slice(0, cut) : line;
  if (sentence.length <= CAPS.taskTextChars) return sentence;
  return `${sentence.slice(0, CAPS.taskTextChars - 1)}…`;
}

/** The busiest material currently being used, for the running sub-line. */
function busiestMaterial(view) {
  let best = null;
  for (const node of view.materials.values()) {
    if (node.state !== 'running' && node.state !== 'waiting-human' && node.state !== 'failed') continue;
    if (best === null || node.lastAt > best.lastAt) best = node;
  }
  return best;
}

/** The label of the one agent that owns the field, if there is exactly one. */
/** A label is display text; a bare role name is not a task name. */
function usableLabel(node) {
  const label = typeof node.label === 'string' ? node.label.trim() : '';
  if (label === '') return '';
  const role = typeof node.role === 'string' ? node.role.trim() : '';
  if (role !== '' && label === role) return '';
  if (label === 'root' || label === 'worker' || label === '智能体') return '';
  return label;
}

export function primaryLabel(view) {
  const nodes = [...view.agents.values()];
  if (nodes.length === 1) return usableLabel(nodes[0]);
  if (nodes.length === 0) return '';
  const root = nodes.find(node => node.role === 'root' || node.parentId === null);
  return root === undefined ? '' : usableLabel(root);
}

/**
 * The centre block of §4.3 — the only place that decides what the centre says.
 * Pure: the renderer draws exactly this.
 */
export function centerText(view) {
  const locale = view.locale;
  switch (view.state) {
    case 'running': {
      const main = shortenTask(view.taskText) || primaryLabel(view) || pick(locale, '执行中', 'Working');
      const busiest = busiestMaterial(view);
      const workingAgents = [...view.agents.values()].filter(node => node.state === 'running').length;
      let sub;
      if (busiest !== null) {
        sub = pick(locale, `正在${busiest.verb || '处理'} · ${busiest.label}`, `${busiest.verb || 'Working'} · ${busiest.label}`);
      } else if (workingAgents > 0) {
        sub = view.agents.size > 1
          ? pick(locale, `${workingAgents} 个子 Agent 在跑`, `${workingAgents} sub-agents working`)
          : pick(locale, '准备中', 'Getting ready');
      } else {
        sub = pick(locale, '准备中', 'Getting ready');
      }
      // The producer stamps `stalled` per agent; the field only reports it.
      if (view.stalled) {
        sub = busiest === null
          ? pick(locale, '停顿中 · 等待响应', 'Stalled · waiting for a response')
          : pick(locale, `停顿中 · ${busiest.label}`, `Stalled · ${busiest.label}`);
      }
      return { main, sub, tone: 'running' };
    }
    case 'waiting-human':
      return {
        main: stateLabel('waiting-human', locale),
        sub: pick(locale, '需要你做一个选择', 'One choice needed'),
        tone: 'waiting-human',
      };
    case 'done': {
      const count = [...view.materials.values()].filter(node => node.state === 'done').length;
      return {
        main: 'SUCCESS',
        sub: pick(locale, `成功 · ${count} 个材料`, `Success · ${count} material${count === 1 ? '' : 's'}`),
        tone: 'done',
      };
    }
    case 'failed': {
      const node = view.failedMaterial === null ? null : view.materials.get(view.failedMaterial);
      const label = node === undefined || node === null ? pick(locale, '执行', 'the run') : node.label;
      const kept = [...view.materials.values()].some(other => other.state === 'done');
      return {
        main: 'FAIL',
        sub: kept
          ? pick(locale, `在「${label}」这一步失败 · 前面的结果已保留`, `Failed at “${label}” · earlier results are kept`)
          : pick(locale, `在「${label}」这一步失败 · 没有产生结果`, `Failed at “${label}” · nothing was produced`),
        tone: 'failed',
      };
    }
    default:
      return { main: stateLabel('idle', locale), sub: '', tone: 'idle' };
  }
}

/**
 * Whether the focus layer should be open, and why.
 *
 * Rules of §4.4/§4.6 as one pure transition:
 * - a new task opens focus;
 * - `waiting-human` closes it (the question belongs in the message flow);
 * - answering reopens it;
 * - a terminal state never closes it — the user leaves when they decide;
 * - an explicit dismissal holds for that task only.
 *
 * @param focus - `{ taskId, active, dismissedTaskId, state }` from the previous call.
 */
export function nextFocus(focus, view) {
  const taskId = view.taskId;
  const state = view.state;
  if (taskId === null || state === 'idle') {
    return { taskId, active: false, dismissedTaskId: focus.dismissedTaskId, state, reason: 'idle' };
  }
  if (taskId !== focus.taskId) {
    // A task first seen while it already waits for an answer still opens: the
    // question belongs to that task, and the field must not go blank behind it.
    return { taskId, active: state === 'running' || state === 'waiting-human', dismissedTaskId: null, state, reason: 'new-task' };
  }
  if (state === 'waiting-human') {
    // A question keeps the field. The ask surface renders above the overlay, so
    // the run stays visible behind it instead of the blur dropping away (§4.6,
    // revised at the product owner's request).
    return { taskId, active: focus.active, dismissedTaskId: focus.dismissedTaskId, state, reason: 'ask' };
  }
  if (focus.state === 'waiting-human' && state !== 'waiting-human') {
    // the question was answered: come back to the field
    return { taskId, active: true, dismissedTaskId: null, state, reason: 'answered' };
  }
  if (TERMINAL.has(state)) {
    return { taskId, active: focus.active, dismissedTaskId: focus.dismissedTaskId, state, reason: 'terminal' };
  }
  if (focus.dismissedTaskId === taskId) {
    return { taskId, active: false, dismissedTaskId: focus.dismissedTaskId, state, reason: 'dismissed' };
  }
  return { taskId, active: focus.active || state === 'running', dismissedTaskId: focus.dismissedTaskId, state, reason: 'same-task' };
}

/** Capsule text + colour: the state the field is in while it is closed (§4.4). */
export function capsuleOf(view) {
  const state = view.state === 'idle' ? 'running' : view.state;
  return { label: stateLabel(state, view.locale), color: colorOf(state), state };
}

/** Colour of one material node, respecting the state mapping and alias degradation. */
export function materialColor(node) {
  return colorOf(node.state);
}
