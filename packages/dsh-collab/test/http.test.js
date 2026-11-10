import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { registerHttp } from '../src/http.js';
import { PANEL_SCRIPT } from '../src/panel.js';
import { Script } from 'node:vm';

async function fixture(t, overrides = {}) {
  const calls = [];
  let handler, disposed = false;
  const service = {
    status: () => ({ mode: 'observe', bridgeConnected: false, apiKey: 'must-not-leak' }),
    listRuns: () => [{ id: 'r1', status: 'running', title: '<img src=x onerror=alert(1)>' }],
    describeRun: id => ({ run: { id }, agents: [], events: [], workItems: [], usage: { providerUsage: 'unknown' } }),
    inspect: (id, step, opts) => { calls.push(['inspect', id, step, opts]); return { chinese: '执行已完成，测试失败', event: { step_id: step, summary: '尚未验证' } }; },
    readArtifact: (run, ref, range) => {
      calls.push(['artifact', run, ref, range]);
      if (run !== 'r1' || ref !== 'a1') throw Object.assign(new Error('private artifact belongs elsewhere'), { code: 'ARTIFACT_NOT_IN_RUN' });
      return { data: Buffer.from('original evidence').subarray(range.start, range.end), mediaType: 'text/plain' };
    },
    pause: (run, value) => { calls.push(['pause', run, value]); return { paused: value }; },
    interrupt: async (run, agent) => { calls.push(['interrupt', run, agent]); return { requested: true }; },
    protocols: () => [],
    operatorControl: async command => { calls.push(['control', command]); throw Object.assign(new Error('bridge unavailable'), { code: 'NO_BRIDGE' }); },
    ...overrides,
  };
  const dispose = registerHttp({ webServer: { register: route => {
    assert.equal(route.kind, 'prefix'); assert.equal(route.path, '/collab'); handler = route.handler;
    return () => { disposed = true; };
  } } }, service);
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.equal(disposed, true); });
  return { base, calls, handler, service };
}

test('panel and status are served with restrictive headers; no model call is involved', async t => {
  const { base, calls } = await fixture(t);
  const page = await fetch(base + '/collab');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(await page.text(), /DSH 协作管理/);
  const status = await (await fetch(base + '/collab/api/status')).json();
  assert.equal(status.bridgeConnected, false);
  assert.equal(status.apiKey, '[REDACTED]');
  assert.deepEqual(calls, []);
});

test('JSON display redacts credential values inside ordinary text and nested arrays', async t => {
  const fakeApiKey = 'sk-' + 'a'.repeat(32);
  const fakeGithubToken = 'ghp_' + 'b'.repeat(36);
  const fakePat = 'github_pat_' + 'c'.repeat(40);
  const source = {
    summary: `upstream returned ${fakeApiKey}; retry after review`,
    findings: [`remote credential ${fakeGithubToken}`, { detail: `Authorization: Bearer abc.def-123` }],
    nested: { note: fakePat, ordinary: 'task-123 and 128 input tokens' },
    password: 'short-password',
  };
  const before = structuredClone(source);
  const { base } = await fixture(t, { status: () => source });
  const response = await fetch(base + '/collab/api/status');
  assert.equal(response.status, 200);
  const displayed = await response.json();
  assert.equal(displayed.summary, 'upstream returned [REDACTED]; retry after review');
  assert.equal(displayed.findings[0], 'remote credential [REDACTED]');
  assert.equal(displayed.findings[1].detail, 'Authorization: Bearer [REDACTED]');
  assert.equal(displayed.nested.note, '[REDACTED]');
  assert.equal(displayed.password, '[REDACTED]');
  assert.equal(displayed.nested.ordinary, source.nested.ordinary);
  assert.deepEqual(source, before, 'display filtering must not rewrite immutable source evidence');
});

test('artifact download preserves original bytes even when a text value resembles a credential', async t => {
  const original = Buffer.from('fixture evidence: sk-' + 'z'.repeat(32));
  const { base } = await fixture(t, { readArtifact: () => ({ data: original, mediaType: 'text/plain' }) });
  const response = await fetch(base + '/collab/api/runs/r1/artifacts/a1');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /^attachment/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);
});

test('step history uses supplied attempt and frozen sequence and remains read-only', async t => {
  const { base, calls } = await fixture(t);
  const response = await fetch(base + '/collab/api/runs/r1/steps/s7?attemptId=try2&asOfSeq=31');
  assert.equal(response.status, 200);
  assert.match((await response.json()).chinese, /测试失败/);
  assert.deepEqual(calls, [['inspect', 'r1', 's7', { attemptId: 'try2', asOfSeq: 31 }]]);
});

test('invalid historical sequence and traversal identifiers are rejected before service access', async t => {
  const { base, calls } = await fixture(t);
  assert.equal((await fetch(base + '/collab/api/runs/r1/steps/s7?asOfSeq=-1')).status, 400);
  assert.equal((await fetch(base + '/collab/api/runs/r1/steps/a%2Fb')).status, 400);
  assert.equal((await fetch(base + '/collab/api/runs/r1/steps/s7?attemptId=..')).status, 400);
  assert.deepEqual(calls, []);
});

test('artifact service receives exact run scope; a cross-run artifact is not disclosed', async t => {
  const { base, calls } = await fixture(t);
  const allowed = await fetch(base + '/collab/api/runs/r1/artifacts/a1?start=0&end=8');
  assert.equal(allowed.status, 200);
  assert.equal(await allowed.text(), 'original');
  assert.equal(allowed.headers.get('content-type'), 'application/octet-stream');
  assert.match(allowed.headers.get('content-disposition'), /^attachment/);
  const denied = await fetch(base + '/collab/api/runs/r2/artifacts/a1');
  assert.equal(denied.status, 404);
  assert.deepEqual(await denied.json(), { error: 'NOT_FOUND' });
  assert.equal(calls[1][1], 'r2');
});

