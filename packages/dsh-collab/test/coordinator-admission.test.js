import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempDisposableSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CollaborationManager } from '../src/manager.js';
import { CollaborationStore } from '../src/store.js';
import { requestTokenAdmission } from '../src/accounting.js';
import { connectSuperagent } from '../src/superagent-integration.js';

const session = { id: 'native-master' };
const runId = 'super-master-native-master';
const budget = { code: 'TOKEN_BUDGET' };
const runScope = { scope: 'run' };

function fixture(t, { initialCoordinator = 'native', ...options } = {}) {
  const scratch = mkdtempDisposableSync(join(tmpdir(), 'llsa-coordinator-admission-'));
  let store, manager, boundary;
  const bridge = { compatibility: () => ({ apiVersion: 2 }), snapshot: () => ({ masterSessionId: session.id }),
    registerLifecycle: () => () => {} };
  function open() {
    store = new CollaborationStore({ stateDir: scratch.path });
    manager = new CollaborationManager({ store, maxRunTokens: 1000, ...options });
    manager.attachBridge(bridge);
    if (initialCoordinator === 'native') manager.bindRoot(session.id, { runId });
    else if (initialCoordinator === 'standalone') manager.bindRoot(session.id);
  }
  async function close() { await manager.close(); store.close(); }
  open();
  t.after(async () => { await close(); scratch.remove(); });
  function admission(opts = {}) {
    return requestTokenAdmission({ sessionId: session.id, ...opts }, session, manager.binding(session.id), store.getRun(runId),
      session.id, () => boundary, store);
  }
  function start(turn, seq) {
    manager.observeCoordinatorTurn(session.id, { type: 'turn/start', seq, data: { turn } });
    boundary = { openTurnStartSeq: seq, lastTurn: turn, lastStepStartSeq: seq + 1,
      lastStepBoundary: { kind: 'start', seq: seq + 1 } };
    return admission();
  }
  function reserve(id, estimate, scope = admission(), price = {}) {
    manager.reserveCall(session.id, id, estimate, price, scope);
    store.recordRequest({ callId: id, runId, estimate, tokenAdmission: scope });
  }
  function settle(id, inputTokens, outputTokens, scope = admission()) {
    store.recordUsage({ runId, callId: id, inputTokens, outputTokens, tokenAdmission: scope });
    manager.releaseCall(id);
  }
  return { start, admission, reserve, settle, bridge, get store() { return store; }, get manager() { return manager; },
    boundary(value) { boundary = value; }, async restart() { await close(); open(); } };
}

for (const initialCoordinator of ['standalone', 'absent']) {
  const timing = initialCoordinator === 'standalone' ? 'after' : 'before';
  test(`bridge binds the coordinator ${timing} agent creation and before its first host turn`, t => {
    const f = fixture(t, { initialCoordinator });
    const standaloneId = `run-${session.id}`;
    if (initialCoordinator === 'standalone') {
      assert.equal(f.manager.binding(session.id).runId, standaloneId);
      f.store.recordUsage({ runId: standaloneId, callId: 'historic-standalone', inputTokens: 15, outputTokens: 1 });
    } else {
      assert.equal(f.manager.binding(session.id), undefined);
    }
    f.manager.bindRoot('unrelated');
    const integration = connectSuperagent(f.manager, f.bridge);
    t.after(integration.dispose);
    assert.equal(f.manager.bindRoot(session.id).runId, runId); // Also covers agent creation after connect.
    assert.equal(integration.bindCoordinator('unrelated'), undefined);
    assert.equal(f.manager.binding('unrelated').runId, 'run-unrelated');

    f.manager.observeCoordinatorTurn(session.id, { type: 'turn/start', seq: 5, data: { turn: 1 } });
    f.manager.observeCoordinatorTurn(session.id, { type: 'step/start', seq: 7, data: { turn: 1, step: 1 } });
    const anchor = { scope: 'coordinator_turn', turn: 1, startSeq: 5 };
    const scope = requestTokenAdmission({ sessionId: session.id }, session, f.manager.binding(session.id),
      f.store.getRun(runId), session.id, native => f.manager.coordinatorBoundaries.get(native.id), f.store);
    assert.deepEqual(scope, anchor);
    assert.equal(f.store.eventsByKind(runId, 'coordinator_turn_started').length, 1);
    assert.equal(f.store.usageSummary(runId).totalTokens, 0);
    if (initialCoordinator === 'standalone') assert.equal(f.store.usageSummary(standaloneId).totalTokens, 16);
  });
}

