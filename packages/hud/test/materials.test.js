/**
 * The material vocabulary.
 *
 * Two authorities are checked here: the contract's published alias table, and
 * the degradation rule — an unknown tool, or a table version we do not ship,
 * still produces a visible node (`其它`), never a missing one.
 */
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALIAS_VERSION,
  MATERIAL_BY_ALIAS,
  MATERIALS,
  MATERIAL_ORDER,
  RUN_LABELS,
  SEAT_ORDER,
  STATE_COLORS,
  aliasTable,
  colorOf,
  intentOfAlias,
  isAgentAlias,
  isAskAlias,
  isPlanAlias,
  materialDoneLabel,
  materialForTool,
  materialLabel,
  stateLabel,
  verbFor,
} from '../src/materials.js';
import { contractJson, hasContracts } from './contract.js';

const contractSkip = hasContracts ? false : 'contracts/ is not next to this package';

test('the shipped alias table is the contract’s', { skip: contractSkip }, () => {
  const contract = contractJson('tool-aliases-v1.json');
  assert.equal(contract.version, ALIAS_VERSION);
  assert.deepEqual(aliasTable(), contract, 'src/materials.js must mirror contracts/tool-aliases-v1.json');
  const generated = JSON.parse(readFileSync(new URL('../data/tool-aliases-v1.json', import.meta.url), 'utf8'));
  assert.deepEqual(generated, contract, 'data/tool-aliases-v1.json is the published copy');
  assert.deepEqual(aliasTable(2), contractJson('tool-aliases-v2.json'));
});

test('every published alias has exactly one destination', () => {
  const aliasNames = new Set([...Object.values(aliasTable(1).aliases), ...Object.values(aliasTable(2).aliases)]);
  for (const alias of aliasNames) {
    assert.ok(Object.hasOwn(MATERIAL_BY_ALIAS, alias), `alias ${alias} is unmapped`);
  }
  for (const alias of Object.keys(MATERIAL_BY_ALIAS)) {
    assert.ok(aliasNames.has(alias), `mapped alias ${alias} is not in the published table`);
  }
});

