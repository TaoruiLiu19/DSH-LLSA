/** Verify installation and MCP in an isolated Codex home, with optional local lifecycle playback. */
import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { buildCodexMarketplace } from './build-codex-marketplace.mjs';

const codex = process.env.CODEX_BIN || 'codex';
const temporary = tmpdir();
const fixture = await mkdtemp(join(temporary, 'llsa-codex-smoke-'));
const workspace = join(fixture, 'workspace');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(?:CODEX_|OPENAI_|ANTHROPIC_|DEEPSEEK_|CHATGPT_)|(?:TOKEN|KEY|SECRET|CREDENTIAL|PASSWORD|PROXY)$/iu.test(key)));
Object.assign(env, { CODEX_HOME: join(fixture, 'codex'), CODEX_LEANLINK_HOME: join(fixture, 'data'),
  OPENAI_BASE_URL: 'http://127.0.0.1:1/v1', HTTPS_PROXY: 'http://127.0.0.1:1',
  HTTP_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1,localhost' });

function cli(args) {
  const result = spawnSync(codex, args, { cwd: workspace, env, encoding: 'utf8', windowsHide: true, timeout: 25_000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function connect() {
  const child = spawn(codex, ['app-server', '--stdio'], { cwd: workspace, env, windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'] });
  const exits = once(child, 'exit');
  exits.catch(() => {});
  let id = 0;
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  let diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-3500); });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
    else request.resolve(message.result);
  });
  const abort = error => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  child.on('error', abort);
  child.on('exit', code => abort(new Error(`Codex exited (${code})`)));
  child.stdin.on('error', abort);
  return {
    rpc(method, params) {
      const requestId = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`Timed out waiting for ${method}`));
        }, 20_000);
        pending.set(requestId, { method, resolve, reject, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
      });
    },
    diagnostics() { return diagnostics; },
    initialized() { child.stdin.write('{"jsonrpc":"2.0","method":"initialized"}\n'); },
    async close() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 4000);
      try { await exits; } catch { /* Spawn errors are reported to pending requests. */ }
      finally { clearTimeout(timer); lines.close(); }
    },
  };
}

async function verifyNativeHooks() {
  let generations = 0;
  let childRan = false;
  let diagnostics;
  const text = 'Local fixture finished.';
  const childTask = 'Run only the LeanLink lifecycle child fixture.';
  const childReachedProvider = Promise.withResolvers();
  const provider = createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url.startsWith('/v1/responses')) {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const id = 'resp_fixture_' + (++generations);
    const isChild = request.input.some(item => item.role === 'user' && JSON.stringify(item.content).includes(childTask));
    if (isChild) {
      childRan = true;
      childReachedProvider.resolve();
    }
    let item = { id: 'msg_' + id, type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: isChild ? 'Local child fixture finished.' : text, annotations: [] }] };
    if (generations === 1) {
      const spawn = request.tools?.find(tool => tool.name === 'spawn_agent' || tool.tools?.some(entry => entry.name === 'spawn_agent'));
      if (spawn) {
        const spec = spawn.tools?.find(tool => tool.name === 'spawn_agent') ?? spawn;
        const args = { message: childTask, fork_turns: 'none' };
        if (spec.parameters?.properties?.task_name) args.task_name = 'fixture_child';
        item = { id: 'fc_fixture', type: 'function_call', name: 'spawn_agent', call_id: 'call_fixture',
          ...(spawn.type === 'namespace' ? { namespace: spawn.name } : {}), arguments: JSON.stringify(args), status: 'completed' };
      } else {
        diagnostics = `Native spawn_agent unavailable. Advertised tools: ${request.tools?.map(tool => tool.name).join(', ')}`;
      }
    } else if (!isChild && !childRan) {
      await Promise.race([childReachedProvider.promise, delay(4000, undefined, { ref: false })]);
    }
    const response = { id, object: 'response', model: 'llsa-fixture', status: 'completed', output: [item],
      usage: { input_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens: 4,
        output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 16 } };
    const events = [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [], usage: null } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item,
        ...(item.type === 'message' ? { content: [] } : { arguments: '' }), status: 'in_progress' } },
      ...(item.type === 'message' ? [{ type: 'response.output_text.delta', item_id: item.id,
        output_index: 0, content_index: 0, delta: item.content[0].text }] : []),
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response },
    ];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  try {
    const base = `http://127.0.0.1:${provider.address().port}/v1`;
    // Only this disposable, locally built checkout is trusted for this fixture.
    const run = promisify(execFile)(codex, ['exec', '--json', '--skip-git-repo-check',
      '--sandbox', 'read-only', '--dangerously-bypass-hook-trust', '-m', 'llsa-fixture',
      '-c', 'model_provider="fixture"', '-c', 'model_providers.fixture.name="Local fixture"',
      '-c', `model_providers.fixture.base_url=${JSON.stringify(base)}`,
      '-c', 'model_providers.fixture.wire_api="responses"', 'Reply with the fixture message.'],
    { cwd: workspace, env, windowsHide: true, timeout: 30_000 });
    run.child.stdin.end();
    const { stdout, stderr } = await run;
    assert.match(stdout, /Local fixture finished/);
    assert.ok(childRan, diagnostics ?? 'The fixture must start a real child Agent\n' + stdout.slice(-3500));
    const { listRuns, getSnapshot } = await import('../packages/codex/hud/collector.mjs');
    const [record] = await listRuns({ home: env.CODEX_LEANLINK_HOME });
    assert.ok(record, 'The installed Codex hooks must write HUD activity\n' +
      (stdout + stderr).split('\n').filter(line => /hook|node/iu.test(line)).join('\n').slice(-4000));
    const hud = await getSnapshot(record.runId, { home: env.CODEX_LEANLINK_HOME });
    assert.ok(hud.events.some(event => event.kind === 'turn.start' || event.to === 'running'));
    assert.ok(hud.agents.some(agent => agent.state === 'done' || agent.state === 'idle'));
    const root = hud.agents.find(agent => agent.parentId === null);
    assert.ok(root && hud.agents.some(agent => agent.parentId === root.id && agent.state === 'done'), JSON.stringify(hud.agents));
    console.log('PASS: native Codex hooks captured a parent turn and its completed subagent using only the local fixture endpoint.');
  } finally {
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
  }
}

