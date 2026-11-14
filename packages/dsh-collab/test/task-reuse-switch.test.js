import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { CollaborationManager } from '../src/manager.js';
import { CollaborationStore } from '../src/store.js';

const runId = 'csv-switch-run';
const root = { id: 'csv-switch-coordinator' };
const source = Buffer.from('region\r\neast\r\neast\r\nwest\r\n');
const output = Buffer.from('region,count\r\neast,2\r\nwest,1\r\n');
const steps = [{ op: 'group_count', column: 'region' }];
const receipt = {
  input_rows: 3,
  output_rows: 2,
  steps: [{ op: 'group_count', input_rows: 3, output_rows: 2 }],
  checks: ['steps_verified'],
};

function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

async function until(predicate) {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    if (performance.now() > deadline) assert.fail('Work item did not reach the expected state.');
    await delay(10);
  }
}

function fixture(t, execute = async () => {}) {
  const scratchRoot = fileURLToPath(new URL('../.test-state/', import.meta.url));
  mkdirSync(scratchRoot, { recursive: true });
  const stateDir = mkdtempSync(join(scratchRoot, 'csv-switch-'));
  const started = [];
  const execution = [];
  const children = new Map();
  const backend = {
    async start(request) {
      started.push(request);
      const completion = deferred();
      children.set(request.childId, completion);
      return {
        result: completion.promise,
        async dispose() { completion.resolve({ stopReason: 'aborted', output: [] }); },
      };
    },
  };
  const csvExecutor = async request => {
    execution.push(request);
    await execute(request);
    return { output, receipt };
  };
  let store = new CollaborationStore({ stateDir });
  let manager = new CollaborationManager({ store, backend, csvExecutor });
  manager.bindRoot(root.id, { runId, ticketId: 'switch-ticket', assignmentId: 'switch-assignment' });
  t.after(async () => {
    await manager.close();
    store.close();
    const target = relative(scratchRoot, stateDir);
    assert.ok(target && !target.startsWith('..') && !isAbsolute(target));
    rmSync(stateDir, { recursive: true, force: true });
  });

  const csv = store.putArtifact(source, { mediaType: 'text/csv' });
  store.appendEvent({ runId, stepId: 'csv-input', kind: 'csv_fixture', payload: {
    artifactRef: csv.id, provenance: 'host_test_fixture',
  } });
  return {
    get manager() { return manager; },
    get store() { return store; },
    started,
    execution,
    children,
    request: {
      objective: 'Count the rows for each region.',
      inputRefs: [csv.id],
      csvWorkflow: { inputRef: csv.id, steps },
    },
    state(workItemId) {
      return store.getWorkItems(runId).find(item => item.id === workItemId)?.state;
    },
    async reopen() {
      await manager.close();
      store.close();
      store = new CollaborationStore({ stateDir });
      manager = new CollaborationManager({ store, backend, csvExecutor });
      return manager;
    },
  };
}

test('CSV opt-in leaves ordinary delegation available and preserves admitted work after opt-out', async t => {
  const entered = deferred();
  const release = deferred();
  const scenario = fixture(t, async () => {
    entered.resolve();
    await release.promise;
  });
  const { manager, store, request, started, execution } = scenario;

  assert.equal(manager.isCsvWorkflowEnabled(runId), false);
  assert.equal(manager.isToolAvailable(root.id, 'collab_csv_workflow'), false);
  await assert.rejects(manager.delegate(root, request), { code: 'CSV_WORKFLOW_DISABLED' });
  assert.deepEqual(store.getWorkItems(runId), []);
  assert.equal(execution.length, 0);

  const ordinary = await manager.delegate(root, { objective: 'Review the source independently.' });
  assert.equal(ordinary.state, 'running');
  assert.equal(started.length, 1);
  await assert.rejects(async () => manager.setCsvWorkflowEnabled(ordinary.childId, true));
  assert.equal(manager.isCsvWorkflowEnabled(runId), false);

  await manager.setCsvWorkflowEnabled(root.id, true);
  assert.equal(manager.isCsvWorkflowEnabled(runId), true);
  assert.equal(manager.isToolAvailable(root.id, 'collab_csv_workflow'), true);
  assert.equal(manager.isToolAvailable(ordinary.childId, 'collab_csv_workflow'), false);
  const pending = manager.delegate(root, { ...request, workItemId: 'local-report' });
  // Attach a handler before waiting so a regression in admission fails without an unhandled rejection.
  pending.catch(() => {});
  try {
    await Promise.race([
      entered.promise,
      pending.then(() => assert.fail('CSV execution completed without entering the executor.')),
    ]);
    assert.equal(scenario.state('local-report'), 'running');
    await manager.setCsvWorkflowEnabled(root.id, false);
    assert.equal(manager.isToolAvailable(root.id, 'collab_csv_workflow'), false);
    await assert.rejects(manager.delegate(root, request), { code: 'CSV_WORKFLOW_DISABLED' });
  } finally {
    release.resolve();
  }

  const local = await pending;
  assert.equal(local.childId, null);
  assert.equal(local.state, 'submitted');
  assert.equal(local.result.modelCalls, 0);
  assert.equal(started.length, 1);
  assert.deepEqual(execution.map(({ input, steps: executedSteps }) => [input, executedSteps]), [[source, steps]]);
  assert.deepEqual(manager.readArtifact(runId, local.result.outputArtifactRef).data, output);
  manager.accept(root.id, { workItemId: local.workItemId, accepted: true, reason: 'Verified the CSV receipt.' });
  assert.equal(scenario.state(local.workItemId), 'succeeded');
});

