import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { CollaborationManager } from '../src/manager.js';
import { CollaborationStore } from '../src/store.js';
import { createTaskReuseCsvExecutor } from '../src/task-reuse-csv.js';

const runId = 'csv-batch-run';
const root = { id: 'csv-batch-coordinator' };
const python = process.env.TASK_REUSE_PYTHON ?? 'python';
const pythonAvailable = spawnSync(python, ['--version'], { windowsHide: true, timeout: 5000 }).status === 0;
const steps = [
  { op: 'filter_eq', column: 'status', value: 'confirmed' },
  { op: 'dedupe', key: 'email', keep: 'latest_timestamp', time_column: 'updated' },
  { op: 'group_count', column: 'region' },
];
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

// Each address has a newer confirmed row, an older confirmed row and an even
// newer cancelled row. The older row comes last to distinguish timestamp from line order.
function week(eastCount) {
  const lines = ['email,status,updated,region'];
  for (let index = 0; index < 400; index++) {
    const email = `person-${index}@synthetic.invalid`;
    lines.push(
      `${email},confirmed,2026-11-02T00:00:00Z,${index < eastCount ? 'East' : 'West'}`,
      `${email},cancelled,2026-11-03T00:00:00Z,East`,
      `${email},confirmed,2026-11-01T00:00:00Z,West`,
    );
  }
  return Buffer.from(lines.join('\r\n') + '\r\n');
}

const reports = [
  { label: 'Week 1', input: week(300), expected: Buffer.from('region,count\r\nEast,300\r\nWest,100\r\n') },
  { label: 'Week 2', input: week(250), expected: Buffer.from('region,count\r\nEast,250\r\nWest,150\r\n') },
  { label: 'Week 3', input: week(200), expected: Buffer.from('region,count\r\nEast,200\r\nWest,200\r\n') },
];

function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

async function until(predicate) {
  const deadline = performance.now() + 10000;
  while (!predicate()) {
    if (performance.now() > deadline) assert.fail('Work item did not reach the expected state.');
    await delay(10);
  }
}

function fixture(t, wrapExecutor = execute => execute) {
  const scratchRoot = fileURLToPath(new URL('../.test-state/', import.meta.url));
  mkdirSync(scratchRoot, { recursive: true });
  const stateDir = mkdtempSync(join(scratchRoot, 'csv-batch-'));
  const store = new CollaborationStore({ stateDir });
  const starts = [];
  const active = new Map();
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
  };
  const executor = createTaskReuseCsvExecutor({
    enginePath: fileURLToPath(new URL('../csv-engine/run_workflow.py', import.meta.url)),
    python,
    scratchDir: join(stateDir, 'engine'),
  });
  const manager = new CollaborationManager({ store, backend, csvExecutor: wrapExecutor(executor) });
  manager.bindRoot(root.id, { runId, ticketId: 'batch-ticket', assignmentId: 'batch-assignment' });
  t.after(async () => {
    await manager.close();
    store.close();
    const target = relative(realpathSync(scratchRoot), realpathSync(stateDir));
    assert.ok(/^csv-batch-[^/\\]+$/.test(target) && !isAbsolute(target));
    rmSync(stateDir, { recursive: true, force: true });
  });
  return {
    manager, store, starts, active, stateDir,
    register(input, label) {
      const artifact = store.putArtifact(input, { mediaType: 'text/csv' });
      store.appendEvent({ runId, stepId: 'csv-input', kind: 'csv_fixture', payload: {
        artifactRef: artifact.id, provenance: 'host_test_fixture',
      } });
      return { inputRef: artifact.id, label };
    },
    state(workItemId) { return store.getWorkItems(runId).find(item => item.id === workItemId)?.state; },
  };
}

