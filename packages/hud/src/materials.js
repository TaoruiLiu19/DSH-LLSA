/**
 * Materials — the user-facing vocabulary of the HUD.
 *
 * The mapping chain is fixed by the contract (施工文档 §4.7, §2.2):
 *
 *     native tool id -> (contracts/tool-aliases-v{version}.json) alias -> (this table) material
 *
 * Three properties matter and are easy to lose:
 *
 * 1. An unknown tool, or a snapshot whose `aliasVersion` this build does not
 *    ship, becomes 「其它」. It never hides the node: state and colour keep
 *    working, only the label degrades.
 * 2. Aliases are the contract; materials are OURS.
 * 3. Three alias groups draw nothing at all: orchestration (it lights an agent
 *    seat instead), the human question, and the plan group (todo/goal/schedule —
 *    bookkeeping is not a material, §2.2 of the v0.4 spec).
 *
 * 规格：`HUD-设计规格-v0.4-待实现.md`
 */

/** The alias table emitted by the standalone HUD collector. */
export const ALIAS_VERSION = 1;

/**
 * `contracts/tool-aliases-v1.json`, verbatim. In v1 every native id maps to
 * itself; the table still decides membership, so an absent tool is 「其它」 even
 * though the mapping looks like the tool's own name.
 */
export const ALIASES = Object.freeze({
  apply_patch: 'apply_patch',
  ask_user_question: 'ask_user_question',
  bash: 'bash',
  collab_accept: 'collab_accept',
  collab_complete_computation: 'collab_complete_computation',
  collab_compute: 'collab_compute',
  collab_delegate: 'collab_delegate',
  collab_delegate_task: 'collab_delegate_task',
  collab_history: 'collab_history',
  collab_project_log: 'collab_project_log',
  collab_publish: 'collab_publish',
  collab_read_evidence: 'collab_read_evidence',
  collab_send: 'collab_send',
  collab_status: 'collab_status',
  cordis_inspect_list: 'cordis_inspect_list',
  cordis_inspect_query: 'cordis_inspect_query',
  create_goal: 'create_goal',
  edit: 'edit',
  get_goal: 'get_goal',
  glob: 'glob',
  grep: 'grep',
  interrupt_agent: 'interrupt_agent',
  job_kill: 'job_kill',
  job_list: 'job_list',
  job_output: 'job_output',
  list_agents: 'list_agents',
  list_subagent_models: 'list_subagent_models',
  load_workspace_dependencies: 'load_workspace_dependencies',
  orchestrator_ack: 'orchestrator_ack',
  orchestrator_collab_finish: 'orchestrator_collab_finish',
  orchestrator_collab_review: 'orchestrator_collab_review',
  orchestrator_eval: 'orchestrator_eval',
  orchestrator_eval_decide: 'orchestrator_eval_decide',
  orchestrator_eval_read: 'orchestrator_eval_read',
  orchestrator_policy_sync: 'orchestrator_policy_sync',
  orchestrator_prompts_save: 'orchestrator_prompts_save',
  orchestrator_read: 'orchestrator_read',
  orchestrator_reply: 'orchestrator_reply',
  orchestrator_report: 'orchestrator_report',
  orchestrator_route: 'orchestrator_route',
  orchestrator_settings_save: 'orchestrator_settings_save',
  orchestrator_thread_follow: 'orchestrator_thread_follow',
  orchestrator_thread_unrelated: 'orchestrator_thread_unrelated',
  orchestrator_thread_unsubscribe: 'orchestrator_thread_unsubscribe',
  orchestrator_ticket_note: 'orchestrator_ticket_note',
  orchestrator_ticket_request_status: 'orchestrator_ticket_request_status',
  orchestrator_ticket_retry: 'orchestrator_ticket_retry',
  orchestrator_trigger_handback: 'orchestrator_trigger_handback',
  orchestrator_trigger_requeue: 'orchestrator_trigger_requeue',
  present: 'present',
  pwsh: 'pwsh',
  ralph: 'ralph',
  read: 'read',
  read_image: 'read_image',
  run_code: 'run_code',
  schedule_create: 'schedule_create',
  schedule_edit: 'schedule_edit',
  schedule_list: 'schedule_list',
  schedule_view: 'schedule_view',
  send_message: 'send_message',
  session_event_read: 'session_event_read',
  session_event_search: 'session_event_search',
  session_event_trace: 'session_event_trace',
  session_search: 'session_search',
  session_trace: 'session_trace',
  skill: 'skill',
  str_replace_editor: 'str_replace_editor',
  subagent: 'subagent',
  terminal_close: 'terminal_close',
  terminal_list: 'terminal_list',
  terminal_open: 'terminal_open',
  terminal_read: 'terminal_read',
  terminal_send: 'terminal_send',
  terminal_signal: 'terminal_signal',
  todo_write: 'todo_write',
  update_goal: 'update_goal',
  web_fetch: 'web_fetch',
  web_search: 'web_search',
  workflow: 'workflow',
  working_directory: 'working_directory',
  write: 'write',
});
const aliasTables = new Map([
  [ALIAS_VERSION, ALIASES],
  [2, Object.freeze({ ...ALIASES, collab_csv_workflow: 'collab_csv_workflow' })],
]);

