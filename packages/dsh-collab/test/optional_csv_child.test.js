import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runAgentCsvStep } from '../src/csv-agent-step.js';
import { canonicalHash } from '../src/computation.js';
import { CollaborationManager } from '../src/manager.js';
import { CollaborationStore } from '../src/store.js';
import { createTaskReuseCsvExecutor } from '../src/task-reuse-csv.js';

const artifactId = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const project = new URL('../../../', import.meta.url);
const python = process.env.TASK_REUSE_PYTHON ?? 'python';
const pythonAvailable = spawnSync(python, ['--version'], { windowsHide: true, timeout: 5000 }).status === 0;

async function scratch() {
  const root = fileURLToPath(new URL('../.test-state/', import.meta.url)).replace(/[\\/]$/u, '');
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, 'optional-child-'));
  return { dir, async cleanup() {
    assert.equal(dirname(dir), root);
    assert.match(basename(dir), /^optional-child-/u);
    await rm(dir, { recursive: true, force: true });
  } };
}

function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

function fixture(source, { mediaType = 'text/csv' } = {}) {
  const inputRef = artifactId(source);
  const binding = { id: 'child-a', parentId: 'root-a', runId: 'run-a', workItemId: 'work-a', attemptId: 'attempt-a' };
  const item = { id: binding.workItemId, childId: binding.id, runId: binding.runId,
    attemptId: binding.attemptId, inputRefs: [inputRef], state: 'running' };
  const artifacts = new Map();
  const events = [];
  const store = {
    putArtifact(bytes, options) {
      const id = artifactId(bytes);
      artifacts.set(id, { bytes: Buffer.from(bytes), mediaType: options.mediaType });
      return { id };
    },
    appendEvent(event) {
      const saved = { id: 'event-' + (events.length + 1), ...event };
      events.push(saved);
      return saved;
    },
  };
  const readArtifact = (runId, ref) => {
    assert.equal(runId, binding.runId);
    assert.equal(ref, inputRef);
    return { data: source, mediaType };
  };
  return { inputRef, binding, item, store, artifacts, events, readArtifact, assertCurrent() {} };
}

test('a child runs fused CSV steps and receives only host evidence, leaving final acceptance unchanged', { skip: !pythonAvailable }, async t => {
  const source = await readFile(new URL('examples/csv-workflow/workflow-next.csv', project));
  const steps = JSON.parse(await readFile(new URL('examples/csv-workflow/workflow-steps.json', project), 'utf8'));
  const state = await scratch();
  t.after(state.cleanup);
  const csvExecutor = createTaskReuseCsvExecutor({
    enginePath: fileURLToPath(new URL('packages/dsh-collab/csv-engine/run_workflow.py', project)),
    python,
    scratchDir: state.dir,
  });
  const scoped = fixture(source);
  const result = await runAgentCsvStep({ ...scoped, steps, csvExecutor });
  const expected = Buffer.from('地区,count\r\n东区,2\r\n南区,1\r\n');
  assert.equal(result.outputArtifactRef, artifactId(expected));
  assert.deepEqual(scoped.artifacts.get(result.outputArtifactRef), { bytes: expected, mediaType: 'text/csv' });
  assert.equal(result.modelCalls, 0);
  assert.equal(result.output_rows, 2);
  assert.equal(result.steps.length, 3);
  assert.doesNotMatch(JSON.stringify(result), /@/u);
  assert.deepEqual(scoped.item.inputRefs, [scoped.inputRef]);
  assert.equal(scoped.item.state, 'running');
  assert.equal(scoped.events.length, 1);
  const [event] = scoped.events;
  assert.equal(event.id, result.eventId);
  assert.equal(event.kind, 'csv_workflow_receipt');
  assert.equal(event.runId, scoped.binding.runId);
  assert.equal(event.stepId, scoped.item.id);
  assert.equal(event.attemptId, scoped.item.attemptId);
  assert.equal(event.payload.actorId, scoped.binding.id);
  assert.equal(event.payload.artifactRef, result.outputArtifactRef);
  assert.equal(event.payload.contractHash, canonicalHash({ inputRef: scoped.inputRef, steps }));
});

test('a child rejects paths, unassigned artifacts and incompatible input before execution', async () => {
  let calls = 0;
  const csvExecutor = () => { calls++; throw new Error('Unexpected execution'); };
  const source = Buffer.from('group\na\n');
  const scoped = fixture(source);
  const steps = [{ op: 'group_count', column: 'group' }];
  for (const inputRef of ['input.csv', artifactId(Buffer.from('other work item'))]) {
    await assert.rejects(runAgentCsvStep({ ...scoped, inputRef, steps, csvExecutor }), { code: 'FORBIDDEN' });
  }
  const json = fixture(source, { mediaType: 'application/json' });
  await assert.rejects(runAgentCsvStep({ ...json, steps, csvExecutor }), { code: 'INVALID_CSV_WORKFLOW' });
  assert.equal(calls, 0);
  assert.deepEqual(scoped.events, []);
  assert.deepEqual(json.events, []);
});

