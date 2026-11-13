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
  ALIASES,
  ALIAS_VERSION,
  MATERIAL_BY_ALIAS,
  MATERIALS,
  MATERIAL_ORDER,
  STATE_COLORS,
  STATE_LABELS,
  aliasTable,
  colorOf,
  intentOfAlias,
  isAgentAlias,
  isAskAlias,
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
});

test('every published alias has exactly one destination', () => {
  const aliasNames = new Set(Object.values(ALIASES));
  for (const alias of aliasNames) {
    assert.ok(Object.hasOwn(MATERIAL_BY_ALIAS, alias), `alias ${alias} is unmapped`);
  }
  for (const alias of Object.keys(MATERIAL_BY_ALIAS)) {
    assert.ok(aliasNames.has(alias), `mapped alias ${alias} is not in the published table`);
  }
});

test('there are exactly eight materials and every state has a colour and a word', () => {
  assert.deepEqual(MATERIAL_ORDER, ['python', 'sheet', 'data', 'doc', 'web', 'mail', 'shell', 'other']);
  for (const id of MATERIAL_ORDER) {
    assert.ok(materialLabel(id, 'zh') !== '');
    assert.ok(materialLabel(id, 'en') !== '');
    assert.ok(MATERIALS[id] !== undefined);
  }
  for (const state of ['running', 'waiting-human', 'done', 'failed', 'idle']) {
    assert.match(colorOf(state), /^#[0-9a-f]{6}$/);
    assert.ok(stateLabel(state, 'zh') !== '');
    assert.ok(stateLabel(state, 'en') !== '');
    assert.ok(STATE_COLORS[state] !== undefined);
    assert.ok(STATE_LABELS[state] !== undefined);
  }
  // §4.1's table, verbatim: the four signal colours.
  assert.equal(colorOf('running'), '#4c9aff');
  assert.equal(colorOf('waiting-human'), '#f2b544');
  assert.equal(colorOf('done'), '#2fd18a');
  assert.equal(colorOf('failed'), '#ff5f6d');
});

test('an unknown state degrades to the idle colour instead of throwing', () => {
  assert.equal(colorOf('nonsense'), STATE_COLORS.idle);
  assert.equal(stateLabel('nonsense', 'zh'), STATE_LABELS.idle.zh);
  assert.equal(materialLabel('nonsense', 'zh'), MATERIALS.other.zh);
});

test('the sample tools land in the eight buckets', () => {
  const cases = [
    ['read', 'doc', '文档'],
    ['read_image', 'doc', '文档'],
    ['write', 'doc', '文档'],
    ['apply_patch', 'doc', '文档'],
    ['grep', 'data', '数据'],
    ['glob', 'data', '数据'],
    ['bash', 'shell', '终端'],
    ['pwsh', 'shell', '终端'],
    ['terminal_open', 'shell', '终端'],
    ['web_fetch', 'web', '网页'],
    ['web_search', 'web', '网页'],
    ['run_code', 'python', 'Python'],
    ['skill', 'other', '其它'],
  ];
  for (const [tool, material, label] of cases) {
    const resolved = materialForTool(tool);
    assert.equal(resolved.material, material, tool);
    assert.equal(resolved.known, true, tool);
    assert.equal(materialLabel(resolved.material, 'zh'), label, tool);
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
  assert.equal(verbFor(resolved.alias, 'zh'), '读取中');
});

test('a null or non-string tool id still resolves', () => {
  assert.equal(materialForTool(undefined).material, 'other');
  assert.equal(materialForTool(null).material, 'other');
  assert.equal(materialForTool(42).material, 'other');
  assert.equal(materialForTool('').known, false);
});

test('an alias version this build does not ship degrades every label', () => {
  const resolved = materialForTool('read', { aliasVersion: 2 });
  assert.equal(resolved.material, 'other');
  assert.equal(resolved.alias, null);
  assert.equal(resolved.aliasOk, false);
  assert.equal(resolved.known, false);
});

test('verbs are per-intent and always present', () => {
  assert.equal(verbFor('read', 'zh'), '读取中');
  assert.equal(verbFor('bash', 'zh'), '执行中');
  assert.equal(verbFor('grep', 'zh'), '校验中');
  assert.equal(verbFor('write', 'zh'), '整理中');
  assert.equal(verbFor(null, 'en'), 'Reading');
  assert.equal(intentOfAlias('subagent'), 'handoff');
});
