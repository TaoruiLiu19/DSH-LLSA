/**
 * The label rule against the contract's own 13 cases.
 *
 * `contracts/fixtures/hud-labels.json` is the producer's fixture, but the rule
 * is shared: the degraded source names agents from run titles too, and a label
 * must never leak a path, URL, address or code identifier into the UI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanLabel, hudLabel } from '../src/labels.js';
import { contractJson, hasContracts } from './contract.js';

const skip = hasContracts ? false : 'contracts/ is not next to this package';
const fixture = hasContracts ? contractJson('fixtures/hud-labels.json') : { cases: [] };

test('the 13 label cases from the contract all agree', { skip }, () => {
  assert.equal(fixture.cases.length, 13, '施工文档 §5.1: 13 label cases');
  for (const labelCase of fixture.cases) {
    assert.equal(hudLabel(labelCase.input), labelCase.expected, JSON.stringify(labelCase.input));
  }
});

test('the label is never longer than twelve code points', () => {
  for (const input of [
    '一二三四五六七八九十甲乙丙丁戊己',
    'abcdefghijklmnop',
    '𠀀𠀀𠀀𠀀𠀀𠀀𠀀𠀀𠀀𠀀𠀀𠀀𠀀𠀀',
  ]) {
    assert.ok(Array.from(hudLabel({ assignmentTitle: input })).length <= 12, input);
  }
});

test('paths, urls, addresses and code never reach the label', () => {
  const label = hudLabel({ assignmentTitle: '检查 C:\\a\\b.py https://x.test/a user@example.com const secret = 1;' });
  assert.ok(!label.includes('\\'));
  assert.ok(!label.includes('/'));
  assert.ok(!label.includes('@'));
  assert.ok(!label.includes('const'));
  assert.ok(label.length > 0);
});

test('a missing title falls back to the role, then to 智能体', () => {
  assert.equal(hudLabel({ role: 'reviewer' }), 'reviewer');
  assert.equal(hudLabel({}), '智能体');
  assert.equal(cleanLabel(42), '');
  assert.equal(cleanLabel('   '), '');
});

test('newlines and punctuation collapse to single spaces', () => {
  assert.equal(hudLabel({ assignmentTitle: '核对\n结果 /tmp/a.js' }), '核对 结果');
});
