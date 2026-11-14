import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { CollaborationManager } from '../src/manager.js';
import { CollaborationStore } from '../src/store.js';
import { createTaskReuseCsvExecutor } from '../src/task-reuse-csv.js';

const runId = 'csv-benchmark';
const project = new URL('../../../', import.meta.url);
const source = readFileSync(new URL('examples/csv-workflow/workflow-next.csv', project));
const steps = JSON.parse(readFileSync(new URL('examples/csv-workflow/workflow-steps.json', project), 'utf8'));
const expected = Buffer.from('地区,count\r\n东区,2\r\n南区,1\r\n');
const python = process.env.TASK_REUSE_PYTHON ?? 'python';
const pythonAvailable = spawnSync(python, ['--version'], { windowsHide: true, timeout: 5000 }).status === 0;

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

function fixture(t, wrapExecutor = execute => execute) {
  const scratchRoot = fileURLToPath(new URL('../.test-state/', import.meta.url));
  mkdirSync(scratchRoot, { recursive: true });
  const stateDir = mkdtempSync(join(scratchRoot, 'csv-workflow-'));
  const store = new CollaborationStore({ stateDir });
  const active = new Map();
  const starts = [];
  const backend = {
    async start(request) {
      starts.push(request);
      const completion = deferred();
      active.set(request.childId, completion);
      return {
        result: completion.promise,
        async dispose() { completion.resolve({ stopReason: 'aborted', output: [] }); },
      };
    },
    getAgent(id) { return { id }; },
    modelProfile() { return 'test-unverified'; },
    async deliver({ messageId }) { return { messageId, accepted: true }; },
  };
  const executor = createTaskReuseCsvExecutor({
    enginePath: fileURLToPath(new URL('packages/dsh-collab/csv-engine/run_workflow.py', project)),
    python,
    scratchDir: join(stateDir, 'engine'),
  });
  const manager = new CollaborationManager({ store, backend, csvExecutor: wrapExecutor(executor) });
  const root = { id: 'coordinator' };
  manager.bindRoot(root.id, { runId, ticketId: 'csv-ticket', assignmentId: 'csv-assignment' });
  manager.setCsvWorkflowEnabled(root.id, true);
  t.after(async () => {
    await manager.close();
    store.close();
    const target = relative(scratchRoot, stateDir);
    assert.ok(target && !target.startsWith('..') && !isAbsolute(target));
    rmSync(stateDir, { recursive: true, force: true });
  });
  return { manager, root, store, executor, starts, active };
}

function registerCsv(store, bytes, stepId) {
  const artifact = store.putArtifact(bytes, { mediaType: 'text/csv' });
  store.appendEvent({ runId, stepId, kind: 'csv_fixture', payload: {
    artifactRef: artifact.id, provenance: 'host_test_fixture',
  } });
  return artifact.id;
}

function state(fixture, workItemId) {
  return fixture.store.getWorkItems(runId).find(item => item.id === workItemId)?.state;
}

async function finishChild(fixture, child, result) {
  const { manager, root, active } = fixture;
  manager.publish(child.childId, { result, final: true });
  active.get(child.childId).resolve({ stopReason: 'completed', output: [] });
  await until(() => state(fixture, child.workItemId) === 'submitted');
  manager.accept(root.id, { workItemId: child.workItemId, accepted: true, reason: 'Checked the expected result.' });
}

async function workerBaseline(t, batches) {
  const scenario = fixture(t);
  const { manager, root, store, executor, starts } = scenario;
  let ref = registerCsv(store, source, 'csv-input');
  let prerequisite;
  for (const [index, batch] of batches.entries()) {
    const child = await manager.delegate(root, {
      objective: 'Run the supplied CSV steps.',
      inputRefs: [ref],
      dependsOn: prerequisite ? [prerequisite] : [],
    });
    // This is a scripted worker. The real Python executor keeps both baselines on the same CSV semantics.
    const { output } = await executor({ input: manager.readArtifact(runId, ref).data, steps: batch });
    ref = registerCsv(store, output, `worker-output-${index}`);
    await finishChild(scenario, child, { outputArtifactRef: ref });
    prerequisite = child.workItemId;
  }
  const consumer = await manager.delegate(root, {
    objective: 'Read the accepted regional report and explain its two counts.',
    inputRefs: [ref],
    dependsOn: [prerequisite],
  });
  assert.ok(starts.at(-1).prompt.includes(ref));
  const output = manager.readArtifact(runId, ref).data;
  await finishChild(scenario, consumer, { east: 2, south: 1 });
  return { output, childActivations: starts.length };
}