test('one native batch processes 3,600 CSV rows and hands all accepted artifacts to a dependent agent', { skip: !pythonAvailable }, async t => {
  const entered = deferred(), release = deferred();
  const scenario = fixture(t, execute => async request => {
    entered.resolve();
    await release.promise;
    return execute(request);
  });
  const { manager, store, starts, active } = scenario;
  manager.setCsvWorkflowEnabled(root.id, true);
  const sources = reports.map(({ input, label }) => scenario.register(input, label));
  const outputRefs = reports.map(({ expected }) => digest(expected));

  const batch = manager.delegateCsvBatch(root, { objective: 'Produce the three weekly regional counts.', sources, steps });
  batch.catch(() => {});
  let consumer;
  try {
    await Promise.race([entered.promise, batch.then(() => assert.fail('CSV batch finished before reaching its executor.'))]);
    const [workItem] = store.getWorkItems(runId);
    assert.equal(workItem.state, 'running');
    consumer = await manager.delegate(root, {
      objective: 'Compare the accepted weekly regional counts.',
      dependsOn: [workItem.id],
    });
    assert.equal(consumer.state, 'ready');
    assert.deepEqual(starts, []);
  } finally {
    release.resolve();
  }

  const result = await batch;
  assert.equal(result.state, 'submitted', JSON.stringify(result.result));
  assert.equal(result.childId, null);
  assert.equal(result.result.modelCalls, 0);
  assert.deepEqual(result.result.outputs.map(output => [output.label, output.outputArtifactRef]),
    reports.map(({ label }, index) => [label, outputRefs[index]]));
  const [receipt] = store.eventsByKind(runId, 'csv_workflow_receipt');
  assert.equal(receipt.attemptId, result.attemptId);
  assert.deepEqual(receipt.inputRefs, outputRefs);
  assert.deepEqual(store.getEvent(result.eventId).parents, [receipt.id]);
  for (const [index, output] of result.result.outputs.entries()) {
    const artifact = manager.readArtifact(runId, output.outputArtifactRef);
    assert.equal(artifact.mediaType, 'text/csv');
    assert.deepEqual(artifact.data, reports[index].expected);
    assert.equal(output.input_rows, 1200);
    assert.equal(output.output_rows, 2);
    assert.deepEqual(output.steps.map(step => step.output_rows), [800, 400, 2]);
    assert.ok(output.checks.includes('steps_verified'));
  }
  assert.equal(scenario.state(consumer.workItemId), 'ready');
  assert.deepEqual(starts, []);
  assert.equal(store.usageSummary(runId).calls, 0);

  manager.accept(root.id, { workItemId: result.workItemId, accepted: true, reason: 'Checked all three CSV outputs.' });
  await until(() => scenario.state(consumer.workItemId) === 'running');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].childId, consumer.childId);
  const labels = reports.map(({ label }, index) => ({ label, ref: outputRefs[index] }));
  assert.ok(starts[0].prompt.includes(JSON.stringify(labels)));
  assert.doesNotMatch(starts[0].prompt, /@synthetic\.invalid/);
  assert.deepEqual(store.eventsByKind(runId, 'delegation_input')[0].payload.inputRefs, outputRefs);
  assert.equal(manager.isToolAvailable(consumer.childId, 'collab_csv_workflow'), false);

  manager.publish(consumer.childId, { result: { eastDecline: 100, westIncrease: 100 }, final: true });
  active.get(consumer.childId).resolve({ stopReason: 'completed', output: [] });
  await until(() => scenario.state(consumer.workItemId) === 'submitted');
  manager.accept(root.id, { workItemId: consumer.workItemId, accepted: true, reason: 'Checked the comparative result.' });
  assert.equal(scenario.state(consumer.workItemId), 'succeeded');
});

test('a later CSV failure leaves no published outputs from a partially computed batch', { skip: !pythonAvailable }, async t => {
  const firstFinished = deferred();
  let firstOutput;
  const scenario = fixture(t, execute => async request => {
    if (request.input.equals(reports[0].input)) {
      try {
        const result = await execute(request);
        firstOutput = result.output;
        return result;
      } finally {
        firstFinished.resolve();
      }
    }
    await firstFinished.promise;
    return execute(request);
  });
  const { manager, store, starts } = scenario;
  manager.setCsvWorkflowEnabled(root.id, true);
  const sources = [
    scenario.register(reports[0].input, 'Valid first week'),
    scenario.register(Buffer.from('email,status,updated\r\none@synthetic.invalid,confirmed,2026-11-02T00:00:00Z\r\n'), 'Missing region'),
  ];
  const result = await manager.delegateCsvBatch(root, { objective: 'Process both weekly reports.', sources, steps });

  assert.deepEqual(firstOutput, reports[0].expected);
  assert.equal(result.state, 'failed');
  assert.equal(result.childId, null);
  assert.equal(result.result.sourceLabel, 'Missing region');
  assert.equal(result.result.ruleCode, 'unknown_column');
  assert.deepEqual(starts, []);
  assert.equal(store.eventsByKind(runId, 'final_result').length, 0);
  assert.equal(store.eventsByKind(runId, 'csv_workflow_receipt').length, 0);
  assert.throws(() => store.getArtifact(digest(firstOutput)), { code: 'ARTIFACT_NOT_FOUND' });
  assert.throws(() => manager.accept(root.id, { workItemId: result.workItemId, accepted: true, reason: 'No verified outputs.' }),
    { code: 'INVALID_STATE' });
});