test('artifact byte ranges are bounded', async t => {
  const { base, calls } = await fixture(t);
  assert.equal((await fetch(base + '/collab/api/runs/r1/artifacts/a1?start=9&end=1')).status, 400);
  assert.equal((await fetch(base + '/collab/api/runs/r1/artifacts/a1?end=9999999')).status, 400);
  assert.deepEqual(calls, []);
});

test('POST requires exact same origin and JSON, then calls pause without stopping Ticket', async t => {
  const { base, calls } = await fixture(t);
  const path = base + '/collab/api/runs/r1/pause';
  const post = headers => fetch(path, { method: 'POST', headers, body: JSON.stringify({ paused: true }) });
  assert.equal((await post({ 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await post({ Origin: 'https://attacker.example', 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await post({ Origin: base + '/fake', 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await post({ Origin: base, 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post({ Origin: base, 'Content-Type': 'application/json' })).status, 200);
  assert.deepEqual(calls, [['pause', 'r1', true]]);
});

test('POST validation prevents body scope override and oversized payloads', async t => {
  const { base, calls } = await fixture(t);
  const post = body => fetch(base + '/collab/api/runs/r1/pause', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body });
  assert.equal((await post(JSON.stringify({ paused: true, runId: 'r2' }))).status, 400);
  assert.equal((await post(JSON.stringify({ paused: 'true' }))).status, 400);
  assert.equal((await post('{')).status, 400);
  assert.equal((await post(JSON.stringify({ padding: 'x'.repeat(70 * 1024) }))).status, 413);
  assert.deepEqual(calls, []);
});

test('interrupt is explicitly scoped and missing bridge control is reported honestly', async t => {
  const { base, calls } = await fixture(t);
  const options = body => ({ method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await fetch(base + '/collab/api/runs/r1/interrupt', options({ agentId: 'child-1' }))).status, 200);
  const unsupported = await fetch(base + '/collab/api/runs/r1/control', options({ action: 'stop', idempotencyKey: 'cmd-1' }));
  assert.equal(unsupported.status, 409);
  assert.deepEqual(await unsupported.json(), { error: 'CAPABILITY_UNAVAILABLE' });
  assert.deepEqual(calls[0], ['interrupt', 'r1', 'child-1']);
  assert.deepEqual(calls[1], ['control', { runId: 'r1', action: 'stop', idempotencyKey: 'cmd-1' }]);
});

test('host checks reject rebinding hosts and error responses do not expose service secrets', async t => {
  const { base } = await fixture(t, { describeRun: () => { throw new Error('secret-api-key=DO_NOT_EXPOSE'); } });
  const unsafeHost = await new Promise((resolve, reject) => {
    const req = request(base + '/collab/api/status', { headers: { Host: 'attacker.example' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  assert.equal(unsafeHost, 403);
  const error = await fetch(base + '/collab/api/runs/r1');
  assert.equal(error.status, 500);
  assert.deepEqual(await error.json(), { error: 'INTERNAL_ERROR' });
});

test('remote peers are denied and frontend uses textContent instead of HTML insertion', async t => {
  const { handler } = await fixture(t);
  const response = { headersSent: false, headers: {}, setHeader(k,v) { this.headers[k]=v; }, end(value) { this.body=value; } };
  await handler({ socket: { remoteAddress: '10.0.0.1' }, headers: { host: '127.0.0.1:3080' }, method: 'GET', url: '/collab/api/status' }, response);
  assert.equal(response.statusCode, 403);
  assert.doesNotMatch(PANEL_SCRIPT, /innerHTML|insertAdjacentHTML|document\.write/);
  assert.match(PANEL_SCRIPT, /textContent/);
  assert.doesNotThrow(() => new Script(PANEL_SCRIPT));
});

test('single-user endpoints preserve exact raw input and require same-origin explicit actions',async t=>{
  const seen=[];
  const {base}=await fixture(t,{localWorkspace:{status:()=>({available:true,jobs:[]}),getTask:id=>({id}),
    startTask:body=>{seen.push(body);return {id:'task-12345678'};},
    previewCalculation:body=>{seen.push(body);return {previewId:'p1',modelCalls:0};},
    commitCalculation:body=>{seen.push(body);return {runId:'r1'};},interruptTask:id=>({id,status:'stopping'})}});
  const post=(path,body,origin=base)=>fetch(base+'/collab/api/local/'+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:typeof body==='string'?body:JSON.stringify(body)});
  assert.equal((await (await fetch(base+'/collab/api/local')).json()).available,true);
  assert.equal((await post('tasks',{prompt:'核对',requestId:'request-123'},'https://example.com')).status,403);assert.equal(seen.length,0);
  assert.equal((await post('tasks','{"prompt":"a","prompt":"b"}')).status,400);assert.equal(seen.length,0);
  assert.equal((await post('tasks',{prompt:'核对',requestId:'request-123'})).status,202);
  const raw='[{"amount":9007199254740993}]';assert.equal((await post('calculations/preview',{rowsJSON:raw,operation:'sum',field:'amount'})).status,200);assert.equal(seen.at(-1).rowsJSON,raw);
  assert.equal((await post('calculations/commit',{previewId:'p1',requestId:'save-123'})).status,200);
  assert.deepEqual(await (await fetch(base+'/collab/api/local/tasks/task-12345678')).json(),{id:'task-12345678'});
  assert.equal((await post('tasks/task-12345678/interrupt',{agentId:'override'})).status,400);
  assert.equal((await post('tasks/task-12345678/interrupt',{})).status,200);
});
