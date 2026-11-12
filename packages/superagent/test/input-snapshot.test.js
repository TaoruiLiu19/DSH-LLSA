import test from 'node:test';
import assert from 'node:assert/strict';
import { captureTaskInput } from '../src/app/input-snapshot.ts';

const source = id => ({ id, source: 'local', threads: [], actor: { source: 'local', id: 'owner' }, human: true, at: '2026-11-11', text: `source ${id}`, meta: {} });
function fixture() {
  const sources = new Map(['one', 'two', 'followup', 'resume'].map(id => [id, source(id)]));
  const ticket = { id: 'ticket', origin: { triggerId: 'one', triggerIds: ['one', 'two'] }, mandate: { constraints: ['no deployment'] }, assignments: [{ id: 'first' }], inputs: [
    { id: 'i1', kind: 'trigger', triggerId: 'followup', at: '1', human: true },
    { id: 'i2', kind: 'text', text: 'new requirement', at: '2' },
    { id: 'i3', kind: 'note', text: 'context only', at: '3' },
    { id: 'i4', kind: 'resumed', triggerId: 'resume', at: '4' },
    { id: 'i5', kind: 'policy-changed', from: 'p1', to: 'p2', effect: { instruction: 'read only' }, at: '5' },
    { id: 'i6', kind: 'reopen', decisionId: 'd2', at: '6' },
  ] };
  return { ticket, sources, capture: () => captureTaskInput(ticket, id => sources.get(id)) };
}
test('captures all origins, follow-ups and input kinds without mutable transport fields', () => {
  const { ticket, capture } = fixture(), first = capture();
  assert.deepEqual(first.content.sources.map(s => s.id), ['one', 'two', 'followup', 'resume']);
  assert.equal(first.content.inputs.length, 6);
  Object.assign(ticket.inputs[0], { readAt: 'later', deliveredTo: 'first', deliveredAt: 'later' });
  ticket.assignments[0].state = 'running'; ticket.updatedAt = 'later';
  assert.equal(capture().version, first.version);
  assert.equal(captureTaskInput(JSON.parse(JSON.stringify(ticket)), id => first.content.sources.find(s => s.id === id)).text, first.text);
  ticket.inputs[1].text = 'corrected requirement';
  assert.notEqual(capture().version, first.version);
});
test('source edits, mandates and retry assignments change versions; snapshots remain detached', () => {
  const { ticket, sources, capture } = fixture(), first = capture();
  sources.get('two').text = 'corrected same ID';
  assert.notEqual(capture().version, first.version);
  assert.equal(first.content.sources[1].text, 'source two');
  const second = capture(); ticket.assignments.push({ id: 'retry' });
  assert.notEqual(capture().version, second.version);
  const third = capture(); ticket.mandate.constraints.push('new rule');
  assert.notEqual(capture().version, third.version);
  sources.delete('followup'); assert.throws(capture, /missing task source/);
});
