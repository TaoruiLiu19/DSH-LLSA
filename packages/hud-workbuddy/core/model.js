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
  supportsAliasVersion,
  LINKS,
  codeLanguageLabel,
  colorOf,
  isAgentAlias,
  isPlanAlias,
  isShellAlias,
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
  /** pulse: how far a dot actually travels before it is done (§3: 720ms of flight). */
  pulseFlightMs: 720,
  /** link: one declared co-activation keeps its arc for this long (§3.3). */
  linkTtlMs: 1200,
  /** link: the fast rise of that arc. */
  linkRiseMs: 120,
  /** code seat: an execution must last this long before it is shown (§6.4). */
  minExecMs: 400,
  /** plan: how long 「计划中」 outlives the last bookkeeping call (§5). */
  planHoldMs: 2400,
  /** material: one settle ripple on `running -> done` (§6.2). */
  rippleMs: 400,
});

/** Hard caps: a long session must not grow the view without bound. */
export const CAPS = Object.freeze({ pulses: 32, links: 4, agents: 12 });

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

/** The producer's per-event material override (§7.2), or the alias default. */
function overrideMaterial(options, seq, fallback) {
  const table = options.materials;
  if (table === null || table === undefined) return fallback;
  const value = table[String(seq)];
  return typeof value === 'string' ? value : fallback;
}

/**
 * Close a classified code execution (§6.4).
 *
 * The code seat settles together with the terminal, and the arc dies with the
 * call — it is an event window, never a standing relationship (§3.2).
 */