test('bridge retains a coordinator session bound to another native assignment', t => {
  const f = fixture(t, { initialCoordinator: 'absent' });
  const unrelated = f.manager.bindRoot(session.id, { runId: 'other-worker', ticketId: 'ticket', assignmentId: 'assignment' });
  t.after(connectSuperagent(f.manager, f.bridge).dispose);
  assert.deepEqual(f.manager.binding(session.id), unrelated);
  assert.equal(f.store.getRun(runId), null);
});

test('bridge retains an incompatible stored run and does not adopt its accounting scope', t => {
  const f = fixture(t, { initialCoordinator: 'standalone' });
  const standalone = f.manager.binding(session.id);
  const stored = f.store.createRun({ id: runId, ticketId: 'other', assignmentId: 'other', rootSessionId: 'other' });
  t.after(connectSuperagent(f.manager, f.bridge).dispose);
  assert.deepEqual(f.manager.binding(session.id), standalone);
  assert.deepEqual(f.store.getRun(runId), stored);
});

test('verified coordinator turns have independent caps and include all steps, outstanding reservations and actual usage', t => {
  const f = fixture(t);
  const first = f.start(1, 11);
  assert.deepEqual(first, { scope: 'coordinator_turn', turn: 1, startSeq: 11 });
  f.reserve('first-a', 700);
  assert.throws(() => f.reserve('parallel', 301), budget);
  f.settle('first-a', 620, 10);
  f.boundary({ openTurnStartSeq: 11, lastTurn: 1, lastStepStartSeq: 15, lastStepBoundary: { kind: 'start', seq: 15 } });
  assert.throws(() => f.reserve('next-step', 371), budget);
  f.reserve('first-b', 370);
  assert.equal(f.manager.held.has(runId), false);
  assert.equal(f.store.eventsByKind(runId, 'dispatch_hold').length, 0);
  const second = f.start(2, 20);
  f.reserve('second', 800, second);
  f.settle('first-b', 340, 30, first); // A prior turn completes after the new turn already started.
  assert.throws(() => f.reserve('second-over', 201), budget);
  f.settle('second', 760, 40, second);
  f.reserve('second-boundary', 200);
  assert.equal(f.store.usageSummary(runId).totalTokens, 1800);
  assert.throws(() => f.reserve('unknown-turn', 1, runScope), budget);
});

test('replays and restart retain the native turn, partial usage and reservations across rehydration', async t => {
  const f = fixture(t);
  // Migration keeps known history in global accounting, plus the unresolved legacy reservation.
  f.reserve('legacy-pending', 75, runScope);
  f.store.recordUsage({ runId, callId: 'old', inputTokens: 1000, outputTokens: 0 });
  const first = f.start(2, 120);
  f.reserve('partial', 700);
  f.settle('partial', 180, null);
  assert.throws(() => f.reserve('would-overbook', 226), budget);
  await f.restart();
  assert.deepEqual(f.admission(), first);
  assert.deepEqual(f.start(2, 120), first);
  assert.equal(f.store.eventsByKind(runId, 'coordinator_turn_started').length, 1);
  assert.throws(() => f.reserve('after-restart', 226), budget);
  f.reserve('at-limit', 225);
  const second = f.start(3, 170);
  f.reserve('new-turn', 925);
  assert.throws(() => f.reserve('new-turn-over', 1), budget);
  assert.throws(() => f.manager.reserveCall(session.id, 'partial', 700, {}, second), { code: 'RESERVATION_CONFLICT' });
});

test('missing turn proof, auxiliary calls, mutable request options and workers keep cumulative run protection', t => {
  const f = fixture(t);
  f.store.recordUsage({ runId, callId: 'historic', inputTokens: 1100, outputTokens: 0 });
  for (const bad of [undefined, { openTurnStartSeq: null, lastTurn: 1 },
    { openTurnStartSeq: 20, lastTurn: 1, lastStepStartSeq: 25, lastStepBoundary: { kind: 'start', seq: 25 } }]) {
    f.boundary(bad);
    assert.deepEqual(f.admission({ turn: 20, startSeq: 777 }), runScope);
  }
  f.start(1, 20);
  assert.deepEqual(f.admission({ purpose: 'compaction' }), runScope);
  assert.deepEqual(f.admission({ sessionId: 'another-session' }), runScope);
  f.boundary({ openTurnStartSeq: 20, lastTurn: 1, lastStepStartSeq: 21, lastStepBoundary: { kind: 'end', seq: 22 } });
  assert.deepEqual(f.admission(), runScope);
  assert.throws(() => f.reserve('unverified', 1), budget);
  f.manager.bindRoot('worker', { runId: 'work', ticketId: 'ticket', assignmentId: 'a' });
  f.store.recordUsage({ runId: 'work', callId: 'worker-history', inputTokens: 1000, outputTokens: 0 });
  f.manager.observeCoordinatorTurn('worker', { type: 'turn/start', seq: 9, data: { turn: 10 } });
  assert.throws(() => f.manager.reserveCall('worker', 'overspend', 1, {}, { scope: 'coordinator_turn', startSeq: 9, turn: 10 }), budget);
});

