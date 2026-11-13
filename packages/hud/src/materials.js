/**
 * Materials — the user-facing vocabulary of the HUD.
 *
 * The mapping chain is fixed by the contract (施工文档 §4.7, §2.2):
 *
 *     native tool id -> (contracts/tool-aliases-v{version}.json) alias -> (this table) material
 *
 * The alias table is the orchestrator's published, immutable vocabulary; v1 maps
 * every native id to itself, and the plugin only asks "is this tool in the table
 * this snapshot names?". Two properties matter and are easy to lose:
 *
 * 1. An unknown tool, or a snapshot whose `aliasVersion` this build does not
 *    ship, becomes 「其它」. It never hides the node: state and colour keep
 *    working, only the label degrades.
 * 2. Aliases are the contract; materials are OURS. The alias table carries no
 *    taxonomy, so a new tool needs no contract change to become readable.
 */

/** The alias-table version this build understands (contracts/tool-aliases-v1.json). */
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

/**
 * Which alias belongs to which material. `null` means "drives an agent seat, not
 * a material": delegation is the inner ring, and a question stops the field.
 */
const ALIAS_GROUPS = Object.freeze({
  python: ['run_code'],
  sheet: [],
  data: [
    'glob', 'grep', 'session_search', 'session_trace', 'session_event_read',
    'session_event_search', 'session_event_trace', 'cordis_inspect_list',
    'cordis_inspect_query', 'todo_write', 'create_goal', 'update_goal', 'get_goal',
    'schedule_create', 'schedule_edit', 'schedule_list', 'schedule_view',
  ],
  doc: ['read', 'read_image', 'write', 'edit', 'apply_patch', 'str_replace_editor', 'present'],
  web: ['web_fetch', 'web_search'],
  mail: [],
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

/** The eight default materials (§4.7), in first-ring order. */
export const MATERIALS = Object.freeze({
  python: { zh: 'Python', en: 'Python' },
  sheet: { zh: '表格', en: 'Sheets' },
  data: { zh: '数据', en: 'Data' },
  doc: { zh: '文档', en: 'Documents' },
  web: { zh: '网页', en: 'Web' },
  mail: { zh: '邮件', en: 'Mail' },
  shell: { zh: '终端', en: 'Shell' },
  other: { zh: '其它', en: 'Other' },
});

/** Unknown bucket id: the only destination for anything unmapped. */
export const OTHER_MATERIAL = 'other';

/** Ring order, so seats never jump between renders. */
export const MATERIAL_ORDER = Object.freeze(Object.keys(MATERIALS));

/** alias -> material id, or `null` for the agent/ask seats. */
export const MATERIAL_BY_ALIAS = (() => {
  const table = {};
  for (const [material, aliases] of Object.entries(ALIAS_GROUPS)) {
    for (const alias of aliases) table[alias] = material === 'other' ? OTHER_MATERIAL : material;
  }
  for (const alias of AGENT_ALIASES) table[alias] = null;
  for (const alias of ASK_ALIASES) table[alias] = null;
  return Object.freeze(table);
})();

/**
 * State -> colour. This is the single mapping of §4.1; nothing else invents one.
 */
export const STATE_COLORS = Object.freeze({
  running: '#4c9aff',
  'waiting-human': '#f2b544',
  done: '#2fd18a',
  failed: '#ff5f6d',
  idle: '#96aac3',
});

/** Small text that must accompany every colour (§4.1: colour is never the only signal). */
export const STATE_LABELS = Object.freeze({
  running: { zh: '执行中', en: 'Working' },
  'waiting-human': { zh: '等你确认', en: 'Needs you' },
  done: { zh: '完成', en: 'Done' },
  failed: { zh: '未完成', en: 'Failed' },
  idle: { zh: '待命', en: 'Idle' },
});

/** Per-intent verbs. */
const VERBS = Object.freeze({
  read: { zh: '读取中', en: 'Reading' },
  write: { zh: '整理中', en: 'Writing' },
  execute: { zh: '执行中', en: 'Running' },
  verify: { zh: '校验中', en: 'Checking' },
  handoff: { zh: '回传中', en: 'Handing back' },
});

const VERB_GROUPS = Object.freeze({
  read: ['read', 'read_image', 'schedule_view', 'session_event_read', 'get_goal', 'collab_read_evidence', 'orchestrator_read'],
  write: ['write', 'edit', 'apply_patch', 'str_replace_editor', 'present', 'todo_write', 'create_goal', 'update_goal', 'schedule_create', 'schedule_edit', 'send_message', 'collab_send', 'collab_publish', 'orchestrator_reply'],
  execute: ['bash', 'pwsh', 'ralph', 'run_code', 'working_directory', 'load_workspace_dependencies', 'terminal_open', 'terminal_read', 'terminal_send', 'terminal_close', 'terminal_list', 'terminal_signal', 'job_list', 'job_output', 'job_kill'],
  verify: ['glob', 'grep', 'session_search', 'session_trace', 'session_event_search', 'session_event_trace', 'cordis_inspect_list', 'cordis_inspect_query', 'web_fetch', 'web_search', 'schedule_list', 'skill'],
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

/** The eight materials with their localised labels, in ring order. */
export function materialLabel(materialId, locale) {
  const entry = MATERIALS[materialId] ?? MATERIALS[OTHER_MATERIAL];
  return entry[languageOf(locale)];
}

/** Human text for a state (§4.1 文案列). */
export function stateLabel(state, locale) {
  const entry = STATE_LABELS[state] ?? STATE_LABELS.idle;
  return entry[languageOf(locale)];
}

/** Colour for a state; `idle` never draws a node, but the palette stays total. */
export function colorOf(state) {
  return STATE_COLORS[state] ?? STATE_COLORS.idle;
}

/** Localised verb for a material currently being used. */
export function verbFor(alias, locale) {
  const verb = VERBS[VERB_BY_ALIAS[alias] ?? 'read'] ?? VERBS.read;
  return verb[languageOf(locale)];
}

/** The alias table this build ships; `data/tool-aliases-v1.json` is generated from it. */
export function aliasTable() {
  return { version: ALIAS_VERSION, aliases: { ...ALIASES } };
}

/**
 * Fold one native tool id into the material vocabulary.
 *
 * @param toolId - the snapshot event's `tool` (a native id, or null).
 * @param options.aliasVersion - the snapshot's carried table version. A mismatch
 *   degrades every node to 「其它」 while leaving states untouched (§2.2).
 * @returns `{tool, alias, material, known, aliasOk}`; `material` is `null` for
 *   agent/ask aliases, and `known` reports table membership (tests only).
 */
export function materialForTool(toolId, options = {}) {
  const aliasVersion = options.aliasVersion ?? ALIAS_VERSION;
  const aliasOk = aliasVersion === ALIAS_VERSION;
  const tool = typeof toolId === 'string' ? toolId : '';
  if (!aliasOk) return { tool, alias: null, material: OTHER_MATERIAL, known: false, aliasOk: false };
  if (tool === '' || !Object.hasOwn(ALIASES, tool)) {
    return { tool, alias: null, material: OTHER_MATERIAL, known: false, aliasOk: true };
  }
  const alias = ALIASES[tool];
  const material = Object.hasOwn(MATERIAL_BY_ALIAS, alias) ? MATERIAL_BY_ALIAS[alias] : OTHER_MATERIAL;
  return { tool, alias, material, known: true, aliasOk: true };
}

/** The visual intent of an alias, used for the pulse glyph and the delegate seat. */
export function intentOfAlias(alias) {
  if (alias === null || alias === undefined) return 'other';
  return VERB_BY_ALIAS[alias] ?? 'read';
}

/** The verb intent itself, e.g. `handoff` for a delegation. */
export function verbIntentOf(alias) {
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
