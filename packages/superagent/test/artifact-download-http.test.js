import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHttp } from '../src/app/http.ts'
import { LocalArtifactDownload, LocalArtifactDownloadError } from '../src/app/local-artifact-download.ts'

const name = '目录/交付.html'
const bytes = Buffer.from('\ufeff<script>globalThis.test=true</script>\r\n')
const sha = 'a'.repeat(64)

function route({ localOnly = true, rejection } = {}) {
  let run
  const calls = []
  registerHttp({
    get: () => ({ requestRejection: () => rejection }),
    webServer: { host: '127.0.0.1', port: 3082, register(record) { run = record.handler; return () => {} } },
  }, {
    ready: Promise.resolve(), machine: { localOnly }, store: {},
    downloadLocalArtifact(id, path, draft, digest) {
      calls.push({ id, path, draft, digest })
      if (!draft) throw new LocalArtifactDownloadError(409, 'This version has not been delivered.')
      return new LocalArtifactDownload(path, bytes, 'draft')
    },
  })
  return {
    calls,
    async request(query, headers = {}) {
      let status, out, body
      await run({ method: 'GET', url: '/orchestrator/api/local/tasks/fixture/artifacts?' + new URLSearchParams(query),
        headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers } }, {
        writeHead(code, fields) { status = code; out = fields }, end(value) { body = value },
      })
      return { status, headers: out, body }
    },
  }
}

test('file downloads require authenticated same-origin local requests', async () => {
  const query = { path: name, draft: '1' }
  for (const [server, headers, expected] of [
    [route({ rejection: 401 }), {}, 401],
    [route({ localOnly: false }), {}, 404],
    [route(), { 'x-orchestrator-request': undefined }, 403],
    [route(), { origin: 'http://external.example' }, 403],
  ]) {
    assert.equal((await server.request(query, headers)).status, expected)
    assert.deepEqual(server.calls, [])
  }
})

test('scope parameters and revision pins reach an inert exact-byte attachment', async () => {
  const server = route()
  assert.equal((await server.request({ path: name, draft: 'false' })).status, 400)
  assert.equal((await server.request({ path: name, sha256: 'invalid' })).status, 400)
  assert.equal((await server.request({ path: name })).status, 409)
  const { status, body, headers } = await server.request({ path: name, draft: '1', sha256: sha })
  assert.equal(status, 200)
  assert.deepEqual(server.calls.at(-1), { id: 'fixture', path: name, draft: true, digest: sha })
  assert.deepEqual(body, bytes)
  assert.equal(headers['content-type'], 'application/octet-stream')
  assert.equal(headers['content-length'], bytes.length)
  assert.equal(headers['x-llsa-artifact-status'], 'draft')
  assert.equal(headers['x-content-type-options'], 'nosniff')
  assert.equal(headers['cache-control'], 'no-store')
  assert.equal(headers['content-security-policy'], "sandbox; default-src 'none'")
  assert.match(headers['content-disposition'], /^attachment; filename="__\.html"; filename\*=UTF-8''/)
  assert.ok(headers['content-disposition'].endsWith(encodeURIComponent('交付.html')))
})