try {
  await mkdir(workspace);
  await mkdir(env.CODEX_HOME);
  await writeFile(join(env.CODEX_HOME, 'config.toml'), [
    'chatgpt_base_url = "http://127.0.0.1:1"',
    '[analytics]',
    'enabled = false',
    '',
  ].join('\n'));
  const { marketplace } = await buildCodexMarketplace(join(fixture, 'marketplace'),
    { dataHome: env.CODEX_LEANLINK_HOME, workspace: 'fixture' });
  cli(['plugin', 'marketplace', 'add', relative(workspace, marketplace), '--json']);
  const installed = cli(['plugin', 'add', 'leanlink-codex@dsh-llsa-codex', '--json']);
  const client = connect();
  try {
    await client.rpc('initialize', { clientInfo: { name: 'leanlink-smoke', version: '0.1.0' } });
    client.initialized();
    const { thread } = await client.rpc('thread/start', { cwd: workspace, ephemeral: true });
    const skills = await client.rpc('skills/list', { cwds: [workspace] });
    const discovered = skills.data.flatMap(entry => entry.skills);
    assert.ok(discovered.some(skill => skill.name === 'leanlink-codex:leanlink' && skill.enabled !== false),
      'The installed plugin must expose the LeanLink skill. Discovered: ' +
      JSON.stringify(discovered.map(skill => ({ name: skill.name, enabled: skill.enabled }))));
    if (process.argv.includes('--native-hud')) {
      const hooks = await client.rpc('hooks/list', { threadId: thread.id });
      assert.ok(hooks.data.some(entry => entry.hooks.length >= 10), JSON.stringify(hooks.data));
    }
    const list = await client.rpc('mcpServerStatus/list', { threadId: thread.id, detail: 'toolsAndAuthOnly' });
    const server = list.data.find(server => Object.values(server.tools ?? {}).some(tool => tool.name === 'leanlink_submit'));
    assert.ok(server, 'LeanLink unavailable: ' + JSON.stringify(list.data.map(server =>
      ({ name: server.name, tools: Object.keys(server.tools ?? {}), status: server.status }))) + '\n' + installed + client.diagnostics());
    const tool = async (name, args) => {
      const result = await client.rpc('mcpServer/tool/call', { threadId: thread.id, server: server.name,
        tool: name, arguments: { workspace: 'fixture', run: 'sample', ...args } });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      return JSON.parse(result.content.find(block => block.type === 'text').text);
    };
    const input = await tool('leanlink_submit', { expectedVersion: 0, opId: 'input-one', text: 'Verify the original value.' });
    const exact = '{"id":"000781","approved":false,"note":"核对完成"}';
    const step = await tool('leanlink_checkpoint', { inputVersion: input.inputVersion, opId: 'step-one',
      step: 'verify', text: exact, kind: 'result', summary: 'Exact identifier and approval flag verified.' });
    await tool('leanlink_review', { opId: 'review-one', ref: step.ref, decision: 'accepted', reason: 'Checked against the input.' });
    const replay = await tool('leanlink_read', { ref: step.ref });
    assert.equal(replay.text, exact);
    console.log('PASS: Codex installed the local plugin and archived, reviewed, and retrieved an exact result without a model turn.');
  } finally {
    await client.close();
  }
  if (process.argv.includes('--native-hud')) await verifyNativeHooks();
} finally {
  const name = relative(temporary, fixture);
  assert.ok(name.startsWith('llsa-codex-smoke-') && !name.includes('..') && !isAbsolute(name));
  await rm(fixture, { recursive: true, force: true, maxRetries: 3 });
}
