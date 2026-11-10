import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHttp } from '../src/app/http.ts'
import { LocalTaskSchema } from '../src/app/local-tasks.ts'

function serve(host = '127.0.0.1', port = 3082) {
  let handler
  const accepted = []
  registerHttp({ webServer: { host, port, register(route) { handler = route.handler; return () => {} } } }, {
    ready: Promise.resolve(), machine: { localOnly: true }, store: {},
    submitLocal(input) { accepted.push(LocalTaskSchema.parse(input)); return { triggerId: 'fixture-trigger', reused: false } },
  })
  return {
    accepted,
    async request(body, headers = {}) {
      let status, text
      const sent = Object.fromEntries(Object.entries({
        host: '127.0.0.1:3082', 'x-orchestrator-request': '1', 'content-type': 'application/json', ...headers,
      }).filter(([, value]) => value !== undefined))
      const bytes = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
      await handler({ method: 'POST', url: '/orchestrator/api/local/tasks', headers: sent,
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

test('returns 403 for external origins, mismatched hosts and missing management headers', async () => {
  const server = serve()
  for (const headers of [
    { 'x-orchestrator-request': undefined }, { host: 'external.example:3082' },
    { host: '127.0.0.1:9999' }, { origin: 'https://external.example' }, { origin: 'null' },
    { host: 'localhost:3082', origin: 'http://127.0.0.1:3082' },
  ]) assert.equal((await server.request(valid, headers)).status, 403)
  assert.equal(server.accepted.length, 0)
})

test('returns 413 for a streamed request larger than 128 KiB', async () => {
  const server = serve()
  assert.equal((await server.request({ ...valid, prompt: 'x'.repeat(128 * 1024) })).status, 413)
  assert.equal(server.accepted.length, 0)
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