export function supportsAliasVersion(version) {
  return aliasTables.has(version);
}

/**
 * Which alias belongs to which material. `null`-producing groups live below.
 *
 * `code` is the language seat: `run_code` always lands there, and the producer
 * re-routes `read`/`write`/`edit` of a source file to it through
 * `meta.materials` (spec §2.3).
 */
const ALIAS_GROUPS = Object.freeze({
  code: ['run_code'],
  sheet: [],
  search: [
    'glob', 'grep', 'session_search', 'session_trace', 'session_event_read',
    'session_event_search', 'session_event_trace', 'cordis_inspect_list',
    'cordis_inspect_query',
  ],
  doc: ['read', 'read_image', 'write', 'edit', 'apply_patch', 'str_replace_editor', 'present', 'collab_csv_workflow'],
  web: ['web_fetch', 'web_search'],
  shell: [
    'bash', 'pwsh', 'ralph', 'working_directory', 'load_workspace_dependencies',
    'terminal_open', 'terminal_read', 'terminal_send', 'terminal_close', 'terminal_list', 'terminal_signal',
    'job_list', 'job_output', 'job_kill',
  ],
  other: ['skill'],
});

/** Orchestration aliases: they light a seat in the inner ring instead of a material. */
const AGENT_ALIASES = Object.freeze([
  'subagent', 'workflow', 'list_agents', 'interrupt_agent', 'send_message', 'list_subagent_models',
  'collab_accept', 'collab_complete_computation', 'collab_compute', 'collab_delegate',
  'collab_delegate_task', 'collab_history', 'collab_project_log', 'collab_publish',
  'collab_read_evidence', 'collab_send', 'collab_status',
  'orchestrator_ack', 'orchestrator_collab_finish', 'orchestrator_collab_review',
  'orchestrator_eval', 'orchestrator_eval_decide', 'orchestrator_eval_read',
  'orchestrator_policy_sync', 'orchestrator_prompts_save', 'orchestrator_read',
  'orchestrator_reply', 'orchestrator_report', 'orchestrator_route',
  'orchestrator_settings_save', 'orchestrator_thread_follow', 'orchestrator_thread_unrelated',
  'orchestrator_thread_unsubscribe', 'orchestrator_ticket_note',
  'orchestrator_ticket_request_status', 'orchestrator_ticket_retry',
  'orchestrator_trigger_handback', 'orchestrator_trigger_requeue',
]);

/** Asking the human draws no node at all: it stops the field. */
const ASK_ALIASES = Object.freeze(['ask_user_question']);

/**
 * Bookkeeping is not a material (§2.2 of the v0.4 spec).
 *
 * A todo list, a goal and a schedule entry are things the agent writes down, not
 * things it works on. They light nothing on the ring; the centre says 「计划中」
 * for the duration instead, so the field is still truthful.
 */
const PLAN_ALIASES = Object.freeze([
  'todo_write', 'create_goal', 'update_goal', 'get_goal',
  'schedule_create', 'schedule_edit', 'schedule_list', 'schedule_view',
]);

