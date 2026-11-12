import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeAccounting } from '../src/accounting.js';
import { computationSchema } from '../src/computation-schema.js';

test('coverage includes interrupted requests, preserves grouping and never invents charges', () => {
  const requests = [{callId:'a', agentId:'parent', workItemId:'root', purpose:'agent'},
    {callId:'b', agentId:'child', workItemId:'w', purpose:'compaction'}, {callId:'c', workItemId:'w'}];
  const usage = [{callId:'a', inputTokens:100, cachedInputTokens:80, uncachedInputTokens:20, cacheWriteTokens:0, outputTokens:5},
    {callId:'b', inputTokens:50, outputTokens:null}];
  const report = summarizeAccounting(requests, usage, []);
  assert.equal(report.calls, 3);
  assert.equal(report.usageCoverage, 1/3);
  assert.equal(report.unknownUsageCalls, 2);
  assert.equal(report.cacheHitRateOnCompleteCalls, .8);
  assert.equal(report.byWorkItem.find(g => g.id === 'w').calls, 2);
  assert.equal(report.byPurpose.find(g => g.id === 'compaction').unknownUsageCalls, 1);
  assert.equal(report.unreportedCostCalls, 3);
  assert.deepEqual(report.reportedCosts, {});
  assert.equal(summarizeAccounting([], [], []).usageCoverage, null);
});

test('retry metrics retain history, deduplicate attempts and do not double-count invalidation', () => {
  const planned = (attemptId, payload={}) => ({kind:'work_planned', stepId:'w', attemptId, payload});
  const events = [planned('1'), {kind:'input_invalidated',stepId:'w',attemptId:'1'},
    planned('2',{retryOfAttemptId:'1',retryReason:'input_changed'}),
    planned('2',{retryOfAttemptId:'1',retryReason:'input_changed'}), planned('3')];
  const report = summarizeAccounting([], [], events).rework;
  assert.equal(report.initialAssignments, 1);
  assert.equal(report.attempts, 3);
  assert.equal(report.retries, 2);
  assert.equal(report.invalidatedAttempts, 1);
  assert.deepEqual(report.reasons, {input_changed:1, unknown:1});
  assert.equal(report.retriesPerInitialAssignment, 2);
});

const contract = {version:'3',inputRef:'sha256:test',rowsPath:[],filter:[],precision:'safe_integer',nullPolicy:'reject',deduplicate:false,
  operations:[{op:'at',index:0,as:'first',unit:'row',filter:[]}]};
test('contract validation selects one version and operation without unrelated union errors', () => {
  assert.deepEqual(computationSchema.parse(contract), contract);
  for (const op of ['argmin','argmax']) assert.ok(computationSchema.safeParse({...contract,version:'2',operations:[{op,field:'n',fields:['n'],tie:'first',empty:'null',as:'a',unit:'row',filter:[]}]}).success);
  for (const version of ['1','2']) assert.equal(computationSchema.safeParse({...contract,version}).success, false);
  const invalid = computationSchema.safeParse({...contract,operations:[{...contract.operations[0],index:-1}]});
  assert.equal(invalid.success,false);
  assert.equal(invalid.error.issues.length,1);
  assert.deepEqual(invalid.error.issues[0].path,['operations',0,'index']);
  assert.ok(invalid.error.message.length < 600);
  const wrongOperation = computationSchema.safeParse({...contract,operations:[{...contract.operations[0],op:'lookup'}]});
  assert.equal(wrongOperation.success,false);
  assert.deepEqual(wrongOperation.error.issues[0].path,['operations',0,'op']);
  assert.ok(wrongOperation.error.message.length < 600);
  assert.equal(computationSchema.safeParse({...contract,unexpected:true}).success,false);
});