test('stopping a running CSV batch aborts its active source and publishes no partial output', { skip: !pythonAvailable }, async t => {
  const entered = deferred(), release = deferred();
  let firstOutput, activeSignal;
  const scenario = fixture(t, execute => async request => {
    if (request.input.equals(reports[0].input)) {
      const result = await execute(request);
      firstOutput = result.output;
      return result;
    }
    assert.ok(request.signal, 'A running source must receive the batch abort signal.');
    activeSignal = request.signal;
    const aborted = deferred();
    activeSignal.addEventListener('abort', aborted.resolve, { once: true });
    entered.resolve();
    try {
      await Promise.race([aborted.promise, release.promise]);
      activeSignal.throwIfAborted();
      assert.fail('The active source was released without a cancellation signal.');
    } finally {
      activeSignal.removeEventListener('abort', aborted.resolve);
    }
  });
  const { manager, store, starts } = scenario;
  manager.setCsvWorkflowEnabled(root.id, true);
  const sources = reports.slice(0, 2).map(({ input, label }) => scenario.register(input, label));
  const batch = manager.delegateCsvBatch(root, { objective: 'Process the two weekly reports.', sources, steps });
  batch.catch(() => {});
  try {
    await Promise.race([entered.promise, batch.then(() => assert.fail('Batch stopped before its second source ran.'))]);
    assert.deepEqual(firstOutput, reports[0].expected);
    const [workItem] = store.getWorkItems(runId);
    assert.equal(workItem.state, 'running');
    await manager.interruptCsvWorkItem(runId, workItem.id);
  } finally {
    release.resolve();
  }

  assert.equal((await batch).state, 'cancelled');
  assert.equal(activeSignal.aborted, true);
  assert.equal(store.eventsByKind(runId, 'final_result').length, 0);
  assert.equal(store.eventsByKind(runId, 'csv_workflow_receipt').length, 0);
  assert.throws(() => store.getArtifact(digest(firstOutput)), { code: 'ARTIFACT_NOT_FOUND' });
  assert.deepEqual(starts, []);
});

test('a disabled CSV batch does not affect ordinary delegation', async t => {
  const scenario = fixture(t, () => () => assert.fail('The disabled batch reached the executor.'));
  const { manager, store, starts } = scenario;
  const sources = reports.slice(0, 2).map(({ input, label }) => scenario.register(input, label));
  assert.equal(manager.isCsvWorkflowEnabled(runId), false);
  await assert.rejects(manager.delegateCsvBatch(root, { objective: 'Process two weekly reports.', sources, steps }),
    { code: 'CSV_WORKFLOW_DISABLED' });
  assert.deepEqual(store.getWorkItems(runId), []);
  assert.deepEqual(starts, []);

  const ordinary = await manager.delegate(root, { objective: 'Discuss the accepted review criteria.' });
  assert.equal(ordinary.state, 'running');
  assert.equal(starts[0].childId, ordinary.childId);
});

test('the configured coordinator tool binds labelled CSV paths from its workspace', { skip: !pythonAvailable }, async t => {
  const { createCsvWorkflowHandler, csvWorkflowSchema } = await import('../src/csv-workflow-tool.js');
  const { manager, store, starts, stateDir } = fixture(t);
  const csvWorkspace = join(stateDir, 'sources');
  mkdirSync(csvWorkspace);
  const selected = reports.slice(0, 2);
  const sources = selected.map(({ input, label }, index) => {
    const path = `week-${index + 1}.csv`;
    writeFileSync(join(csvWorkspace, path), input);
    return { label, path };
  });
  const handler = createCsvWorkflowHandler({ manager, csvWorkspace });
  manager.setCsvWorkflowEnabled(root.id, true);
  const request = csvWorkflowSchema.parse({ mode: 'batch', objective: 'Produce two regional reports.', sources, steps });
  const result = await handler(root, request);

  assert.equal(result.state, 'submitted', JSON.stringify(result.result));
  assert.equal(result.childId, null);
  assert.deepEqual(result.result.outputs, selected.map(({ label, expected }) => ({
    label, outputArtifactRef: digest(expected), input_rows: 1200, output_rows: 2,
  })));
  const [receipt] = store.eventsByKind(runId, 'csv_workflow_receipt');
  assert.deepEqual(receipt.payload.result.outputs.map(output => output.inputRef), selected.map(({ input }) => digest(input)));
  assert.ok(receipt.payload.result.outputs.every(output => output.steps.length === steps.length));
  assert.deepEqual(starts, []);
});