/** The six materials that exist (§2.1). `sheet` is kept for a future tool path. */
export const MATERIALS = Object.freeze({
  code: { zh: '代码', en: 'Code' },
  sheet: { zh: '表格', en: 'Sheets' },
  search: { zh: '检索', en: 'Search' },
  doc: { zh: '文档', en: 'Documents' },
  web: { zh: '网页', en: 'Web' },
  shell: { zh: '终端', en: 'Shell' },
  other: { zh: '其它', en: 'Other' },
});

/** Unknown bucket id: the only destination for anything unmapped. */
export const OTHER_MATERIAL = 'other';

/** Vocabulary order (labels exist for these), not the ring order — see SEAT_ORDER. */
export const MATERIAL_ORDER = Object.freeze(Object.keys(MATERIALS));

/**
 * Ring order: one entry per 45° slot, starting at 12 o'clock (§1.1).
 *
 * `null` is an empty slot. The ring is deliberately not full: three and nine
 * o'clock stay open, which keeps the composition symmetric and leaves room for a
 * future material without moving any existing seat.
 */
export const SEAT_ORDER = Object.freeze([
  'shell',   // 12:00
  'code',    //  1:30
  null,      //  3:00
  'search',  //  4:30
  'other',   //  6:00
  'web',     //  7:30
  null,      //  9:00
  'doc',     // 10:30
]);

/** How many slots the ladder has; the step is 360/8 degrees. */
export const SEAT_COUNT = SEAT_ORDER.length;

/**
 * Pre-set links (§3). Structure only — the arc is drawn from a live event window,
 * never because two nodes happen to be visible.
 */
export const LINKS = Object.freeze([
  Object.freeze({ a: 'shell', b: 'code', zh: '执行', en: 'runs' }),
]);

/** alias -> material id, or `null` for the agent / ask / plan seats. */
export const MATERIAL_BY_ALIAS = (() => {
  const table = {};
  for (const [material, aliases] of Object.entries(ALIAS_GROUPS)) {
    for (const alias of aliases) table[alias] = material;
  }
  for (const alias of AGENT_ALIASES) table[alias] = null;
  for (const alias of ASK_ALIASES) table[alias] = null;
  for (const alias of PLAN_ALIASES) table[alias] = null;
  return Object.freeze(table);
})();

/**
 * State -> colour, for the DARK field. `colorOf(state, theme)` is the real entry
 * point: the light palette lives in {@link THEMES}. `done` keeps its green here
 * for the run-level conclusion; a material node uses the same mapping.
 */
export const STATE_COLORS = Object.freeze({
  running: '#4c9aff',
  'waiting-human': '#f2b544',
  done: '#2fd18a',
  failed: '#ff5f6d',
  idle: '#96aac3',
});

/**
 * Palettes, one per host surface.
 *
 * The field sits on a scrim over the host's own window, so a dark field on a
 * light window reads as a bruise: the ink, the accents and the glow strength all
 * have to follow. `ink`/`subInk` are already-computed `rgba()` strings because
 * the canvas wants text alpha baked in; `colors` stay `#rrggbb` so `rgba()` can
 * vary their alpha.
 */
export const THEMES = Object.freeze({
  dark: Object.freeze({
    ink: 'rgba(232,242,255,.95)',
    labelInk: 'rgba(232,242,255,.92)',
    subInk: 'rgba(150,175,205,.78)',
    doneSub: 'rgba(150,210,185,.8)',
    failedSub: 'rgba(255,140,150,.85)',
    /** the centre halo: colour plus how much of its base alpha survives */
    halo: '#4c9aff',
    haloAlpha: 1,
    /** glows are light on dark; on light they smear, so they shrink */
    glowScale: 1,
    /** thin lines need more alpha against a bright surface */
    lineScale: 1,
    colors: STATE_COLORS,
  }),
  light: Object.freeze({
    ink: 'rgba(22,30,42,.92)',
    labelInk: 'rgba(26,34,46,.9)',
    subInk: 'rgba(70,84,102,.82)',
    doneSub: 'rgba(18,104,72,.92)',
    failedSub: 'rgba(166,38,54,.92)',
    halo: '#0b1020',
    haloAlpha: 0.45,
    glowScale: 0.32,
    lineScale: 1.35,
    // Darker accents: #4c9aff on white is a 2.6:1 contrast, this is 4.6:1.
    colors: Object.freeze({
      running: '#2f6fd0',
      'waiting-human': '#a8690a',
      done: '#15805a',
      failed: '#c62f3f',
      idle: '#6b7a8d',
    }),
  }),
});