test('an unscoped call after the current boundary consumes capacity and an interrupted preparation releases only its own reserve', t => {
  const f = fixture(t);
  const turn = f.start(1, 19);
  f.reserve('aux', 300, runScope);
  f.settle('aux', 250, 50, runScope);
  f.reserve('setup-failed', 400);
  f.reserve('running', 200);
  f.manager.cancelBeforeDispatch('setup-failed', { tokenAdmission: turn });
  assert.throws(() => f.reserve('too-much', 501), budget);
  f.reserve('exact', 500);
  assert.equal(f.store.usageSummary(runId).usage.find(row => row.callId === 'setup-failed').measurement, 'host_not_dispatched');
});

test('only the active step of a native turn is scoped after replaying host events', t => {
  const f = fixture(t);
  const emit = (type, seq, turn) => f.manager.observeCoordinatorTurn(session.id, { type, seq, data: { turn } });
  const current = () => requestTokenAdmission({ sessionId: session.id }, session, f.manager.binding(session.id),
    f.store.getRun(runId), session.id, native => f.manager.coordinatorBoundaries.get(native.id), f.store);
  emit('step/start', 8, 1); // Bound during the first native turn, after the true start.
  assert.deepEqual(current(), runScope);
  emit('turn/start', 24, 2);
  assert.deepEqual(current(), runScope);
  emit('step/start', 26, 2);
  const expected = { scope: 'coordinator_turn', turn: 2, startSeq: 24 };
  assert.deepEqual(current(), expected);
  emit('step/end', 29, 2);
  emit('turn/start', 24, 2); // Out-of-order delivery cannot reopen the completed step.
  assert.deepEqual(current(), runScope);
  emit('step/start', 31, 2);
  assert.deepEqual(current(), expected);
  emit('turn/end', 34, 2);
  assert.deepEqual(current(), runScope);
  emit('turn/start', 39, 3);
  emit('step/start', 42, 3);
  assert.deepEqual(current(), { scope: 'coordinator_turn', turn: 3, startSeq: 39 });
  assert.equal(f.store.eventsByKind(runId, 'coordinator_turn_started').length, 2);
});

test('a new native turn preserves operator and money holds and all monetary scopes across restart', async t => {
  const price = { provider: 'fixture', model: 'm', estimatedInputTokens: 100, maxOutputTokens: 0 };
  const moneyPolicy = { id: 'period', currency: 'USD', maxCost: 0.00021, maxRunCost: 0.00021,
    maxBranchCost: 0.00021, reserveMultiplier: 1, prices: [{ id: 'sample', source: 'test',
      currency: 'USD', provider: 'fixture', model: 'm', perMillion: { cacheHit: 1, cacheMiss: 1, cacheWrite: 1, output: 1 } }] };
  const f = fixture(t, { moneyPolicy });
  const first = f.start(1, 10);
  f.reserve('provider-open', 100, first, price);
  f.reserve('prepared', 100, first, price);
  const money = () => f.manager.moneyBudget.snapshot(runId);
  assert.equal(money().unsettledCalls, 2);
  f.manager.cancelBeforeDispatch('prepared', { tokenAdmission: first, provider: price.provider, model: price.model });
  assert.equal(money().unsettledCalls, 1);
  const oneCall = money().scopes;
  for (const scope of Object.values(oneCall)) assert.equal(scope.committed, 0.0001);
  f.manager.pause(runId, true, 'operator');
  const next = f.start(2, 20);
  assert.equal(f.manager.held.has(runId), true);
  assert.deepEqual(f.store.eventsByKind(runId, 'dispatch_hold').map(event => event.payload.paused), [true]);
  f.manager.pause(runId, false);
  assert.deepEqual(money().scopes, oneCall);
  f.reserve('second-turn', 100, next, price);
  assert.throws(() => f.reserve('double', 100, next, price), { code: 'MONEY_BUDGET' });
  const heldMoney = money().scopes;
  const third = f.start(3, 33);
  assert.deepEqual(money().scopes, heldMoney);
  assert.throws(() => f.reserve('paused', 100, third, price), { code: 'RUN_PAUSED' });
  await f.restart();
  assert.equal(f.manager.moneyHolds.has(runId), true);
  assert.deepEqual(money().scopes, heldMoney);
  assert.throws(() => f.reserve('paused-after-restart', 100, third, price), { code: 'RUN_PAUSED' });
});
