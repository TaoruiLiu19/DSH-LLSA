import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CollaborationStore } from '../src/store.js';
import { requestAccountingContext, summarizeAccounting, withSharedCoordinatorAccounting } from '../src/accounting.js';

const measured = { inputTokens: 100, cachedInputTokens: 70, uncachedInputTokens: 30,
  cacheWriteTokens: 0, outputTokens: 20, cost: 0.01, currency: 'USD' };
const worker = { id: 'worker-t1', runId: 'super-t1-a1' };
const task = { id: worker.runId, source: 'superagent', ticketId: 't1', assignmentId: 'a1', rootSessionId: worker.id };

test('request settings preserve the actual option and distinguish a reservation fallback from a cap', () => {
  const options = { provider: 'p', model: 'm', maxTokens: 4096 };
  const before = structuredClone(options);
  const explicit = requestAccountingContext(options, worker, task, 1536, 'master');
  assert.equal(explicit.requestLimits.requestedMaxOutputTokens, 4096);
  assert.equal(explicit.requestLimits.reservationMaxOutputTokens, 4096);
  assert.equal(explicit.requestLimits.observedStatus, 'explicit');
  assert.equal(explicit.requestLimits.providerEffectiveLimit, 'unknown');
  assert.equal(explicit.accountingScope, 'ticket_execution');
  assert.equal(explicit.ticketId, 't1');
  assert.deepEqual(options, before, 'observing an option must not change the request');

  const missing = requestAccountingContext({}, worker, task, 1536, 'master');
  assert.equal(missing.requestLimits.requestedMaxOutputTokens, null);
  assert.equal(missing.requestLimits.observedStatus, 'not_set');
  assert.equal(missing.requestLimits.reservationMaxOutputTokens, 1536);
  assert.equal(missing.requestLimits.reservationSource, 'configured_estimate');
  assert.equal(requestAccountingContext({ maxTokens: -1 }, worker, task, 1536).requestLimits.observedStatus, 'invalid');
  assert.equal(requestAccountingContext({}, {}, {}, 1536).accountingScope, 'standalone');
});

test('coordinator attribution never claims a whole shared call for a particular ticket', () => {
  const run = { id: 'super-master-master', rootSessionId: 'master', source: 'dsh', ticketId: 'local-master' };
  for (const coordinatorId of ['master', undefined]) {
    const context = requestAccountingContext({}, {id:'master'}, run, 1536, coordinatorId);
    assert.equal(context.accountingScope, 'shared_coordinator');
    assert.equal(context.ticketId, null);
    assert.equal(context.assignmentId, null);
  }
  const child = requestAccountingContext({}, {id:'child',parentId:worker.id}, task, 1536, 'master');
  assert.equal(child.accountingScope, 'ticket_execution');
  assert.equal(child.ticketId, 't1');
});

test('old request records stay unknown; updated usage joins once without inventing old limits', () => {
  const current = requestAccountingContext({maxTokens:10}, worker, task, 1536, 'master');
  const fallback = requestAccountingContext({}, worker, task, 1536, 'master');
  const report = summarizeAccounting([
    {callId:'old'}, {callId:'new',...current}, {callId:'fallback',...fallback},
  ], [
    {callId:'new',...measured}, {callId:'new',...measured}, {callId:'old',inputTokens:50,outputTokens:null},
  ], []);
  assert.equal(report.calls, 3);
  assert.deepEqual(report.reportedCosts, {USD:0.01});
  assert.equal(report.knownTokens.inputTokens, 150);
  assert.equal(report.requestLimits.explicitRequestLimitCalls, 1);
  assert.equal(report.requestLimits.unspecifiedRequestLimitCalls, 1);
  assert.equal(report.requestLimits.unobservedOrInvalidRequestLimitCalls, 1);
  assert.equal(report.requestLimits.knownOutputAboveRequestedLimitCalls, 1);
  assert.equal(report.byAccountingScope.find(group => group.id === 'unknown').calls, 1);
});

test('shared coordinator history remains separate for two tickets, excludes itself and preserves immutable records', t => {
  const directory = mkdtempSync(join(tmpdir(), 'llsa-accounting-scope-'));
  const store = new CollaborationStore({stateDir:directory});
  t.after(() => { store.close(); rmSync(directory, {recursive:true,force:true}); });
  const runs = [task, {...task,id:'super-t2-a1',ticketId:'t2',rootSessionId:'worker-t2'},
    {id:'super-master-master',rootSessionId:'master',source:'dsh',ticketId:'local-master',assignmentId:'local'}];
  for (const run of runs) {
    store.createRun(run);
    store.recordRequest({callId:`call-${run.id}`,runId:run.id,agentId:run.rootSessionId});
    store.recordUsage({callId:`call-${run.id}`,runId:run.id,...measured});
  }
  const originalRequests = runs.map(run => store.listRequests(run.id));
  class Service {
    #marker = 'original-service';
    status() { return this.#marker; }
    describeRun(runId) {
      return {run:store.getRun(runId),accounting:summarizeAccounting(store.listRequests(runId),store.usageSummary(runId).usage,[])};
    }
  }
  const view = withSharedCoordinatorAccounting(new Service(), store);
  assert.equal(view.status(), 'original-service', 'facade keeps private receiver bindings');
  for (const run of runs.slice(0,2)) {
    const snapshot = view.describeRun(run.id);
    assert.equal(snapshot.accounting.calls, 1);
    assert.deepEqual(snapshot.accounting.reportedCosts, {USD:0.01});
    assert.equal(snapshot.sharedCoordinatorAccounting.calls, 1);
    assert.deepEqual(snapshot.sharedCoordinatorAccounting.reportedCosts, {USD:0.01});
    assert.deepEqual(snapshot.sharedCoordinatorAccounting.runIds, ['super-master-master']);
    assert.equal(snapshot.sharedCoordinatorAccounting.includedInSelectedRunTotals, false);
    assert.equal(snapshot.sharedCoordinatorAccounting.allocation, 'unallocated');
    assert.equal(snapshot.sharedCoordinatorAccounting.period, 'retained_history');
  }
  assert.equal(view.describeRun('super-master-master').sharedCoordinatorAccounting.calls, 0,
    'the selected coordinator run must not appear twice');
  assert.deepEqual(runs.map(run => store.listRequests(run.id)), originalRequests);
});
