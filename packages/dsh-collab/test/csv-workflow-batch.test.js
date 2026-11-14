import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTaskReuseCsvExecutor } from '../src/task-reuse-csv.js';
import { runCsvBatch, validateCsvBatch } from '../src/csv-workflow-batch.js';

const refFor = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const plan = [{ op: 'filter_eq', column: 'active', value: 'yes' }, { op: 'group_count', column: 'region' }];
const first = Buffer.from('active,region\r\nyes,north\r\nno,south\r\nyes,north\r\n');
const second = Buffer.from('active,region\r\nyes,west\r\n');
const firstRef = refFor(first), secondRef = refFor(second);
const inputs = [{ label: 'week 1', inputRef: firstRef }, { label: 'week 2', inputRef: secondRef }];
const python = process.env.TASK_REUSE_PYTHON ?? 'python';
const pythonAvailable = spawnSync(python, ['--version'], { windowsHide: true, timeout: 5000 }).status === 0;

test('batch returns verified CSVs in label order and reuses byte-identical snapshots', { skip: !pythonAvailable }, async t => {
  const testState = fileURLToPath(new URL('../.test-state/', import.meta.url));
  await mkdir(testState, { recursive: true });
  const root = await realpath(testState);
  const scratchDir = await mkdtemp(join(root, 'csv-batch-'));
  t.after(async () => {
    assert.equal(dirname(scratchDir), root);
    assert.match(basename(scratchDir), /^csv-batch-[A-Za-z0-9]+$/u);
    assert.equal(relative(scratchDir, await realpath(scratchDir)), '');
    await rm(scratchDir, { recursive: true, force: true });
  });
  const execute = createTaskReuseCsvExecutor({
    enginePath: fileURLToPath(new URL('../csv-engine/run_workflow.py', import.meta.url)),
    scratchDir,
    python,
  });
  const reads = [], executions = [];
  const sources = [inputs[0], { label: 'week 1 copy', inputRef: firstRef }, inputs[1]];
  const batch = await runCsvBatch({
    sources,
    steps: plan,
    readArtifact(ref) {
      reads.push(ref);
      return { data: ref === firstRef ? first : second, mediaType: 'text/csv' };
    },
    async csvExecutor(request) {
      executions.push(refFor(request.input));
      return execute(request);
    },
    assertCurrent() {},
  });
  assert.deepEqual(reads, [firstRef, secondRef]);
  assert.deepEqual(executions, [firstRef, secondRef]);
  assert.deepEqual(batch.map(item => item.label), ['week 1', 'week 1 copy', 'week 2']);
  assert.deepEqual(batch.map(item => item.output.toString()), ['region,count\r\nnorth,2\r\n', 'region,count\r\nnorth,2\r\n', 'region,count\r\nwest,1\r\n']);
  assert.deepEqual(batch.map(item => item.receipt.input_rows), [3, 3, 1]);
  assert.ok(batch.every(item => item.receipt.checks.includes('steps_verified')));
});

test('batch validates all input media and size before running any transformation', async () => {
  let executions = 0;
  const base = {
    steps: plan,
    csvExecutor() { executions++; },
    assertCurrent() {},
  };
  await assert.rejects(runCsvBatch({
    ...base,
    sources: inputs,
    readArtifact: ref => ({ data: first, mediaType: ref === firstRef ? 'text/csv' : 'text/plain' }),
  }), { code: 'INVALID_CSV_BATCH', sourceLabel: 'week 2' });

  const large = Buffer.alloc(12 * 1024 * 1024);
  await assert.rejects(runCsvBatch({
    ...base,
    sources: [...inputs, { label: 'week 3', inputRef: refFor('fixture-3') }],
    readArtifact: () => ({ data: large, mediaType: 'text/csv' }),
  }), { code: 'CSV_BATCH_INPUT_TOO_LARGE', sourceLabel: 'week 3' });
  assert.equal(executions, 0);
});

test('batch stops at the current attempt boundary without returning partial results', async () => {
  const steps = [{ op: 'group_count', column: 'region' }];
  let stale = false, executions = 0;
  await assert.rejects(runCsvBatch({
    sources: inputs,
    steps,
    readArtifact: () => ({ data: first, mediaType: 'text/csv' }),
    async csvExecutor({ steps: boundSteps }) {
      executions++;
      steps[0].column = 'changed by caller';
      assert.equal(boundSteps[0].column, 'region');
      stale = true;
      return { output: Buffer.from('region,count\r\nnorth,2\r\n'), receipt: {
        input_rows: 3, output_rows: 1, steps: [{ op: 'group_count', input_rows: 3, output_rows: 1 }],
        checks: ['steps_verified'],
      } };
    },
    assertCurrent() {
      if (stale) throw Object.assign(new Error('Old attempt'), { code: 'STALE_ATTEMPT' });
    },
  }), { code: 'STALE_ATTEMPT' });
  assert.equal(executions, 1);
});

test('batch contract rejects ambiguous labels and workspace paths', () => {
  const sources = [{ label: ' 第1周 ', inputRef: firstRef }, { label: '第2周', inputRef: firstRef }];
  assert.deepEqual(validateCsvBatch(sources, plan).sources.map(source => source.label), ['第1周', '第2周']);
  assert.throws(() => validateCsvBatch([sources[0], { ...sources[1], label: '第1周' }], plan), { code: 'INVALID_CSV_BATCH' });
  assert.throws(() => validateCsvBatch([sources[0], { ...sources[1], inputRef: './week2.csv' }], plan), { code: 'INVALID_CSV_BATCH' });
});
