/** Run Task Reuse through the installed DeepSeek Harness with a scripted provider. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url);
const project = resolve(dirname(script), '../..');
const namespace = 'mcp__task_reuse__';
const tool = `${namespace}process_csv`;
const pipelineTool = `${namespace}run_csv_pipeline`;
const reviewTool = `${namespace}review_csv`;
const originalTools = ['inspect_csv', 'preview_recipe', 'run_recipe'].map(name => `${namespace}${name}`);
const provider = 'task-reuse-fixture';
const summary = 'Task Reuse keyless round trip complete.';

export const name = 'task-reuse-test-fixture';
export const inject = ['llm', 'agents'];

function artifactReference(workspace, receipt) {
  const path = receipt.output_ref;
  assert.match(path, /^task-reuse-output\/[0-9a-f]{64}\.csv$/);
  assert.equal(resolve(workspace, path), resolve(receipt.output_path));
  return path;
}

function ptcProgram(args, sequential) {
  const batches = sequential ? args.steps.map(step => [step]) : [args.steps];
  return `let path = ${JSON.stringify(args.path)};
let receipt;
for (const steps of ${JSON.stringify(batches)}) {
  receipt = (await tools.${pipelineTool}({ path, steps })).structuredContent;
  if (receipt?.status !== 'completed') throw new Error('Pipeline step failed');
  path = receipt.output_ref;
}
return receipt;`;
}

export async function apply(ctx) {
  const require = createRequire(realpathSync(process.env.TASK_REUSE_SMOKE_DSH_ENTRY));
  const { LlmAdapter } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href);
  const testCase = JSON.parse(process.env.TASK_REUSE_SMOKE_CASE);
  let requests = 0;
  let toolCalls = 0;
  let toolSchemaBytes;
  const pipeline = testCase.pipeline;
  const review = testCase.review;
  let reviewReport;
  let messagesAndToolsBytes = 0;
  let firstRequest;

  function* toolCall(name, args) {
    toolCalls += 1;
    const block = { type: 'tool-call', id: `task-reuse-fixture-call-${toolCalls}`, name, arguments: JSON.stringify(args) };
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 0, id: block.id, name: name, argumentsDelta: block.arguments };
    yield { type: 'block-end', index: 0, block };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  }

  class FixtureAdapter extends LlmAdapter {
    async resolveModel(route, model) {
      return { provider: route, id: model, name: model, defaultMaxTokens: 1024, inputModalities: ['text'] };
    }

    async *stream(options) {
      assert.equal(options.provider, provider);
      firstRequest ??= performance.now();
      requests += 1;
      messagesAndToolsBytes += Buffer.byteLength(JSON.stringify({ messages: options.messages, tools: options.tools }));
      if (requests === 1) {
        if (testCase.ptc) {
          assert.deepEqual(options.tools.map(entry => entry.name), ['run_code']);
          yield* toolCall('run_code', {
            code: ptcProgram(testCase.args, testCase.sequential),
            description: 'Apply the ordered CSV operations',
          });
          return;
        }
        const advertised = options.tools.filter(entry => entry.name.startsWith(namespace));
        if (review) {
          for (const name of [pipelineTool, reviewTool]) assert.ok(advertised.some(entry => entry.name === name));
          toolSchemaBytes = Buffer.byteLength(JSON.stringify(advertised));
          yield* toolCall(pipelineTool, {
            path: testCase.args.path, steps: [{ op: 'filter_eq', column: 'status', value: 'cancelled' }],
          });
          return;
        }
        if (pipeline) {
          assert.ok(advertised.some(entry => entry.name === pipelineTool), 'workflow overlay did not load the pipeline tool');
          toolSchemaBytes = Buffer.byteLength(JSON.stringify(advertised));
          const args = testCase.sequential
            ? { ...testCase.args, steps: testCase.args.steps.slice(0, 1) }
            : testCase.args;
          yield* toolCall(pipelineTool, args);
          return;
        }
        const expected = testCase.baseline ? originalTools : [tool];
        assert.deepEqual(advertised.map(entry => entry.name).sort(), expected.slice().sort());
        toolSchemaBytes = Buffer.byteLength(JSON.stringify(advertised));
        if (testCase.baseline) yield* toolCall(originalTools[0], { path: testCase.args.path });
        else yield* toolCall(tool, testCase.args);
        return;
      }
      const last = options.messages.at(-1);
      assert.equal(last?.role, 'tool', 'the tool receipt must return to the same agent');
      const receiptText = last.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      if (testCase.status === 'error') assert.match(receiptText, /^Error: /);
      if (testCase.ptc) assert.doesNotMatch(receiptText, /^Error: /, receiptText);
      const receipt = JSON.parse(testCase.ptc
        ? receiptText.replace(/\nFile sandbox enforcement is partial on this host\.$/, '')
        : receiptText.replace(/^Error: /, ''));
      if (review && requests === 2) {
        assert.equal(receipt.status, 'completed');
        assert.equal(receipt.output_rows, review.rows);
        const path = artifactReference(testCase.workspace, receipt);
        yield* toolCall(reviewTool, { path, column: 'reason', labels: Object.values(review.expected) });
        return;
      }
      if (review && requests === 3) {
        assert.equal(receipt.status, 'needs_labels');
        assert.equal(receipt.input_rows, review.rows);
        assert.equal(receipt.distinct_values, Object.keys(review.expected).length);
        assert.equal(receipt.candidates.length, receipt.distinct_values);
        assert.doesNotMatch(JSON.stringify(receipt), /private-id|active-row/);
        const assignments = receipt.candidates.map(candidate => {
          assert.ok(Object.hasOwn(review.expected, candidate.text));
          assert.equal(candidate.rows * receipt.distinct_values, review.rows);
          return { id: candidate.id, label: review.expected[candidate.text] };
        });
        reviewReport = {
          rows: receipt.input_rows, candidates: receipt.distinct_values,
          ungroupedValuesBytes: receipt.ungrouped_values_bytes,
          groupedReviewEstimateBytes: receipt.grouped_review_estimate_bytes,
        };
        assert.ok(reviewReport.groupedReviewEstimateBytes < reviewReport.ungroupedValuesBytes);
        yield* toolCall(reviewTool, { review_id: receipt.review_id, assignments });
        return;
      }
      if (pipeline && !testCase.ptc && testCase.sequential && toolCalls < testCase.args.steps.length) {
        assert.equal(receipt.status, 'completed');
        const path = artifactReference(testCase.workspace, receipt);
        yield* toolCall(pipelineTool, { path, steps: [testCase.args.steps[toolCalls]] });
        return;
      }
      if (testCase.baseline && requests === 2) {
        assert.equal(receipt.status, 'inspected');
        const { key, keep, time_column } = testCase.args;
        yield* toolCall(originalTools[1], { input_id: receipt.input_id, key, keep, time_column });
        return;
      }
      if (testCase.baseline && requests === 3) {
        assert.equal(receipt.status, 'ready');
        yield* toolCall(originalTools[2], { plan_id: receipt.plan_id, save_as: testCase.args.save_as });
        return;
      }
      const expectedRequests = review || testCase.baseline ? 4
        : pipeline && !testCase.ptc && testCase.sequential ? testCase.args.steps.length + 1 : 2;
      assert.equal(requests, expectedRequests, 'unexpected retry or extra model step');
      assert.equal(receipt.status, testCase.status);
      const activeChainMs = Math.round(performance.now() - firstRequest);
      const ptcDispatches = testCase.ptc ? ctx.agents.get(options.sessionId).session.snapshotEvents()
        .filter(event => event.type === 'tool/ptc-dispatch').map(event => event.data) : undefined;
      writeFileSync(process.env.TASK_REUSE_SMOKE_TRACE, JSON.stringify({ requests, toolCalls, toolSchemaBytes, receipt, messagesAndToolsBytes, activeChainMs, reviewReport, ptcDispatches }));
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: summary };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: summary } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }

  ctx.on('llm/stream', async function* (options, next) {
    assert.equal(options.provider, provider, 'only the scripted provider is allowed during the smoke test');
    yield* next();
  });
  ctx.effect(() => ctx.llm.registerAdapter([provider], new FixtureAdapter()));
}

function checkedSpawn(command, args, options) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 35_000, ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${args[1] ?? command}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function writeWorkflowOverlay(root, engine, python, env) {
  const overlay = resolve(root, 'workflow.patch.yml');
  const config = checkedSpawn(python, ['-B', engine, '--workspace', root, 'dsh-patch', '--workflows'], { cwd: root, env });
  writeFileSync(overlay, config);
  return overlay;
}

function pipelineSmoke({ workspace, fixture, trace, engine, python, env, launch, ptcOverlay }) {
  // Apply the same Harness policy to every arm of the opt-in comparison.
  const permissionMode = ptcOverlay ? process.env.TASK_REUSE_PTC_PERMISSION_MODE : undefined;
  const permission = permissionMode ? { DSH_PERMISSION_MODE: permissionMode } : {};
  const csv = [
    'email,time,status,chapter',
    'dup@example.invalid,2026-11-10T09:00:00Z,active,north',
    'dup@example.invalid,2026-11-10T11:00:00Z,active,south',
    'n@example.invalid,2026-11-10T09:00:00Z,active,north',
    'inactive@example.invalid,2026-11-10T10:00:00Z,inactive,south',
    's@example.invalid,2026-11-10T09:00:00Z,active,south',
    'w@example.invalid,2026-11-10T09:00:00Z,active,west',
    'dup@example.invalid,2026-11-10T12:00:00Z,inactive,north',
    '',
  ].join('\n');
  const filter = { op: 'filter_eq', column: 'status', value: 'active' };
  const dedupe = { op: 'dedupe', key: 'email', keep: 'latest_timestamp', time_column: 'time' };
  const group = { op: 'group_count', column: 'chapter' };
  const steps = [filter, dedupe, group];
  const expected = ['chapter,count', 'north,1', 'south,2', 'west,1'];
  const sequential = { name: 'sequential', steps, sequential: true, counts: [3], expected };
  const batched = { name: 'batched', steps, counts: [5, 4, 3], expected };
  const cases = [
    sequential,
    batched,
    ...(ptcOverlay ? [
      { ...sequential, name: 'ptc-sequential', ptc: true },
      { ...batched, name: 'ptc-batched', ptc: true },
    ] : []),
    { name: 'reordered', steps: [dedupe, filter, group], counts: [5, 3, 3], expected: ['chapter,count', 'north,1', 'south,1', 'west,1'] },
    { name: 'preview', steps, counts: [5, 4, 3], preview: true },
    { name: 'step-error', steps: [filter, { ...group, column: 'missing' }], errorStep: 2 },
  ];
  const reports = [];
  let baselineBytes;
  for (const test of cases) {
    const root = resolve(workspace, `pipeline-${test.name}`);
    mkdirSync(root);
    const input = resolve(root, 'report.csv');
    writeFileSync(input, csv);
    const overlay = writeWorkflowOverlay(root, engine, python, env);
    const status = test.errorStep ? 'error' : test.preview ? 'ready' : 'completed';
    const args = { path: 'report.csv', steps: test.steps, ...(test.preview ? { preview: true } : {}) };
    const testCase = { pipeline: true, sequential: Boolean(test.sequential), workspace: root, args, status, ptc: test.ptc };
    const ptcArgs = test.ptc ? ['--patch', ptcOverlay] : [];
    const stdout = launch(['--profile', 'headless', ...ptcArgs, '--patch', overlay, '--patch', fixture, 'Run the synthetic CSV workflow.'], {
      ...permission,
      TASK_REUSE_SMOKE_CASE: JSON.stringify(testCase),
    });
    assert.match(stdout, /Task Reuse keyless round trip complete/);
    const result = JSON.parse(readFileSync(trace, 'utf8'));
    const count = test.sequential ? test.steps.length : 1;
    const modelCalls = test.ptc ? 1 : count;
    assert.equal(result.requests, modelCalls + 1);
    assert.equal(result.toolCalls, modelCalls);
    if (test.ptc) {
      assert.deepEqual(result.ptcDispatches.map(dispatch => dispatch.name), Array(count).fill(pipelineTool));
      assert.ok(result.ptcDispatches.every(dispatch => dispatch.isError === false));
      const batches = test.sequential ? test.steps.map(step => [step]) : [test.steps];
      assert.deepEqual(result.ptcDispatches.map(dispatch => dispatch.arguments.steps), batches);
    }
    assert.equal(result.receipt.status, status);
    if (test.errorStep) {
      assert.equal(result.receipt.step, test.errorStep);
      assert.equal(result.receipt.code, 'unknown_column');
    } else {
      assert.equal(result.receipt.output_rows, 3);
      assert.deepEqual(result.receipt.steps.map(step => step.output_rows), test.counts);
      assert.ok(result.receipt.checks.includes('steps_verified'));
    }
    assert.equal(readFileSync(input, 'utf8'), csv, 'the input file must stay intact');
    assert.doesNotMatch(JSON.stringify(result.receipt), /@example\.invalid/);
    const outputs = resolve(root, 'task-reuse-output');
    if (status !== 'completed') {
      assert.ok(!result.receipt.output_path);
      assert.deepEqual(existsSync(outputs) ? readdirSync(outputs) : [], []);
    } else {
      const output = realpathSync(resolve(root, result.receipt.output_path));
      assert.equal(dirname(output), outputs);
      assert.equal(readdirSync(outputs).length, count);
      const bytes = readFileSync(output);
      assert.deepEqual(bytes.toString('utf8').trimEnd().split(/\r?\n/), test.expected);
      if (test.name === 'sequential') baselineBytes = bytes;
      if (test.name === 'batched' || test.ptc) assert.deepEqual(bytes, baselineBytes, 'A/B outputs must be byte-identical');
    }
    reports.push({
      case: test.name, status, scriptedRequests: result.requests, toolCalls: result.toolCalls,
      serializedMessagesAndToolsBytes: result.messagesAndToolsBytes, activeChainMs: result.activeChainMs,
      ...(test.ptc ? { nestedMcpDispatches: result.ptcDispatches.length } : {}),
      ...(test.errorStep ? { failedStep: result.receipt.step, errorCode: result.receipt.code } : {}),
    });
  }
  return reports;
}

function mixedWorkflowSmoke({ workspace, fixture, trace, engine, python, env, launch }) {
  const root = resolve(workspace, 'mixed-workflow');
  mkdirSync(root);
  const expected = {
    'travel was cancelled by the airline': 'travel',
    'event timing conflicts with a work commitment': 'schedule',
    'paid twice and requested cancellation of duplicate registration': 'duplicate',
  };
  const reasons = Object.keys(expected);
  const rows = 60;
  const cancelled = Array.from({ length: rows }, (_, index) => [
    `private-id-${index}`, 'cancelled', reasons[index % reasons.length],
  ]);
  const active = Array.from({ length: 6 }, (_, index) => [
    `private-id-${rows + index}`, 'active', `active-row-${index}`,
  ]);
  const csv = [['id', 'status', 'reason'], ...cancelled, ...active].map(row => row.join(',')).join('\n') + '\n';
  const input = resolve(root, 'cancellations.csv');
  writeFileSync(input, csv);
  const overlay = writeWorkflowOverlay(root, engine, python, env);
  const testCase = { review: { rows, expected }, workspace: root, args: { path: 'cancellations.csv' }, status: 'completed' };
  const stdout = launch(['--profile', 'headless', '--patch', overlay, '--patch', fixture, 'Run the mixed synthetic workflow.'], {
    TASK_REUSE_SMOKE_CASE: JSON.stringify(testCase),
  });
  assert.match(stdout, /Task Reuse keyless round trip complete/);
  const result = JSON.parse(readFileSync(trace, 'utf8'));
  assert.equal(result.requests, 4);
  assert.equal(result.toolCalls, 3);
  assert.equal(result.receipt.status, 'completed');
  assert.equal(result.receipt.output_rows, rows);
  assert.equal(result.receipt.classified_values, reasons.length);
  assert.equal(readFileSync(input, 'utf8'), csv, 'the source CSV was modified');
  const output = realpathSync(resolve(root, result.receipt.output_path));
  assert.equal(dirname(output), resolve(root, 'task-reuse-output'));
  const lines = readFileSync(output, 'utf8').trimEnd().split(/\r?\n/);
  assert.deepEqual(lines, [
    'id,status,reason,review_label',
    ...cancelled.map(row => [...row, expected[row[2]]].join(',')),
  ]);
  const ungroupedBytes = Buffer.byteLength(JSON.stringify(cancelled.map(row => row[2])));
  assert.equal(result.reviewReport.ungroupedValuesBytes, ungroupedBytes);
  return { scriptedRequests: result.requests, toolCalls: result.toolCalls, ...result.reviewReport, verifiedRows: lines.length - 1 };
}

function savedWorkflowSmoke({ workspace, fixture, trace, engine, python, env, launch }) {
  const root = resolve(workspace, 'saved-workflow');
  mkdirSync(root);
  const first = 'workflow.csv';
  const next = 'workflow-next.csv';
  for (const file of [first, next]) {
    copyFileSync(resolve(project, 'examples', file), resolve(root, file));
  }
  const steps = JSON.parse(readFileSync(resolve(project, 'examples/workflow-steps.json'), 'utf8'));
  const overlay = writeWorkflowOverlay(root, engine, python, env);
  const name = 'attendance-report';

  function run(args, status) {
    const stdout = launch(['--profile', 'headless', '--patch', overlay, '--patch', fixture, 'Run the synthetic workflow case.'], {
      TASK_REUSE_SMOKE_CASE: JSON.stringify({ pipeline: true, workspace: root, args, status }),
    });
    assert.match(stdout, /Task Reuse keyless round trip complete/);
    const result = JSON.parse(readFileSync(trace, 'utf8'));
    assert.equal(result.toolCalls, 1);
    assert.equal(result.requests, 2);
    return result.receipt;
  }

  const preview = run({ path: first, steps, preview: true }, 'ready');
  assert.match(preview.plan_id, /^[0-9a-f]{64}$/);
  assert.ok(!existsSync(resolve(root, 'task-reuse-output')));
  const saved = run({ plan_id: preview.plan_id, save_as: name }, 'completed');
  assert.equal(saved.workflow, name);
  const firstOutput = resolve(root, artifactReference(root, saved));
  assert.deepEqual(readFileSync(firstOutput, 'utf8').trimEnd().split(/\r?\n/), ['地区,count', '北区,1', '南区,2']);

  const replayArgs = { path: next, workflow: name };
  const directArgs = { path: next, steps };
  const replay = run(replayArgs, 'completed');
  assert.equal(replay.workflow, name);
  const direct = run(directArgs, 'completed');
  assert.equal(replay.output_ref, direct.output_ref, 'replay and explicit steps must produce the same artifact');
  const nextOutput = resolve(root, artifactReference(root, replay));
  assert.deepEqual(readFileSync(nextOutput, 'utf8').trimEnd().split(/\r?\n/), ['地区,count', '东区,2', '南区,1']);
  return {
    workflow: name, crossSession: true, replayToolCalls: 1, replayScriptedRequests: 2,
    explicitArgumentsBytes: Buffer.byteLength(JSON.stringify(directArgs)),
    replayArgumentsBytes: Buffer.byteLength(JSON.stringify(replayArgs)),
  };
}

function main() {
  const arguments_ = process.argv.slice(2);
  const pipelineOnly = arguments_.includes('--pipeline-only');
  const entryArgument = arguments_.find(argument => !['--pipeline-only', '--ptc'].includes(argument));
  const entry = resolve(entryArgument ?? resolve(project, '../DeepSeek-Harness/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'));
  const ptcOverlay = arguments_.includes('--ptc') ? realpathSync(resolve(process.env.TASK_REUSE_PTC_OVERLAY
    ?? resolve(project, '../DeepSeek-Harness/source/apps/cli/config/examples/ptc.yml'))) : undefined;
  const python = process.env.TASK_REUSE_PYTHON ?? 'python';
  const testDirectory = realpathSync(dirname(script));
  const workspace = mkdtempSync(resolve(testDirectory, 'smoke-'));
  try {
    mkdirSync(resolve(workspace, 'examples'));
    for (const filename of ['first.csv', 'next.csv', 'renamed.csv']) {
      copyFileSync(resolve(project, 'examples', filename), resolve(workspace, 'examples', filename));
    }
    const engine = resolve(project, 'plugins/task-reuse/task_reuse.py');
    const overlay = resolve(workspace, 'task-reuse.patch.yml');
    const baseline = resolve(workspace, 'baseline.patch.yml');
    const baselineRoot = resolve(workspace, 'baseline');
    const fixture = resolve(workspace, 'fixture.patch.yml');
    const trace = resolve(workspace, 'trace.json');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => (
      !/^(?:DSH_|DEEPSEEK_|OPENAI_|ANTHROPIC_|NODE_OPTIONS$)/i.test(key) && !/(?:KEY|TOKEN|SECRET|PASSWORD)$/i.test(key)
    )));
    Object.assign(env, {
      DSH_HOME: resolve(workspace, 'dsh-home'),
      DSH_TELEMETRY_DISABLED: '1',
      TASK_REUSE_SMOKE_DSH_ENTRY: entry,
      TASK_REUSE_SMOKE_TRACE: trace,
    });
    const launch = (args, extra = {}) => checkedSpawn(process.execPath, [entry, ...args], { cwd: workspace, env: { ...env, ...extra } });
    const version = launch(['--version']).trim();
    const overlayText = checkedSpawn(python, ['-B', engine, '--workspace', workspace, 'dsh-patch'], { cwd: workspace, env });
    writeFileSync(overlay, overlayText);
    mkdirSync(resolve(baselineRoot, 'examples'), { recursive: true });
    copyFileSync(resolve(project, 'examples/first.csv'), resolve(baselineRoot, 'examples/first.csv'));
    const originalOverlay = JSON.parse(overlayText);
    const originalConfig = originalOverlay[0].insert[0].config;
    originalConfig.args = originalConfig.args.filter(arg => arg !== '--dsh');
    originalConfig.env.TASK_REUSE_WORKSPACE = baselineRoot;
    writeFileSync(baseline, JSON.stringify(originalOverlay));
    writeFileSync(fixture, JSON.stringify([
      { id: 'agent-default-model', config: { provider, model: 'scripted' } },
      { id: 'session-title-llm', disabled: true },
      { id: 'session-telemetry-otel', disabled: true },
      { id: 'llm-deepseek', disabled: true },
      { id: 'llm-deepseek-account', disabled: true },
      { id: 'llm-retry', disabled: true },
      { insert: [{ id: name, name: script.replaceAll('\\', '/') }] },
    ]));

    const firstSave = { args: { path: 'examples/first.csv', key: '邮箱', keep: 'latest_timestamp', time_column: '报名时间', save_as: 'attendance' }, status: 'completed', winners: [1, 2], revision: 1 };
    const cases = [
      { name: 'baseline', baseline: true, ...firstSave },
      { name: 'ambiguous', args: { path: 'examples/first.csv', key: '邮箱' }, status: 'needs_choice' },
      { name: 'initial', ...firstSave },
      { name: 'reuse', args: { path: 'examples/next.csv', recipe_id: 'attendance' }, status: 'completed', winners: [1, 2, 4], revision: 1 },
      { name: 'drift', args: { path: 'examples/renamed.csv', recipe_id: 'attendance' }, status: 'needs_binding' },
      { name: 'repair', args: { path: 'examples/renamed.csv', recipe_id: 'attendance', replacement: '提交时间', save_as: 'attendance' }, status: 'completed', winners: [1, 2], revision: 2 },
    ];
    const results = [];
    for (const testCase of pipelineOnly ? [] : cases) {
      const caseWorkspace = testCase.baseline ? baselineRoot : workspace;
      const outputDirectory = resolve(caseWorkspace, 'task-reuse-output');
      const listOutputs = () => existsSync(outputDirectory) ? readdirSync(outputDirectory) : [];
      const before = listOutputs();
      const source = resolve(caseWorkspace, testCase.args.path);
      const original = readFileSync(source, 'utf8');
      const caseOverlay = testCase.baseline ? baseline : overlay;
      const stdout = launch(['--profile', 'headless', '--patch', caseOverlay, '--patch', fixture, `Run synthetic ${testCase.name} case.`], {
        TASK_REUSE_SMOKE_CASE: JSON.stringify(testCase),
      });
      assert.match(stdout, /Task Reuse keyless round trip complete/);
      const result = JSON.parse(readFileSync(trace, 'utf8'));
      assert.equal(result.receipt.status, testCase.status);
      assert.equal(result.requests, testCase.baseline ? 4 : 2);
      assert.equal(result.toolCalls, testCase.baseline ? 3 : 1);
      assert.equal(readFileSync(source, 'utf8'), original, 'the source CSV was modified');
      assert.doesNotMatch(JSON.stringify(result.receipt), /(?:lin|zhou|he|wu|li|wang|chen)@example\.invalid/);
      if (testCase.winners !== undefined) {
        assert.equal(result.receipt.output_rows, testCase.winners.length);
        assert.equal(result.receipt.recipe_revision, testCase.revision);
        const output = realpathSync(resolve(caseWorkspace, result.receipt.output_path));
        assert.equal(dirname(output), outputDirectory);
        const rows = original.trimEnd().split(/\r?\n/);
        const resultRows = readFileSync(output, 'utf8').trimEnd().split(/\r?\n/);
        assert.deepEqual(resultRows, [rows[0], ...testCase.winners.map(index => rows[index])]);
        assert.equal(listOutputs().length, before.length + 1);
      } else {
        assert.ok(!result.receipt.output_path);
        assert.deepEqual(listOutputs(), before);
      }
      results.push({ case: testCase.name, scriptedRequests: result.requests, toolCalls: result.toolCalls, pluginToolSchemaBytes: result.toolSchemaBytes, status: result.receipt.status });
    }
    const config = { workspace, fixture, trace, engine, python, env, launch, ptcOverlay };
    const pipelines = pipelineSmoke(config);
    const mixedWorkflow = mixedWorkflowSmoke(config);
    const savedWorkflow = savedWorkflowSmoke(config);
    console.log(JSON.stringify({ dsh: version, tool, pipelineTool, cloudModelCalls: 0, cases: results, pipelines, mixedWorkflow, savedWorkflow }, null, 2));
  } finally {
    const target = realpathSync(workspace);
    assert.equal(dirname(target), testDirectory, 'smoke cleanup must stay in the test directory');
    assert.match(basename(target), /^smoke-[a-z0-9]+$/i);
    rmSync(target, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === script) main();
