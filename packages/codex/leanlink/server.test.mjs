import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const server = fileURLToPath(new URL('./server.mjs', import.meta.url));
const key = {workspace: 'release-check', run: 'run-a'};
const initialize = {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'test', version: '1'}};

async function testHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'leanlink-test-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  return home;
}

function connect(t, home, pinnedWorkspace) {
  const env = {...process.env, CODEX_LEANLINK_HOME: home};
  delete env.CODEX_LEANLINK_WORKSPACE;
  if (pinnedWorkspace !== undefined) env.CODEX_LEANLINK_WORKSPACE = pinnedWorkspace;
  const child = spawn(process.execPath, [server], {env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
  const lines = createInterface({input: child.stdout, crlfDelay: Infinity});
  const iterator = lines[Symbol.asyncIterator]();
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  let closed = false;
  t.after(async () => {
    if (!closed) {
      child.kill();
      await exited;
    }
    lines.close();
  });
  function send(data) { child.stdin.write(data); }
  async function next() {
    const line = await Promise.race([iterator.next(), exited.then(([code]) => {
      throw new Error(`LeanLink exited ${code}: ${stderr}`);
    })]);
    assert.equal(line.done, false, stderr);
    return JSON.parse(line.value);
  }
  let serial = 0;
  async function rpc(method, params, id = ++serial) {
    send(JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\r\n');
    const reply = await next();
    assert.equal(reply.jsonrpc, '2.0');
    assert.equal(reply.id, id);
    return reply;
  }
  async function ready(version = initialize.protocolVersion) {
    const {result} = await rpc('initialize', {...initialize, protocolVersion: version});
    assert.ok(result?.capabilities.tools);
    send('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    return result.protocolVersion;
  }
  async function call(name, args, errorCode) {
    const {result, error} = await rpc('tools/call', {name: `leanlink_${name}`, arguments: {...key, ...args}});
    assert.equal(error, undefined, JSON.stringify(error));
    assert.equal(result.content.length, 1, 'Result representation is sent once');
    const data = JSON.parse(result.content[0].text);
    assert.equal(Boolean(result.isError), Boolean(errorCode), JSON.stringify(data));
    if (errorCode !== undefined) assert.equal(data.code, errorCode);
    return data;
  }
  async function close() {
    child.stdin.end();
    assert.deepEqual(await exited, [0, null], stderr);
    closed = true;
  }
  return {ready, rpc, send, next, call, close};
}

test('negotiates MCP lifecycle and distinguishes protocol and tool errors', {timeout: 15_000}, async t => {
  const client = connect(t, await testHome(t));
  assert.deepEqual((await client.rpc('ping', {}, 'health')).result, {});
  assert.equal((await client.rpc('tools/list')).error.code, -32000);
  client.send('{invalid json}\n');
  assert.equal((await client.next()).error.code, -32700);
  assert.equal((await client.rpc('initialize', {})).error.code, -32602);
  assert.equal(await client.ready('unsupported-future-version'), '2025-11-25');
  const {result} = await client.rpc('tools/list', {});
  assert.deepEqual(result.tools.map(tool => tool.name),
    ['leanlink_submit', 'leanlink_checkpoint', 'leanlink_review', 'leanlink_lookup', 'leanlink_read']);
  assert.equal((await client.rpc('tools/call', {name: 'missing'})).error.code, -32602);
  assert.equal((await client.rpc('tools/call', {name: 'leanlink_submit', arguments: []})).error.code, -32602);
  assert.equal((await client.rpc('resources/list')).error.code, -32601);
  assert.equal((await client.rpc('initialize', initialize)).error.code, -32600);
  await client.call('submit', {expectedVersion: 0}, 'INVALID_ARGUMENT');
  await client.call('submit', {expectedVersion: 0, opId: 'a', path: 'C:/secret', text: 'ok'}, 'INVALID_ARGUMENT');
  await client.call('submit', {expectedVersion: 0, opId: 'a', text: '\ud800'}, 'INVALID_ARGUMENT');
  await client.close();
});

test('returns short references and replays exact saved UTF-8 byte ranges', {timeout: 15_000}, async t => {
  const home = await testHome(t);
  const client = connect(t, home);
  assert.equal(await client.ready('2025-03-26'), '2025-03-26');
  const submittedText = '\ufeff核对\r\n输入🙂␀';
  const input = await client.call('submit', {opId: 'input-a', expectedVersion: 0, text: submittedText});
  assert.deepEqual(Object.keys(input), ['seq', 'kind', 'inputVersion', 'ref', 'bytes']);
  assert.equal(input.inputVersion, 1);
  const checkpoint = await client.call('checkpoint', {opId: 'check-a', inputVersion: 1, step: 'source', text: submittedText});
  const source = '{ "id": "000007", "approved": false, "bigId": "9007199254740993", "note": "终稿🙂" }\n';
  const result = await client.call('checkpoint', {opId: 'result-a', inputVersion: 1, step: 'source', kind: 'result', text: source, summary: '保留精确 ID'});
  await client.call('review', {opId: 'bad-review', ref: checkpoint.ref, decision: 'accepted', reason: 'done'}, 'INVALID_TARGET');
  const decision = await client.call('review', {opId: 'review-a', ref: result.ref, decision: 'accepted', reason: 'Exact field comparison.'});
  assert.deepEqual(decision, {seq: 4, kind: 'review', inputVersion: 1, ref: result.ref, step: 'source', decision: 'accepted'});
  await client.call('review', {opId: 'new-review', ref: result.ref, decision: 'rejected', reason: 'different'}, 'ALREADY_REVIEWED');
  const lookup = await client.call('lookup', {step: 'source'});
  assert.deepEqual(lookup.entries.map(item => item.kind), ['checkpoint', 'result', 'review']);
  assert.equal(lookup.entries[1].summary, '保留精确 ID');
  assert.ok(lookup.entries.every(entry => !Object.hasOwn(entry, 'text')));
  await client.close();

  const restarted = connect(t, home);
  await restarted.ready();
  assert.equal((await restarted.call('read', {ref: input.ref})).text, submittedText);
  assert.equal((await restarted.call('read', {ref: checkpoint.ref})).text, submittedText);
  assert.equal((await restarted.call('read', {ref: checkpoint.ref, bytes: 1})).nextStart, 3);
  await restarted.call('read', {ref: checkpoint.ref, start: 1}, 'INVALID_CURSOR');
  const pages = [];
  let start = 0;
  while (start !== null) {
    const page = await restarted.call('read', {ref: result.ref, start, bytes: 7});
    assert.equal(page.sha256, createHash('sha256').update(source).digest('hex'));
    assert.equal(page.bytes, Buffer.byteLength(page.text));
    assert.equal(page.totalBytes, Buffer.byteLength(source));
    pages.push(page.text);
    start = page.nextStart;
  }
  assert.equal(pages.join(''), source);
  await restarted.close();
});

test('protects input versions, retry identity and historical page boundaries', {timeout: 15_000}, async t => {
  const client = connect(t, await testHome(t));
  await client.ready();
  const oldInput = await client.call('submit', {text: 'Previous instructions', expectedVersion: 0, opId: 'start'});
  const stale = await client.call('checkpoint', {step: 'answer', kind: 'result', text: 'Result for previous instructions', inputVersion: 1, opId: 'old'});
  const firstPage = await client.call('lookup', {limit: 1});
  assert.equal(firstPage.nextAfterSeq, 1);
  assert.equal(firstPage.throughSeq, 2);
  const revision = await client.call('submit', {expectedVersion: 1, opId: 'update', text: 'Late user correction'});
  assert.equal(revision.inputVersion, 2);
  assert.deepEqual(await client.call('submit', {expectedVersion: 0, opId: 'start', text: 'Previous instructions'}), oldInput);
  await client.call('submit', {expectedVersion: 0, opId: 'start', text: 'Another task'}, 'OP_CONFLICT');
  await client.call('checkpoint', {opId: 'stale', text: 'Too late', inputVersion: 1, step: 'answer'}, 'STALE_INPUT');
  await client.call('review', {opId: 'stale-review', ref: stale.ref, decision: 'accepted', reason: 'Ignore old'}, 'STALE_INPUT');
  const history = await client.call('lookup', {throughSeq: firstPage.throughSeq, afterSeq: firstPage.nextAfterSeq});
  assert.deepEqual(history.entries.map(entry => entry.ref), [stale.ref]);
  assert.equal(history.inputVersion, 1);
  assert.equal(history.nextAfterSeq, null);
  assert.equal((await client.call('read', {ref: stale.ref})).text, 'Result for previous instructions');
  const current = await client.call('checkpoint', {opId: 'correction', text: 'Revised result', inputVersion: 2, step: 'answer', kind: 'result'});
  await client.call('review', {opId: 'rejected', ref: current.ref, decision: 'rejected', reason: 'A constraint still needs correction.'});
  const retry = await client.call('checkpoint', {opId: 'corrected', text: 'Corrected result', inputVersion: 2, step: 'answer', kind: 'result'});
  await client.call('review', {opId: 'accepted', ref: retry.ref, decision: 'accepted', reason: 'All constraints preserved.'});
  assert.equal((await client.call('lookup', {step: 'answer'})).entries.length, 5);
  await client.close();
});

test('does not resolve references outside their workspace and run', {timeout: 15_000}, async t => {
  const home = await testHome(t);
  const client = connect(t, home);
  const pinned = connect(t, home, key.workspace);
  await Promise.all([client.ready(), pinned.ready()]);
  const saved = await client.call('submit', {opId: 'create', expectedVersion: 0, text: 'Scoped record'});
  await client.call('read', {run: 'another', ref: saved.ref}, 'NOT_FOUND');
  await client.call('read', {workspace: 'another', ref: saved.ref}, 'NOT_FOUND');
  await client.call('read', {ref: '../other.txt'}, 'INVALID_ARGUMENT');
  await client.call('lookup', {workspace: '../other'}, 'INVALID_ARGUMENT');
  await pinned.call('lookup', {workspace: 'another'}, 'SCOPE_MISMATCH');
  assert.equal((await pinned.call('read', {ref: saved.ref})).text, 'Scoped record');
  await Promise.all([client.close(), pinned.close()]);
});

test('concurrent server processes serialize writes and exactly replay an operation', {timeout: 15_000}, async t => {
  const home = await testHome(t);
  const left = connect(t, home);
  const right = connect(t, home);
  await Promise.all([left.ready(), right.ready()]);
  const input = {opId: 'atomic-input', expectedVersion: 0, text: 'One input record'};
  const both = await Promise.all([left.call('submit', input), right.call('submit', input)]);
  assert.deepEqual(both[0], both[1]);
  const item = {inputVersion: 1, step: 'result', kind: 'result'};
  const [a, b] = await Promise.all([
    left.call('checkpoint', {...item, opId: 'one', text: 'one'}),
    right.call('checkpoint', {...item, opId: 'two', text: 'two'}),
  ]);
  assert.notEqual(a.ref, b.ref);
  assert.deepEqual([a.seq, b.seq].sort(), [2, 3]);
  const revise = (client, opId) => client.rpc('tools/call', {name: 'leanlink_submit', arguments: {...key, opId, expectedVersion: 1, text: opId}});
  const revisions = await Promise.all([revise(left, 'rev-a'), revise(right, 'rev-b')]);
  const matches = revisions.map(response => JSON.parse(response.result.content[0].text));
  assert.equal(matches.filter(response => response.kind === 'input' && response.inputVersion === 2).length, 1);
  assert.equal(matches.filter(response => response.code === 'VERSION_CONFLICT').length, 1);
  assert.deepEqual((await left.call('lookup', {})).entries.map(entry => entry.seq), [1, 2, 3, 4]);
  await Promise.all([left.close(), right.close()]);
});