test('opting out cancels queued CSV work and a later opt-in does not dispatch it', async t => {
  const scenario = fixture(t);
  const { manager, request, started, children, execution } = scenario;
  await manager.setCsvWorkflowEnabled(root.id, true);
  const prerequisite = await manager.delegate(root, { objective: 'Review the source selection.' });
  const queued = await manager.delegate(root, { ...request, dependsOn: [prerequisite.workItemId] });
  assert.equal(queued.state, 'ready');
  assert.equal(execution.length, 0);

  await manager.setCsvWorkflowEnabled(root.id, false);
  assert.equal(scenario.state(queued.workItemId), 'cancelled');
  const [cancelled] = scenario.store.eventsByKind(runId, 'csv_workflow_cancelled');
  assert.equal(cancelled.stepId, queued.workItemId);
  assert.equal(cancelled.attemptId, queued.attemptId);
  assert.equal(cancelled.payload.reason, 'CSV_WORKFLOW_DISABLED');
  await manager.setCsvWorkflowEnabled(root.id, true);
  manager.publish(prerequisite.childId, { result: { confirmed: true }, final: true });
  children.get(prerequisite.childId).resolve({ stopReason: 'completed', output: [] });
  await until(() => scenario.state(prerequisite.workItemId) === 'submitted');
  manager.accept(root.id, { workItemId: prerequisite.workItemId, accepted: true, reason: 'Source confirmed.' });
  await manager.schedule(runId);
  assert.equal(scenario.state(queued.workItemId), 'cancelled');
  assert.equal(started.length, 1);
  assert.equal(execution.length, 0);
  assert.equal(scenario.store.eventsByKind(runId, 'csv_workflow_receipt').length, 0);

  await manager.setCsvWorkflowEnabled(root.id, false);
  const fallback = await manager.delegate(root, {
    objective: request.objective,
    inputRefs: request.inputRefs,
    dependsOn: [prerequisite.workItemId],
    retryOf: queued.workItemId,
  });
  assert.equal(fallback.workItemId, queued.workItemId);
  assert.notEqual(fallback.attemptId, queued.attemptId);
  assert.equal(fallback.state, 'running');
  assert.equal(started.at(-1).childId, fallback.childId);
  assert.equal(started.length, 2);
  assert.equal(execution.length, 0);
});

test('aborting the initiating tool cancels the running local CSV attempt', async t => {
  const entered = deferred();
  const scenario = fixture(t, ({ signal }) => {
    entered.resolve();
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const { manager, request, store } = scenario;
  manager.setCsvWorkflowEnabled(root.id, true);
  const controller = new AbortController();
  const task = manager.delegate(root, request, { signal: controller.signal });
  await entered.promise;
  controller.abort();
  const work = await task;
  assert.equal(work.state, 'cancelled');
  assert.equal(store.eventsByKind(runId, 'csv_workflow_receipt').length, 0);
});

test('CSV opt-in is isolated to one run and recovered from its recorded state', async t => {
  const scenario = fixture(t);
  const otherRun = 'other-csv-switch-run';
  const otherRoot = { id: 'other-csv-switch-coordinator' };
  scenario.manager.bindRoot(otherRoot.id, {
    runId: otherRun, ticketId: 'other-ticket', assignmentId: 'other-assignment',
  });
  await assert.rejects(async () => scenario.manager.setCsvWorkflowEnabled(root.id, 'true'));
  await scenario.manager.setCsvWorkflowEnabled(root.id, true);
  assert.equal(scenario.manager.isCsvWorkflowEnabled(otherRun), false);

  const reopened = await scenario.reopen();
  assert.equal(reopened.isCsvWorkflowEnabled(runId), true);
  assert.equal(reopened.isCsvWorkflowEnabled(otherRun), false);
  assert.equal(reopened.isToolAvailable(otherRoot.id, 'collab_csv_workflow'), false);
  await reopened.setCsvWorkflowEnabled(root.id, false);
  assert.equal((await scenario.reopen()).isCsvWorkflowEnabled(runId), false);
});