/** Every theme this build ships; the client may only ever name one of these. */
export const THEME_NAMES = Object.freeze(Object.keys(THEMES));

/** The palette for a theme name. An unknown name is the dark one, never a throw. */
export function paletteOf(theme) {
  return THEMES[theme] ?? THEMES.dark;
}

/**
 * Words for the RUN (§5.3). The centre and the capsule speak this vocabulary;
 * individual materials use `materialDoneLabel` instead, so 「完成」 can only ever
 * mean "this material is done" and 「成功」 only "the run succeeded".
 */
export const RUN_LABELS = Object.freeze({
  running: { zh: '执行中', en: 'Working' },
  'waiting-human': { zh: '等你确认', en: 'Needs you' },
  done: { zh: '成功', en: 'Success' },
  failed: { zh: '失败', en: 'Failed' },
  idle: { zh: '待命', en: 'Idle' },
});

/** The one settled word a material node can show (§4.2). */
export const MATERIAL_DONE = Object.freeze({ zh: '完成', en: 'Done' });

/**
 * What the code seat calls itself while a declared execution is running (§2.4).
 *
 * A closed vocabulary, never a filename: `cleanLabel` would silently delete a
 * path, and an empty label is worse than a generic one.
 */
export const CODE_LANGUAGES = Object.freeze({
  python: { zh: 'Python', en: 'Python' },
  node: { zh: 'Node', en: 'Node' },
  deno: { zh: 'Deno', en: 'Deno' },
  bun: { zh: 'Bun', en: 'Bun' },
});

/** The label of the code seat: the language when declared, else 「代码」. */
export function codeLanguageLabel(language, locale) {
  const entry = CODE_LANGUAGES[language];
  return entry === undefined ? materialLabel('code', locale) : entry[languageOf(locale)];
}

/**
 * Per-intent verbs. `read`/`write`/`execute`/`scan`/`fetch`/`handoff` are the
 * six things a call can do; the material then decides the exact word.
 */
const VERBS = Object.freeze({
  read: { zh: '读取中', en: 'Reading' },
  write: { zh: '整理中', en: 'Writing' },
  execute: { zh: '执行中', en: 'Running' },
  scan: { zh: '扫描中', en: 'Scanning' },
  fetch: { zh: '获取中', en: 'Fetching' },
  handoff: { zh: '回传中', en: 'Handing back' },
});

/**
 * A material may own the word for an intent (§4.2): the code seat writes code
 * (编写中) while the document seat still writes files (整理中).
 */
const MATERIAL_VERBS = Object.freeze({
  code: Object.freeze({
    write: { zh: '编写中', en: 'Writing' },
    read: { zh: '阅读中', en: 'Reading' },
  }),
});

/** 「其它」 is the bin: it never claims to know what happened. */
const OTHER_VERB = Object.freeze({ zh: '处理中', en: 'Working' });

const VERB_GROUPS = Object.freeze({
  read: ['read', 'read_image', 'session_event_read', 'get_goal', 'collab_read_evidence', 'orchestrator_read', 'schedule_view'],
  write: ['write', 'edit', 'apply_patch', 'str_replace_editor', 'present', 'todo_write', 'create_goal', 'update_goal', 'schedule_create', 'schedule_edit', 'send_message', 'collab_send', 'collab_publish', 'collab_csv_workflow', 'orchestrator_reply'],
  execute: ['bash', 'pwsh', 'ralph', 'run_code', 'working_directory', 'load_workspace_dependencies', 'terminal_open', 'terminal_read', 'terminal_send', 'terminal_close', 'terminal_list', 'terminal_signal', 'job_list', 'job_output', 'job_kill', 'skill'],
  scan: ['glob', 'grep', 'session_search', 'session_trace', 'session_event_search', 'session_event_trace', 'cordis_inspect_list', 'cordis_inspect_query'],
  fetch: ['web_fetch', 'web_search'],
  handoff: ['ask_user_question', 'subagent', 'workflow', 'list_agents', 'interrupt_agent'],
});

const VERB_BY_ALIAS = (() => {
  const table = {};
  for (const [verb, aliases] of Object.entries(VERB_GROUPS)) {
    for (const alias of aliases) table[alias] = verb;
  }
  return Object.freeze(table);
})();

