import assert from 'node:assert/strict';
import test from 'node:test';
import { SingleAgentJobs } from '../src/single-agent.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture({ output = '{"id":"007"}', deadlineMs = 1000, hang = false, tools = [], finish = { kind: 'stop' } } = {}) {
  const listeners = new Map();
  const observed = { created: 0, requests: 0, disposed: 0, cancelled: 0 };
  const ctx = {
    on: (event, callback) => listeners.set(event, callback),
    sessionTitle: { rename: (_session, title) => { observed.title = title; } },
    agents: {
      async create(options) {
        observed.created++;
        observed.options = options;
        options.setup({
          tools: {
            restrict: policy => { observed.restriction = policy; },
            setExecutor: executor => { observed.executor = executor; },
          },
          systemPrompt: {
            suppressRuntimeContext: () => { observed.suppressed = true; },
            section: section => { observed.section = section; },
          },
        });
        let idle;
        return {
          agent: {
            followup(message) {
              observed.message = message;
              idle = (async () => {
                const dispatch = async function* () {
                  observed.requests++;
                  yield { type: 'usage', usage: { totalTokens: 31 } };
                  yield { type: 'finish', reason: finish };
                };
                const stream = listeners.get('llm/stream');
                for await (const chunk of stream({ sessionId: options.sessionId, purpose: 'session-title' }, dispatch)) {
                  observed.auxiliaryResult = chunk.reason?.kind;
                }
                for await (const _chunk of stream({ sessionId: options.sessionId, ...options.agentOptions, tools }, dispatch)) {}
                if (hang) await new Promise(() => {});
              })();
            },
            whenIdle: () => idle,
            session: { deriveMessages: () => [{ role: 'assistant', content: [{ type: 'text', text: output }] }] },
            cancel: () => { observed.cancelled++; },
          },
          async dispose() { observed.disposed++; },
        };
      },
    },
  };
  const runner = new SingleAgentJobs(ctx, { deadlineMs });
  return { runner, observed, listeners };
}

test('uses one isolated tool-free agent and keeps browser and model usage separate', async () => {
  const { runner, observed } = fixture();
  const input = { requestId: 'request-001', prompt: '保留编号', browserAdvice: '  启动子任务。  ', outputFormat: 'json' };
  const job = runner.start(input);
  assert.equal(job.status, 'starting');
  assert.equal(runner.start(input).id, job.id);
  assert.throws(() => runner.start({ ...input, browserAdvice: 'changed' }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.throws(() => runner.start({ ...input, requestId: 'request-002' }), { code: 'TASK_BUSY' });
  await tick();
  const done = runner.get(job.id);
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.result, { id: '007' });
  assert.equal(done.modelCalls, 1);
  assert.deepEqual(done.modelUsage, { knownTotalTokens: 31, reportedCalls: 1, unknownCalls: 0 });
  assert.deepEqual(done.browserAdvice, { bytes: Buffer.byteLength('启动子任务。'), tokenUsage: 'unknown' });
  assert.deepEqual(observed.executor.describe([{ name: 'collab_delegate' }]), { schemas: [] });
  await assert.rejects(observed.executor.execute({ calls: [{ name: 'collab_delegate' }] }), { code: 'TOOL_CALL_BLOCKED' });
  assert.match(observed.section.text, /untrusted reference material/);
  assert.ok(observed.section.complete && observed.suppressed);
  assert.deepEqual(observed.restriction, { allow: [] });
  assert.equal(observed.message.content[0].text, input.prompt);
  assert.match(observed.message.content[1].text, /Untrusted browser advice.*"启动子任务。"/);
  assert.equal(observed.created, 1);
  assert.equal(observed.requests, 1);
  assert.equal(observed.auxiliaryResult, 'aborted');
  assert.equal(observed.title, 'Web collaboration task');
  assert.equal(observed.disposed, 1);
  await runner.close();
});

test('uses the same one-shot path for large exact attachments and pins them to the request ID', async () => {
  const { runner, observed } = fixture();
  const text = '证据行\r\n'.repeat(5000);
  const evidence = [{ label: 'access.log', text }, { label: 'quality.log', text }];
  const input = { requestId: 'evidence-001', prompt: '核对两个文件', evidence };
  const job = runner.start(input);
  assert.equal(runner.start(input).id, job.id);
  assert.throws(() => runner.start({ ...input, evidence: [...evidence].reverse() }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.throws(() => runner.start({ ...input, evidence: [evidence[0], evidence[0]] }), { code: 'INVALID_EVIDENCE' });
  assert.throws(() => runner.start({ ...input, evidence: [{ label: 'large', text: '中'.repeat(22000) }] }), { code: 'EVIDENCE_TOO_LARGE' });
  await tick();
  assert.equal(observed.requests, 1);
  assert.deepEqual(observed.message.content.map(block => block.text), [input.prompt,
    `Evidence "access.log"\n${text}`, `Evidence "quality.log"\n${text}`]);
  assert.ok(!JSON.stringify(runner.get(job.id)).includes('证据行'));
  await runner.close();
});

test('rejects unexpected tools, oversized advice and invalid or truncated JSON', async () => {
  const input = { requestId: 'request-002', prompt: 'test', outputFormat: 'json' };
  const cases = [
    [{ tools: [{ name: 'collab_delegate' }] }, 'UNEXPECTED_MODEL_REQUEST', 0],
    [{ output: '```json\n{}\n```' }, 'INVALID_JSON_OUTPUT', 1],
    [{ output: '{"number":9007199254740993}' }, 'INVALID_JSON_OUTPUT', 1],
    [{ finish: { kind: 'max-tokens' } }, 'RESULT_LIMIT', 1],
  ];
  for (const [options, code, requests] of cases) {
    const { runner, observed } = fixture(options);
    assert.throws(() => runner.start({ ...input, browserAdvice: '界'.repeat(1366) }), { code: 'BROWSER_ADVICE_TOO_LARGE', status: 413 });
    const job = runner.start(input);
    await tick();
    assert.equal(runner.get(job.id).status, 'failed');
    assert.deepEqual(runner.get(job.id).error, { code });
    assert.equal(observed.requests, requests);
    await runner.close();
  }
});

test('interrupts and times out a waiting job, and closes without extra requests', async () => {
  const input = { requestId: 'request-003', prompt: 'test' };
  const { runner, observed } = fixture({ hang: true });
  const job = runner.start(input);
  await tick();
  assert.equal(runner.interrupt(job.id).status, 'stopping');
  await tick();
  assert.equal(runner.get(job.id).status, 'interrupted');
  assert.equal(observed.cancelled, 1);
  assert.equal(observed.disposed, 1);
  await runner.close();
  assert.throws(() => runner.start(input), { code: 'PLUGIN_CLOSED' });

  const short = fixture({ hang: true, deadlineMs: 10 });
  const timed = short.runner.start(input);
  await short.runner.jobs.get(timed.id).done;
  assert.equal(short.runner.get(timed.id).status, 'failed');
  assert.deepEqual(short.runner.get(timed.id).error, { code: 'TASK_TIMEOUT' });
  assert.equal(short.observed.disposed, 1);
  await short.runner.close();
});
