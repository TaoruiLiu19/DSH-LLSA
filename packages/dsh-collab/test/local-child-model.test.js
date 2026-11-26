import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createDshBackend } from '../src/dsh-adapter.js';
import { LocalChildModel, LOCAL_CHILD_PROVIDER, localChildConfig } from '../src/local-child-model.js';

const tools = [{ name: 'collab_publish', description: 'Publish a managed work result.', parameters: { type: 'object' } }];
const model = 'local-fixture';
const generate = { provider: LOCAL_CHILD_PROVIDER, model, maxTokens: 64, tools,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Return exact string 007.' }] }] };
const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };

async function serverFor(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port + '/v1';
}

test('only explicit loopback OpenAI-style model routes are eligible', () => {
  for (const baseURL of ['https://example.com/v1', 'http://localhost:48825/v1', 'http://127.0.0.1.example.com/v1',
    'http://127.0.0.1:48825/v1?next=https://example.com/', 'http://127.0.0.1:48825@host/v1',
    'http://127.1:48825/v1', 'http://127.0.0.1:48825/api', 'http://127.0.0.1:48825/v1#remote']) {
    assert.throws(() => localChildConfig({ baseURL, model }), /loopback/);
  }
  assert.equal(localChildConfig({ baseURL: 'http://[::1]:48825/v1/', model }).endpoint,
    'http://[::1]:48825/v1/chat/completions');
});

test('child starts use registered local route and fail closed without it', async () => {
  const requests = [];
  const registered = [];
  const context = {
    subagents: { startActivation(args) { requests.push(args.request); return { id: args.childId }; } },
    llm: { registerAdapter(routes, adapter) { registered.push([routes, adapter]); } },
  };
  const start = { childId: 'test-child', parent: { ctx: { get: () => undefined } },
    prompt: 'test', maxOutputTokens: 64 };
  const unconfigured = createDshBackend(context, {});
  await assert.rejects(unconfigured.start(start), { code: 'FREE_CHILD_MODEL_REQUIRED' });
  await unconfigured.start({ ...start, paid: true });
  assert.deepEqual(requests[0].agentOptions, { maxTokens: 64 });
  const backend = createDshBackend(context, {}, { localChildModel: { baseURL: 'http://127.0.0.1:48825/v1', model } });
  assert.equal(backend.canStartFree(), true);
  assert.equal(backend.isFreeRoute(LOCAL_CHILD_PROVIDER, model), true);
  assert.equal(backend.isFreeRoute('deepseek-official', model), false);
  await backend.start(start);
  assert.deepEqual(registered[0][0], [LOCAL_CHILD_PROVIDER]);
  assert.deepEqual(requests[1].agentOptions, { provider: LOCAL_CHILD_PROVIDER, model, maxTokens: 64,
    temperature: 0, reasoningEffort: 'off' });
});

test('local model translates an exact publication and local provider usage', async t => {
  let seen;
  const baseURL = await serverFor(t, async (req, res) => {
    let body = '';
    for await (const part of req) body += part.toString();
    seen = { body: JSON.parse(body), auth: req.headers.authorization, url: req.url };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{
      type: 'function', id: 'call-1', function: { name: 'collab_publish', arguments: '{"id":"007"}' },
    }] } }], usage: { prompt_tokens: 12, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 3 } } }));
  });
  const adapter = new LocalChildModel({ baseURL, model, apiKey: 'local-fixture-token' });
  const chunks = await collect(adapter.stream(generate));
  assert.equal(seen.url, '/v1/chat/completions');
  assert.equal(seen.auth, 'Bearer local-fixture-token');
  assert.deepEqual(seen.body.messages, [{ role: 'user', content: 'Return exact string 007.' }]);
  assert.equal(seen.body.tools[0].function.name, 'collab_publish');
  assert.equal(seen.body.chat_template_kwargs.enable_thinking, false);
  assert.equal(chunks.find(chunk => chunk.type === 'block-end').block.arguments, '{"id":"007"}');
  assert.deepEqual(chunks.at(-2).usage, { inputTokens: 9, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 0, totalTokens: 17 });
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls');
});

test('local child never follows HTTP redirects or switches models', async t => {
  let redirected = 0;
  const baseURL = await serverFor(t, (req, res) => {
    if (req.url === '/v1/chat/completions') {
      res.writeHead(302, { location: '/redirect-target' }).end();
    } else { redirected++; res.writeHead(200).end(); }
  });
  const adapter = new LocalChildModel({ baseURL, model });
  await assert.rejects(collect(adapter.stream(generate)), { code: 'LOCAL_CHILD_HTTP' });
  await assert.rejects(collect(adapter.stream({ ...generate, model: 'paid-model' })), { code: 'INVALID_LOCAL_CHILD_MODEL' });
  assert.equal(redirected, 0);
});