function languageOf(locale) {
  return typeof locale === 'string' && /^en\b/i.test(locale) ? 'en' : 'zh';
}

/** The seven materials with their localised labels. */
export function materialLabel(materialId, locale) {
  const entry = MATERIALS[materialId] ?? MATERIALS[OTHER_MATERIAL];
  return entry[languageOf(locale)];
}

/** Human text for a RUN state (§5.3). */
export function stateLabel(state, locale) {
  const entry = RUN_LABELS[state] ?? RUN_LABELS.idle;
  return entry[languageOf(locale)];
}

/** Human text for a material that finished (§4.2). */
export function materialDoneLabel(locale) {
  return MATERIAL_DONE[languageOf(locale)];
}

/** Colour for a state, in one theme; `idle` never draws a node, but the palette stays total. */
export function colorOf(state, theme) {
  const colors = paletteOf(theme).colors;
  return colors[state] ?? colors.idle;
}

/**
 * Localised verb for one material being touched by one call.
 *
 * Two axes, because one is not enough: `glob`, `web_fetch` and `skill` used to
 * share the `verify` intent and all read 「校验中」. The material disambiguates.
 */
export function verbFor(material, alias, locale) {
  const language = languageOf(locale);
  if (material === OTHER_MATERIAL) return OTHER_VERB[language];
  const intent = VERB_BY_ALIAS[alias] ?? 'read';
  const override = MATERIAL_VERBS[material] === undefined ? undefined : MATERIAL_VERBS[material][intent];
  if (override !== undefined) return override[language];
  return (VERBS[intent] ?? VERBS.read)[language];
}

/** The slot index of a material on the ring, or −1 when it has no seat. */
export function seatIndexOf(materialId) {
  return SEAT_ORDER.indexOf(materialId);
}

/** Contract mapping for a known alias-table version. */
export function aliasTable(version = ALIAS_VERSION) {
  const aliases = aliasTables.get(version);
  return aliases && { version, aliases: { ...aliases } };
}

/**
 * Fold one native tool id into the material vocabulary.
 *
 * @param toolId - the snapshot event's `tool` (a native id, or null).
 * @param options.aliasVersion - the snapshot's carried table version. A mismatch
 *   degrades every node to 「其它」 while leaving states untouched (§2.2).
 * @returns `{tool, alias, material, known, aliasOk}`; `material` is `null` for
 *   the agent/ask/plan aliases, and `known` reports table membership (tests only).
 */
export function materialForTool(toolId, options = {}) {
  const aliasVersion = options.aliasVersion ?? ALIAS_VERSION;
  const aliases = aliasTables.get(aliasVersion);
  const tool = typeof toolId === 'string' ? toolId : '';
  if (!aliases) return { tool, alias: null, material: OTHER_MATERIAL, known: false, aliasOk: false };
  if (tool === '' || !Object.hasOwn(aliases, tool)) {
    return { tool, alias: null, material: OTHER_MATERIAL, known: false, aliasOk: true };
  }
  const alias = aliases[tool];
  const material = Object.hasOwn(MATERIAL_BY_ALIAS, alias) ? MATERIAL_BY_ALIAS[alias] : OTHER_MATERIAL;
  return { tool, alias, material, known: true, aliasOk: true };
}

/** The visual intent of an alias, used for the pulse glyph and the delegate seat. */
export function intentOfAlias(alias) {
  if (alias === null || alias === undefined) return 'other';
  return VERB_BY_ALIAS[alias] ?? 'read';
}

/** True when the alias belongs to the orchestration group (lights an agent seat). */
export function isAgentAlias(alias) {
  return alias !== null && AGENT_ALIASES.includes(alias);
}

/** True when the alias is the human question (stops the field). */
export function isAskAlias(alias) {
  return alias !== null && ASK_ALIASES.includes(alias);
}

/** True when the alias is bookkeeping: no node, the centre says 「计划中」. */
export function isPlanAlias(alias) {
  return alias !== null && PLAN_ALIASES.includes(alias);
}

/** True when the alias drives the terminal seat (used for the exec latch). */
export function isShellAlias(alias) {
  return alias !== null && ALIAS_GROUPS.shell.includes(alias);
}