test('one local CSV node replaces scripted preprocessing workers and feeds an ordinary child', { skip: !pythonAvailable }, async t => {
  const sequential = await workerBaseline(t, steps.map(step => [step]));
  const batchedWorker = await workerBaseline(t, [steps]);

  const gate = deferred();
  const integrated = fixture(t, execute => async request => {
    await gate.promise;
    return execute(request);
  });
  t.after(() => gate.resolve());
  const { manager, root, store, starts } = integrated;
  const inputRef = registerCsv(store, source, 'csv-input');
  const local = manager.delegate(root, {
    workItemId: 'local-csv',
    objective: 'Run the three confirmed CSV steps locally.',
    inputRefs: [inputRef],
    csvWorkflow: { inputRef, steps },
  });
  let consumer;
  try {
    await until(() => state(integrated, 'local-csv') === 'running');
    consumer = await manager.delegate(root, {
      objective: 'Read the accepted regional report and explain its two counts.',
      dependsOn: ['local-csv'],
    });
    assert.equal(consumer.state, 'ready');
    assert.equal(starts.length, 0);
  } finally {
    gate.resolve();
  }

  const result = await local;
  assert.equal(result.childId, null);
  assert.equal(result.state, 'submitted');
  assert.equal(result.result.modelCalls, 0);
  assert.equal(starts.length, 0, 'publication alone must not dispatch the dependent child');
  const ref = result.result.outputArtifactRef;
  const artifact = manager.readArtifact(runId, ref);
  assert.equal(artifact.mediaType, 'text/csv');
  assert.deepEqual(artifact.data, expected);
  assert.deepEqual(artifact.data, sequential.output);
  assert.deepEqual(artifact.data, batchedWorker.output);
  assert.equal(ref, 'sha256:' + createHash('sha256').update(expected).digest('hex'));
  assert.equal(result.result.input_rows, 5);
  assert.equal(result.result.output_rows, 2);
  assert.deepEqual(result.result.steps.map(step => step.output_rows), [4, 3, 2]);
  assert.ok(result.result.checks.includes('steps_verified'));
  const [receipt] = store.eventsByKind(runId, 'csv_workflow_receipt');
  assert.equal(receipt.payload.inputRef, inputRef);
  assert.equal(receipt.payload.artifactRef, ref);
  assert.equal(receipt.attemptId, result.attemptId);
  assert.ok(store.getEvent(result.eventId).parents.includes(receipt.id));

  manager.accept(root.id, { workItemId: result.workItemId, accepted: true, reason: 'Checked the CSV receipt.' });
  await until(() => starts.some(start => start.childId === consumer.childId));
  assert.equal(starts.length, 1);
  const [dispatch] = store.eventsByKind(runId, 'delegation_input');
  assert.deepEqual(dispatch.payload.inputRefs, [ref]);
  assert.ok(starts[0].prompt.includes(ref));
  assert.ok(!starts[0].prompt.includes('example.invalid'));
  await finishChild(integrated, consumer, { east: 2, south: 1 });
  assert.equal(state(integrated, consumer.workItemId), 'succeeded');
  assert.deepEqual([sequential.childActivations, batchedWorker.childActivations, starts.length], [4, 2, 1]);
  assert.equal(store.usageSummary(runId).calls, 0);
  t.diagnostic('Byte-identical CSV in all paths. Scripted child activations: sequential 4, batched worker 2, local CSV plus downstream worker 1.');
});

test('CSV input belongs to the current run and invalidated work cannot publish', async t => {
  const gate = deferred();
  let activeSignal;
  const scenario = fixture(t, () => ({ signal }) => { activeSignal = signal; return gate.promise; });
  t.after(() => gate.resolve({ output: expected, receipt: { input_rows: 5, output_rows: 2 } }));
  const { manager, root, store, starts } = scenario;
  const foreign = store.putArtifact(source, { mediaType: 'text/csv' });
  await assert.rejects(manager.delegate(root, {
    objective: 'Use a CSV not registered for this run.',
    inputRefs: [foreign.id],
    csvWorkflow: { inputRef: foreign.id, steps },
  }), { code: 'FORBIDDEN' });

  const inputRef = registerCsv(store, source, 'csv-input');
  const pending = manager.delegate(root, {
    workItemId: 'stale-local-csv',
    objective: 'Finish this CSV only while its task input version is current.',
    inputRefs: [inputRef],
    csvWorkflow: { inputRef, steps },
  });
  try {
    await until(() => state(scenario, 'stale-local-csv') === 'running');
    const text = JSON.stringify({ sources: [{ id: 'replacement', text: 'Updated source.' }] });
    manager.syncNativeInput(runId, { text, version: createHash('sha256').update(text).digest('hex') });
    assert.equal(activeSignal.aborted, true);
  } finally {
    gate.resolve({ output: expected, receipt: { input_rows: 5, output_rows: 2 } });
  }
  assert.equal((await pending).state, 'rejected');
  assert.equal(store.eventsByKind(runId, 'csv_workflow_receipt').length, 0);
  assert.equal(store.eventsByKind(runId, 'final_result').length, 0);
  assert.equal(starts.length, 0);
  assert.throws(() => manager.accept(root.id, {
    workItemId: 'stale-local-csv', accepted: true, reason: 'This input has already been replaced.',
  }), { code: 'STALE_INPUT' });
});
