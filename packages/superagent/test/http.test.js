import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { registerHttp } from '../src/app/http.ts'
import { LOCAL_PANEL } from '../src/app/local-panel.ts'
import { LocalTaskSchema, MAX_LOCAL_TASK_BODY_BYTES } from '../src/app/local-tasks.ts'

function serve(host = '127.0.0.1', port = 3082, connectionRejection) {
  let handler, currentAssignment = 'first'
  const accepted = []
  registerHttp({ get: () => ({ requestRejection: () => connectionRejection }), webServer: { host, port, register(route) { handler = route.handler; return () => {} } } }, {
    ready: Promise.resolve(), machine: { localOnly: true }, store: { tickets: { get: id => id === 'fixture-ticket'
      ? { assignments: [{ id: currentAssignment }] } : undefined } },
    engine: { retryTicket(id) { accepted.push({ retried: id }); currentAssignment = 'replacement' } },
    submitLocal(input) { accepted.push(LocalTaskSchema.parse(input)); return { triggerId: 'fixture-trigger', reused: false } },
    appendLocal(id, input) { accepted.push({ id, input }); return { triggerId: 'fixture-append', reused: false } },
  })
  return {
    accepted,
    async request(body, headers = {}, path = 'local/tasks') {
      let status, text
      const sent = Object.fromEntries(Object.entries({
        host: '127.0.0.1:3082', 'x-orchestrator-request': '1', 'content-type': 'application/json', ...headers,
      }).filter(([, value]) => value !== undefined))
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
      await handler({ method: 'POST', url: '/orchestrator/api/' + path, headers: sent,
        async *[Symbol.asyncIterator]() { yield bytes.subarray(0, 100); yield bytes.subarray(100) } }, {
        writeHead(code) { status = code }, end(value) { text = value },
      })
      return { status, body: JSON.parse(text) }
    },
  }
}
const valid = { requestId: 'fixture-request-1', prompt: 'Summarize this supplied text.' }

test('accepts valid same-origin JSON requests', async () => {
  const server = serve()
  assert.equal((await server.request(valid, { origin: 'http://127.0.0.1:3082', 'content-type': 'application/json; charset=utf-8' })).status, 200)
  assert.deepEqual(server.accepted, [{ ...valid, outputFormat: 'text' }])
})

test('direct routing remains behind Harness connection authentication', async () => {
  const input = { ...valid, directRoute: true }
  const untrusted = serve('127.0.0.1', 3082, 401)
  assert.equal((await untrusted.request(input)).status, 401)
  assert.deepEqual(untrusted.accepted, [])
  const trusted = serve()
  assert.equal((await trusted.request(input)).status, 200)
  assert.deepEqual(trusted.accepted, [{ ...input, outputFormat: 'text' }])
})

test('local follow-up writes require the same authentication and address one existing ticket', async () => {
  const path = 'local/tasks/fixture-ticket/followups'
  const denied = serve('127.0.0.1', 3082, 401)
  assert.equal((await denied.request(valid, {}, path)).status, 401)
  assert.deepEqual(denied.accepted, [])
  const server = serve()
  assert.equal((await server.request(valid, {}, 'local/tasks/missing-ticket/followups')).status, 404)
  assert.equal((await server.request(valid, {}, path)).status, 200)
  assert.deepEqual(server.accepted, [{ id: 'fixture-ticket', input: valid }])
})

test('an assignment-bound owner retry rejects a stale or duplicated attempt and keeps the existing API usable', async () => {
  const path = 'tickets/fixture-ticket/retry'
  const denied = serve('127.0.0.1', 3082, 401)
  assert.equal((await denied.request({}, {}, path + '?assignmentId=first')).status, 401)
  assert.deepEqual(denied.accepted, [])
  const service = serve()
  assert.equal((await service.request({}, {}, path + '?assignmentId=unknown')).status, 409)
  assert.deepEqual(service.accepted, [])
  assert.deepEqual(await service.request({}, {}, path + '?assignmentId=first'), { status: 200, body: { retried: true } })
  assert.equal((await service.request({}, {}, path + '?assignmentId=first')).status, 409)
  assert.deepEqual(service.accepted, [{ retried: 'fixture-ticket' }])
  assert.equal((await serve().request({}, {}, path)).status, 200)
})

test('the native new-ticket form requests direct dispatch and retries a lost response with the same request ID', async () => {
  const server = serve()
  const elements = new Map()
  function element(id) {
    if (!elements.has(id)) elements.set(id, { value: '', checked: false, append() {}, replaceChildren() {} })
    return elements.get(id)
  }
  let sequence = 0
  let loseResponse = true
  runInNewContext(LOCAL_PANEL.match(/<script>([\s\S]*?)<\/script>/)[1], {
    document: { getElementById: element, createElement: () => ({}) }, setInterval() {},
    crypto: { randomUUID: () => 'fixture-panel-' + ++sequence },
    async fetch(path, options) {
      assert.equal(path, '/orchestrator/api/local/tasks')
      if (options.method === 'GET') return Response.json({ tickets: [], replies: [] })
      const result = await server.request(options.body, options.headers)
      if (loseResponse) { loseResponse = false; throw new Error('Connection interrupted after submission') }
      return Response.json(result.body, { status: result.status })
    },
  })
  element('prompt').value = '  核对 007  '
  await element('submit').onclick()
  assert.match(element('error').textContent, /interrupted/)
  await element('submit').onclick()
  element('prompt').value = '核对 007'
  element('json-output').checked = true
  await element('submit').onclick()
  assert.deepEqual(server.accepted, [
    { requestId: 'fixture-panel-1', prompt: '核对 007', outputFormat: 'text', directRoute: true },
    { requestId: 'fixture-panel-1', prompt: '核对 007', outputFormat: 'text', directRoute: true },
    { requestId: 'fixture-panel-2', prompt: '核对 007', outputFormat: 'json', directRoute: true },
  ])
})