function finishExec(view, at) {
  if (view.codeExec.active && view.codeExec.promoted) {
    const code = view.materials.get('code');
    if (code !== undefined) {
      code.state = 'done';
      code.lastAt = at;
      code.doneAt = at;
      code.executing = false;
    }
  }
  view.codeExec = { at: 0, active: false, promoted: false, lang: null };
  view.links = [];
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
    /** §3: arcs for declared co-activations, alive for `linkTtlMs`. */
    links: [],
    /** §5 halo: the centre's presence, 0..1, follows the run and not the nodes. */
    heart: 0,
    /** §5: bookkeeping tools draw no node; the centre says 「计划中」 for a while. */
    plan: { at: -Infinity, active: false },
    /** §6.4: a shell call declared to run code promotes the code seat after `minExecMs`. */
    codeExec: { at: 0, active: false, promoted: false, lang: null },
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
      /** §2.4: the declared language of the code seat, when one is known. */
      language: null,
      alias: alias ?? null,
      state: 'idle',
      verb: '',
      lastAt: 0,
      /** when the last `tool.end` landed; the settle ripple counts from here (§6.2) */
      doneAt: 0,
      /** true while this seat is carrying a declared code execution (§3) */
      executing: false,
      hits: 0,
      alpha: 0,
      heat: 0,
      lastPulseAt: -Infinity,
      phase: (view.materials.size * 1.7) % 6.283,
    };
    view.materials.set(id, node);
  }
  // A language label survives later touches; a locale switch still re-renders it.
  node.label = id === 'code' && node.language !== null
    ? codeLanguageLabel(node.language, view.locale)
    : materialLabel(id, view.locale);
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
        if (isPlanAlias(resolved.alias)) {
          // Bookkeeping is not a material (§2.2): no node, the centre says 计划中.
          view.plan = { at, active: true };
        } else if (isAgentAlias(resolved.alias) && agentId !== '') {
          // A delegation lights a seat in the inner ring; an ask lights nothing —
          // it stops the field instead, and its pose comes from the state event.
          const seat = ensureAgent(view, agentId);
          seat.lastAt = at;
          seat.heat = Math.min(1, seat.heat + 0.5);
          if (animate) view.pulses.push({ to: null, agentId, at, intent: 'dispatch' });
        }
        break;
      }
      // §2.3: the producer may re-route a file call to the code seat by extension.
      const materialId = overrideMaterial(options, event.seq, resolved.material);
      const node = ensureMaterial(view, materialId, resolved.alias);
      node.state = 'running';
      node.alias = resolved.alias;
      node.verb = verbFor(materialId, resolved.alias, view.locale);
      node.lastAt = at;
      node.hits += 1;
      node.heat = Math.min(1, node.heat + 0.6);
      node.doneAt = 0;
      if (animate && at - node.lastPulseAt >= TIMING.pulseGapMs) {
        node.lastPulseAt = at;
        view.pulses.push({ to: node.id, agentId: agentId === '' ? null : agentId, at, intent: resolved.alias });
      }
      // §6.4: a terminal call that the producer classified as "executing code"
      // arms the code seat. It only lights after `minExecMs` (see stepLifecycle),
      // so a 200ms probe never flashes.
      if (resolved.material === 'shell' && typeof options.exec === 'string' && options.exec !== '') {
        view.codeExec = { at, active: true, promoted: false, lang: options.exec };
      }
      break;
    }
    case 'tool.end': {
      const resolved = materialForTool(event.tool, { aliasVersion: view.aliasVersion });
      if (resolved.material === null) {
        if (isPlanAlias(resolved.alias)) view.plan = { at: view.plan.at, active: false };
        break;
      }
      const materialId = overrideMaterial(options, event.seq, resolved.material);
      const node = view.materials.get(materialId);
      if (node !== undefined) {
        // A synthetic/interrupted close still ends the call: the run's own state
        // (cancel/restart) carries the meaning, not a red ring.
        node.state = 'done';
        node.lastAt = at;
        node.doneAt = at;
        node.executing = false;
        if (event.reason === 'interrupted') node.interrupted = true;
      }
      if (resolved.material === 'shell') finishExec(view, at);
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
  const seen = new Set();
  for (const agent of agents) {
    if (agent === null || typeof agent !== 'object' || agent.id === undefined) continue;
    seen.add(String(agent.id));
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
  // The snapshot is the whole truth about who is in the run: a retired child that
  // is gone from it must stop holding the field in `running` forever.
  for (const id of [...view.agents.keys()]) {
    if (!seen.has(id)) view.agents.delete(id);
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
  view.aliasOk = supportsAliasVersion(view.aliasVersion);
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

  // §7.2: the producer may re-route one call's material by file extension; the
  // table is keyed by event seq and carries only the entries that differ.
  const overrides = meta.materials !== null && typeof meta.materials === 'object' ? meta.materials : null;
  const exec = typeof meta.exec === 'string' && meta.exec !== '' ? meta.exec : null;

  for (const event of fresh) applyEvent(view, event, { animate: !gap, now, skew, materials: overrides, exec });

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

  // §5 halo: the centre stays alive while the run does — that is what fills the
  // field when nothing is lit (思考中 / 计划中). A conclusion hands the middle
  // over to the 52k ring, so the presence fades out instead of lingering.
  const heartTarget = view.state === 'running' ? 1 : 0;
  view.heart += (heartTarget - view.heart) * Math.min(1, dt / 320);

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

  // §6.4: the code seat is promoted only once the execution has lasted long
  // enough that showing it is not a flash. A command shorter than `minExecMs`
  // therefore leaves the field untouched.
  const exec = view.codeExec;
  if (exec.active && exec.promoted !== true && now - exec.at >= TIMING.minExecMs) {
    exec.promoted = true;
    const code = ensureMaterial(view, 'code', 'run_code');
    if (typeof exec.lang === 'string' && exec.lang !== '') {
      // §2.4: the seat names the language while it is executing that language.
      code.language = exec.lang;
      code.label = codeLanguageLabel(exec.lang, view.locale);
    }
    code.state = 'running';
    code.alias = 'run_code';
    code.verb = verbFor('code', 'run_code', view.locale);
    // +1ms so the centre names the *subject* (「执行中 / Python」), not the
    // transport, when both seats carry the same timestamp.
    code.lastAt = now + 1;
    code.doneAt = 0;
    code.executing = true;
    code.hits += 1;
    code.heat = Math.min(1, code.heat + 0.5);
    if (now - code.lastPulseAt >= TIMING.pulseGapMs) {
      code.lastPulseAt = now;
      view.pulses.push({ to: 'code', agentId: null, at: now, intent: 'run_code' });
    }
    // §3: the arc lives in an event window, not in the nodes' visibility. The
    // pair itself comes from the table, so a second link needs no new code here.
    const link = LINKS[0];
    view.links.push({ a: link.a, b: link.b, at: now });
  }

  if (view.links.length > 0) {
    view.links = view.links.filter(link => now - link.at < TIMING.linkTtlMs);
    if (view.links.length > CAPS.links) view.links = view.links.slice(-CAPS.links);
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

/**
 * The busiest material currently being used, for the centre's object line.
 *
 * A declared code execution outranks its transport: when the terminal is running
 * the code seat, the centre should name the subject (「执行中 / Python」) rather
 * than the shell.
 */
function busiestMaterial(view) {
  let best = null;
  for (const node of view.materials.values()) {
    if (node.state !== 'running' && node.state !== 'waiting-human' && node.state !== 'failed') continue;
    if (node.executing === true) return node;
    if (best === null || node.lastAt > best.lastAt) best = node;
  }
  return best;
}

/** True while a bookkeeping call is recent enough for the centre to say 计划中. */
function isPlanning(view) {
  if (view.plan === undefined) return false;
  if (view.plan.active === true) return true;
  return view.frameAt - view.plan.at < TIMING.planHoldMs;
}

/**
 * The centre block of §5 — the only place that decides what the centre says.
 *
 * One state word and one object. The task name is deliberately absent (§5.4):
 * a command almost never fits, so the centre stopped repeating it.
 * Pure: the renderer draws exactly this.
 */
export function centerText(view) {
  const locale = view.locale;
  switch (view.state) {
    case 'running': {
      const busiest = busiestMaterial(view);
      // The producer stamps `stalled` per agent; the field only reports it.
      if (view.stalled) {
        return {
          main: pick(locale, '停顿中', 'Stalled'),
          sub: busiest === null ? pick(locale, '等待响应', 'Waiting for a response') : busiest.label,
          tone: 'running',
        };
      }
      if (busiest !== null) {
        return { main: stateLabel('running', locale), sub: busiest.label, tone: 'running' };
      }
      if (isPlanning(view)) {
        return { main: pick(locale, '计划中', 'Planning'), sub: '', tone: 'running' };
      }
      // Nothing is being touched: the model is generating, not preparing.
      return { main: pick(locale, '思考中', 'Thinking'), sub: '', tone: 'running' };
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
        main: stateLabel('done', locale),
        sub: pick(locale, `用了 ${count} 个材料`, `${count} material${count === 1 ? '' : 's'} used`),
        tone: 'done',
      };
    }
    case 'failed': {
      // §5 material-level failure is not observable, so the line never claims to
      // know which step broke; it only reports what survived.
      const kept = [...view.materials.values()].some(other => other.state === 'done');
      return {
        main: stateLabel('failed', locale),
        sub: kept
          ? pick(locale, '前面的结果已保留', 'Earlier results are kept')
          : pick(locale, '没有产生结果', 'Nothing was produced'),
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

/**
 * How many failed polls a *fresh* page tolerates before it calls itself offline.
 *
 * A restart brings the page up before the Host half has registered its route, so
 * the first polls can fail on a perfectly healthy install. "Not yet connected" and
 * "lost the connection" are different states; only the second one is worth a pill.
 */
export const OFFLINE_AFTER_ATTEMPTS = 3;

/** A fresh page also gets this long, in wall-clock time, before it says "offline". */
export const OFFLINE_AFTER_MS = 2500;

/**
 * Next connection state.
 *
 * - `null` — still trying, nothing has failed for long enough to matter;
 * - `true` — the last poll answered;
 * - `false` — the connection is genuinely down.
 *
 * Once a page has been online, a single failure is reported immediately. Before
 * that, both a run of failures and a minimum wall-clock window must pass, so a
 * slow boot never paints an outage.
 */
export function nextOnline(previous, outcome, now = 0) {
  const attempts = Number.isFinite(previous?.attempts) ? previous.attempts : 0;
  const everOnline = previous?.everOnline === true;
  if (outcome === 'ok') return { online: true, attempts: 0, everOnline: true, since: 0 };
  const failed = attempts + 1;
  const since = Number.isFinite(previous?.since) && previous.since > 0 ? previous.since : now;
  const waited = now === 0 ? true : now - since >= OFFLINE_AFTER_MS;
  if (everOnline || (failed >= OFFLINE_AFTER_ATTEMPTS && waited)) {
    return { online: false, attempts: failed, everOnline, since };
  }
  return { online: null, attempts: failed, everOnline, since };
}

/** The pill is for a lost connection, never for a page that is still connecting. */
export function shouldShowOffline(sessionId, online) {
  return sessionId !== null && online === false;
}

/**
 * Whether a snapshot answer belongs to a session the page already left.
 *
 * Switching from A to B while A's request is in flight would otherwise paint A's
 * run over B; the answer is dropped instead of folded.
 */
export function isStaleAnswer(requested, current, answered) {
  if (requested !== current) return true;
  if (answered === undefined || answered === null) return false;
  return String(answered) !== String(requested);
}

/**
 * Whether the field may show at all.
 *
 * Two independent switches: the plugin's `focusMode` setting (on by default, so a
 * missing value still shows the field) and a session-local override from the
 * keyboard shortcut, which never touches the saved configuration.
 */
export function focusGate(configFocusMode, manualOff) {
  return configFocusMode !== false && manualOff !== true;
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