test('stale asynchronous execution discards its output and keeps the original steps bound', async () => {
  const scoped = fixture(Buffer.from('group\na\n'));
  const steps = [{ op: 'group_count', column: 'group' }];
  let release;
  const running = new Promise(resolve => { release = resolve; });
  let current = true;
  let receivedSteps;
  const pending = runAgentCsvStep({ ...scoped, steps,
    assertCurrent() {
      if (!current) throw Object.assign(new Error('Input changed'), { code: 'STALE_INPUT' });
    },
    csvExecutor: ({ steps: bound }) => {
      receivedSteps = bound;
      return running;
    },
  });
  steps[0].column = 'different';
  assert.deepEqual(receivedSteps, [{ op: 'group_count', column: 'group' }]);
  current = false;
  release({ output: Buffer.from('group,count\na,1\n'),
    receipt: { input_rows: 1, output_rows: 1, steps: [], checks: [] } });
  await assert.rejects(pending, { code: 'STALE_INPUT' });
  assert.equal(scoped.artifacts.size, 0);
  assert.deepEqual(scoped.events, []);
});

test('an existing manager child follows the run switch and finishes admitted CSV work in its original attempt', { skip: !pythonAvailable }, async t => {
  const state = await scratch();
  const store = new CollaborationStore({ stateDir: state.dir });
  const entered = deferred();
  const release = deferred();
  const settlements = new Map();
  const starts = [];
  const executor = createTaskReuseCsvExecutor({
    enginePath: fileURLToPath(new URL('packages/dsh-collab/csv-engine/run_workflow.py', project)),
    python,
    scratchDir: join(state.dir, 'engine'),
  });
  const manager = new CollaborationManager({
    store,
    backend: {
      async start(request) {
        starts.push(request);
        const settlement = deferred();
        settlements.set(request.childId, settlement);
        return { result: settlement.promise, dispose() { settlement.resolve({ stopReason: 'aborted', output: [] }); } };
      },
    },
    csvExecutor: async request => {
      entered.resolve();
      await release.promise;
      return executor(request);
    },
  });
  t.after(async () => {
    await manager.close();
    store.close();
    await state.cleanup();
  });

  const root = { id: 'manager-parent' };
  const runId = manager.bindRoot(root.id).runId;
  const input = store.putArtifact(Buffer.from('group\r\na\r\na\r\nb\r\n'), { mediaType: 'text/csv' });
  store.appendEvent({ runId, stepId: 'csv-input', kind: 'csv_fixture', payload: { artifactRef: input.id } });
  manager.setCsvWorkflowEnabled(root.id, true);
  const child = await manager.delegate(root, {
    objective: 'Count by group',
    inputRefs: [input.id],
    csvStepAllowed: true,
  });
  const childId = child.childId;
  const args = { inputRef: input.id, steps: [{ op: 'group_count', column: 'group' }] };
  const work = () => store.getWorkItems(runId).find(item => item.id === child.workItemId);
  manager.setCsvWorkflowEnabled(root.id, false);
  assert.equal(manager.isToolAvailable(childId, 'collab_csv_workflow'), false);
  await assert.rejects(manager.runCsvStep(childId, args), { code: 'CSV_WORKFLOW_DISABLED' });

  manager.setCsvWorkflowEnabled(root.id, true);
  assert.equal(manager.isToolAvailable(childId, 'collab_csv_workflow'), true);
  const pending = manager.runCsvStep(childId, args);
  try {
    await Promise.race([entered.promise, pending]);
    manager.setCsvWorkflowEnabled(root.id, false);
    assert.equal(manager.isToolAvailable(childId, 'collab_csv_workflow'), false);
    await assert.rejects(manager.runCsvStep(childId, args), { code: 'CSV_WORKFLOW_DISABLED' });
  } finally {
    release.resolve();
  }
  const result = await pending;
  const event = store.getEvent(result.eventId);
  assert.equal(event.stepId, child.workItemId);
  assert.equal(event.attemptId, child.attemptId);
  assert.equal(event.payload.actorId, childId);
  assert.equal(manager.readArtifact(runId, result.outputArtifactRef).data.toString(), 'group,count\r\na,2\r\nb,1\r\n');
  assert.equal(work().state, 'running');
  assert.equal(starts.length, 1);
  assert.throws(() => manager.accept(root.id, { workItemId: child.workItemId, accepted: true, reason: 'Too soon.' }),
    { code: 'INVALID_STATE' });

  const published = manager.publish(childId, { result: { outputArtifactRef: result.outputArtifactRef }, final: true, parents: [result.eventId] });
  assert.equal(published.submitted, true);
  const settled = manager.settlements.get(childId);
  settlements.get(childId).resolve({ stopReason: 'completed', output: [] });
  await settled;
  assert.equal(work().state, 'submitted');
  const accepted = manager.accept(root.id, { workItemId: child.workItemId, accepted: true,
    reason: 'Checked the counts and output reference.', evidenceRefs: [result.outputArtifactRef] });
  assert.equal(accepted.state, 'succeeded');
  assert.equal(starts.length, 1);

  manager.setCsvWorkflowEnabled(root.id, true);
  const reader = await manager.delegate(root, { objective: 'Interpret the grouped counts', inputRefs: [result.outputArtifactRef] });
  assert.equal(reader.state, 'running');
  assert.equal(manager.isToolAvailable(reader.childId, 'collab_csv_workflow'), false);
  await assert.rejects(manager.runCsvStep(reader.childId, { ...args, inputRef: result.outputArtifactRef }),
    { code: 'FORBIDDEN' });
});
