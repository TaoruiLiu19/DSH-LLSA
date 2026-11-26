import test from 'node:test';
import assert from 'node:assert/strict';
import { statusView } from '../src/status-view.js';

function fixture() {
  const input = { version: 'v1' };
  const item = { id: 'work-1', parentId: 'worker', state: 'running' };
  const usage = { calls: 1, totalTokens: 1000, unknownCalls: 0 };
  const store = {
    getRun: () => ({ ticketId: 'ticket1' }),
    getWorkItems: () => [item],
    getAgents: () => [{ id: 'worker', role: 'root', state: 'running' }],
    usageSummary: () => usage,
  };
  const manager = { store, nativeInputs: { current: () => input },
    workStatus: () => ({ workItemId: item.id, eventId: 'ready-event', evidenceRefs: ['proof'], nextAction: 'Review' }) };
  return { input, item, usage, manager };
}

test('conditional status suppresses unchanged work, not an explicitly requested full status or a revision of input', () => {
  const { input, usage, manager } = fixture();
  const get = args => statusView(manager, 'worker', 'run', args);
  const original = get();
  assert.equal(original.workItems.length, 1);
  usage.calls++;
  assert.deepEqual(get({ ifRevision: original.revision }), { unchanged: true, revision: original.revision });
  assert.equal(get().usage.calls, 2);
  input.version = 'v2';
  assert.notEqual(get({ ifRevision: original.revision }).revision, original.revision);
});

test('conditional status preserves acceptance requests and stale or failed work', () => {
  const { item, manager } = fixture();
  const get = args => statusView(manager, 'worker', 'run', args);
  item.state = 'submitted';
  const ready = get();
  assert.equal(get({ ifRevision: ready.revision }).requiredAssessments[0].eventId, 'ready-event');
  item.state = 'rejected';
  item.staleInput = true;
  const rejected = get({ ifRevision: ready.revision });
  assert.notEqual(rejected.revision, ready.revision);
  assert.equal(get({ ifRevision: rejected.revision }).workItems[0].staleInput, true);
  assert.throws(() => get({ ticketId: 'another-ticket' }), /cannot view/);
});

test('master snapshots are scoped and do not hide attention or mix revisions across tickets', () => {
  const { manager } = fixture();
  const rows = ['ticket1', 'ticket2'].map(id => ({ ticket: { id }, assignmentId: 'a1' }));
  manager.bridge = { snapshot: () => ({ masterSessionId: 'master', tickets: rows }) };
  const get = args => statusView(manager, 'master', 'master-run', args);
  const first = get({ ticketId: 'ticket1' });
  assert.deepEqual(first.tickets.map(t => t.ticketId), ['ticket1']);
  assert.ok(!get({ ticketId: 'ticket2', ifRevision: first.revision }).unchanged);
  rows[0].ticket.attention = { text: 'Please confirm' };
  const attention = get({ ticketId: 'ticket1' });
  assert.equal(get({ ticketId: 'ticket1', ifRevision: attention.revision }).tickets[0].attention, true);
});