test('the panel treats changed output bytes as draft and appends only to the verified sent reply', async () => {
  function el(tag) {
    return { tag, children: [], value: '', append(node) { this.children.push(node) },
      replaceChildren() { this.children = [] }, setAttribute() {}, focus() {} }
  }
  const elements = new Map()
  const element = id => {
    if (!elements.has(id)) elements.set(id, el(id))
    return elements.get(id)
  }
  const row = { ticket: { id: 'fixture-ticket', title: '页面',
    origin: { triggerIds: [] }, inputs: [], assignments: [], ended: { outcome: 'completed' } },
  artifactWorkspace: { directory: '/fixture', files: ['index.html'], outputs: [{ path: 'index.html', status: 'draft' }] } }
  const replies = [
    { id: 'human-question', ticketId: row.ticket.id, kind: 'reply', status: 'sent', text: '需要确认范围。' },
    { id: 'actual-issued', ticketId: row.ticket.id, kind: 'reply', status: 'sent', text: '页面已验收。' },
  ]
  let followed
  runInNewContext(LOCAL_PANEL.match(/<script>([\s\S]*?)<\/script>/)[1], {
    document: { getElementById: element, createElement: el }, setInterval() {},
    crypto: { randomUUID: () => 'followup-fixture-1' },
    async fetch(path, options) {
      if (options.method === 'GET') return Response.json({ tickets: [row], replies })
      assert.equal(path, '/orchestrator/api/local/tasks/fixture-ticket/followups')
      followed = JSON.parse(options.body)
      return Response.json({ triggerId: 'followup' })
    },
  })
  await new Promise(resolve => setImmediate(resolve))
  const nodes = node => [node, ...node.children.flatMap(nodes)]
  const labels = () => nodes(element('tasks'))
  assert.ok(labels().some(node => node.textContent === '当前版本待确认'))
  assert.ok(labels().some(node => node.textContent === '下载草稿'))
  assert.ok(!labels().some(node => node.textContent === '已交付' || node.textContent === '追加要求'))

  row.issuedReplyId = 'actual-issued'
  row.artifactWorkspace.outputs[0].status = 'delivered'
  await element('refresh').onclick()
  labels().find(node => node.textContent === '追加要求').onclick()
  element('prompt').value = '改标题'
  await element('submit').onclick()
  assert.deepEqual(followed, { requestId: 'followup-fixture-1', prompt: '改标题', afterReplyId: 'actual-issued' })
})

test('returns 403 for external origins, mismatched hosts and missing management headers', async () => {
  const server = serve()
  for (const headers of [
    { 'x-orchestrator-request': undefined }, { host: 'external.example:3082' },
    { host: '127.0.0.1:9999' }, { origin: 'https://external.example' }, { origin: 'null' },
    { host: 'localhost:3082', origin: 'http://127.0.0.1:3082' },
  ]) assert.equal((await server.request(valid, headers)).status, 403)
  assert.equal(server.accepted.length, 0)
})

test('keeps separate bounds for a new file task and other local request bodies', async () => {
  const server = serve()
  assert.equal((await server.request({ ...valid, prompt: 'x'.repeat(MAX_LOCAL_TASK_BODY_BYTES) })).status, 413)
  assert.equal((await server.request({ ...valid, prompt: 'x'.repeat(128 * 1024) }, {}, 'local/tasks/fixture-ticket/followups')).status, 413)
  assert.equal(server.accepted.length, 0)
})

test('authenticated file tasks accept valid UTF-8 above the ordinary body limit', async () => {
  const server = serve()
  const input = { ...valid, artifactFiles: ['out.md'], artifactInputs: ['input/源.txt'],
    workspaceFiles: [{ path: 'input/源.txt', text: '\uFEFF' + '界'.repeat(46_000) }] }
  assert.equal((await server.request(input, { origin: 'http://localhost:3082' })).status, 403)
  assert.equal((await serve('127.0.0.1', 3082, 401).request(input)).status, 401)
  assert.equal((await server.request(input)).status, 200)
  assert.deepEqual(server.accepted, [{ ...input, outputFormat: 'text' }])
  assert.equal((await server.request(Buffer.concat([Buffer.from('{"prompt":"'), Buffer.from([0xFF]), Buffer.from('"}')]))).status, 400)
})

test('returns 415 for non-JSON or missing content types', async () => {
  const server = serve()
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', undefined]) {
    assert.equal((await server.request(valid, { 'content-type': type })).status, 415)
  }
  assert.equal(server.accepted.length, 0)
})

test('returns 400 for malformed JSON and unknown task fields', async () => {
  const server = serve()
  assert.equal((await server.request('{broken')).status, 400)
  assert.equal((await server.request({ ...valid, unexpected: true })).status, 400)
  assert.equal(server.accepted.length, 0)
})

test('supports IPv6 loopback and refuses a non-loopback server binding', async () => {
  assert.equal((await serve('::1').request(valid, { host: '[::1]:3082', origin: 'http://[::1]:3082' })).status, 200)
  assert.throws(() => serve('0.0.0.0'), /loopback Web server/)
  assert.throws(() => serve('::'), /loopback Web server/)
})