test('six materials, one seat table, and a word for every run state', () => {
  assert.deepEqual(MATERIAL_ORDER, ['code', 'sheet', 'search', 'doc', 'web', 'shell', 'other']);
  for (const id of MATERIAL_ORDER) {
    assert.ok(materialLabel(id, 'zh') !== '');
    assert.ok(materialLabel(id, 'en') !== '');
    assert.ok(MATERIALS[id] !== undefined);
  }
  // §1.1: eight slots, six occupied, three and nine o'clock left open.
  assert.equal(SEAT_ORDER.length, 8);
  assert.equal(SEAT_ORDER.filter(id => id !== null).length, 6);
  assert.equal(SEAT_ORDER[2], null);
  assert.equal(SEAT_ORDER[6], null);
  assert.ok(SEAT_ORDER.includes('shell') && SEAT_ORDER.includes('code'));
  // The two seats of §3's arc must stay adjacent.
  assert.equal(Math.abs(SEAT_ORDER.indexOf('shell') - SEAT_ORDER.indexOf('code')), 1);
  for (const state of ['running', 'waiting-human', 'done', 'failed', 'idle']) {
    assert.match(colorOf(state), /^#[0-9a-f]{6}$/);
    assert.ok(stateLabel(state, 'zh') !== '');
    assert.ok(stateLabel(state, 'en') !== '');
    assert.ok(STATE_COLORS[state] !== undefined);
    assert.ok(RUN_LABELS[state] !== undefined);
  }
  // §5.3: the run says 成功/失败; a material says 完成. Two scopes, two words.
  assert.equal(stateLabel('done', 'zh'), '成功');
  assert.equal(stateLabel('failed', 'zh'), '失败');
  assert.equal(materialDoneLabel('zh'), '完成');
  // §4.1's table, verbatim: the four signal colours.
  assert.equal(colorOf('running'), '#4c9aff');
  assert.equal(colorOf('waiting-human'), '#f2b544');
  assert.equal(colorOf('done'), '#2fd18a');
  assert.equal(colorOf('failed'), '#ff5f6d');
});

test('an unknown state degrades to the idle colour instead of throwing', () => {
  assert.equal(colorOf('nonsense'), STATE_COLORS.idle);
  assert.equal(stateLabel('nonsense', 'zh'), RUN_LABELS.idle.zh);
  assert.equal(materialLabel('nonsense', 'zh'), MATERIALS.other.zh);
});

test('the sample tools land in the six buckets', () => {
  const cases = [
    ['read', 'doc', '文档'],
    ['read_image', 'doc', '文档'],
    ['write', 'doc', '文档'],
    ['apply_patch', 'doc', '文档'],
    ['grep', 'search', '检索'],
    ['glob', 'search', '检索'],
    ['bash', 'shell', '终端'],
    ['pwsh', 'shell', '终端'],
    ['terminal_open', 'shell', '终端'],
    ['web_fetch', 'web', '网页'],
    ['web_search', 'web', '网页'],
    ['run_code', 'code', '代码'],
    ['skill', 'other', '其它'],
  ];
  for (const [tool, material, label] of cases) {
    const resolved = materialForTool(tool);
    assert.equal(resolved.material, material, tool);
    assert.equal(resolved.known, true, tool);
    assert.equal(materialLabel(resolved.material, 'zh'), label, tool);
  }
});

test('bookkeeping lights nothing: the centre says 计划中 instead', () => {
  for (const tool of ['todo_write', 'create_goal', 'update_goal', 'get_goal', 'schedule_create', 'schedule_edit', 'schedule_list', 'schedule_view']) {
    const resolved = materialForTool(tool);
    assert.equal(resolved.material, null, tool);
    assert.equal(isPlanAlias(resolved.alias), true, tool);
    assert.equal(isAgentAlias(resolved.alias), false, tool);
  }
});

test('orchestration tools light a seat, and a question lights nothing', () => {
  for (const tool of ['subagent', 'workflow', 'collab_delegate', 'orchestrator_route', 'send_message']) {
    const resolved = materialForTool(tool);
    assert.equal(resolved.material, null, tool);
    assert.equal(isAgentAlias(resolved.alias), true, tool);
  }
  const ask = materialForTool('ask_user_question');
  assert.equal(ask.material, null);
  assert.equal(isAskAlias(ask.alias), true);
  assert.equal(isAgentAlias(ask.alias), false);
});

test('an unknown tool is 其它 without losing the node', () => {
  const resolved = materialForTool('a_tool_from_the_future');
  assert.equal(resolved.material, 'other');
  assert.equal(resolved.known, false);
  assert.equal(resolved.aliasOk, true);
  // §4.2: the bin never claims to know what happened.
  assert.equal(verbFor(resolved.material, resolved.alias, 'zh'), '处理中');
});

test('a null or non-string tool id still resolves', () => {
  assert.equal(materialForTool(undefined).material, 'other');
  assert.equal(materialForTool(null).material, 'other');
  assert.equal(materialForTool(42).material, 'other');
  assert.equal(materialForTool('').known, false);
});

test('an alias version this build does not ship degrades every label', () => {
  const resolved = materialForTool('read', { aliasVersion: 99 });
  assert.equal(resolved.material, 'other');
  assert.equal(resolved.alias, null);
  assert.equal(resolved.aliasOk, false);
  assert.equal(resolved.known, false);
});

test('alias version 2 shows native CSV work without changing existing classifications', () => {
  const tool = 'collab_csv_workflow';
  assert.equal(materialForTool(tool).known, false);
  assert.deepEqual(materialForTool(tool, { aliasVersion: 2 }), {
    tool, alias: tool, material: 'doc', known: true, aliasOk: true,
  });
  assert.equal(verbFor('doc', tool, 'zh'), '整理中');
  assert.deepEqual(materialForTool('read', { aliasVersion: 2 }), materialForTool('read'));
});

test('verbs are material x intent, always present', () => {
  assert.equal(verbFor('doc', 'read', 'zh'), '读取中');
  assert.equal(verbFor('shell', 'bash', 'zh'), '执行中');
  // §4.2: 检索 scans, 网页 fetches, 其它 processes — one intent, three words.
  assert.equal(verbFor('search', 'grep', 'zh'), '扫描中');
  assert.equal(verbFor('web', 'web_fetch', 'zh'), '获取中');
  assert.equal(verbFor('other', 'skill', 'zh'), '处理中');
  // The code seat writes code; the document seat still writes files.
  assert.equal(verbFor('doc', 'write', 'zh'), '整理中');
  assert.equal(verbFor('code', 'write', 'zh'), '编写中');
  assert.equal(verbFor('code', 'read', 'zh'), '阅读中');
  assert.equal(verbFor('code', 'run_code', 'zh'), '执行中');
  assert.equal(verbFor('doc', null, 'en'), 'Reading');
  assert.equal(intentOfAlias('subagent'), 'handoff');
});
