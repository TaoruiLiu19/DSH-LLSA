import assert from 'node:assert/strict'
import test from 'node:test'
import { browserAdvisor } from '../src/browser-advisor.js'
import { ChildConsultations } from '../src/child-consultations.js'

const input = (runId, options = {}) => ({
  runId, workItemId: 'step-1', attemptId: 'attempt-1', inputVersion: 'v1',
  question: 'Should the identifier retain leading zeroes?', ...options,
})
const answer = (id, body) => ({ markdown: `<!-- web-consultation:${id} -->\r\n${body}` })

test('manual Markdown routes out-of-order answers by exact correlation marker', async () => {
  const queue = new ChildConsultations({ available: false })
  const replyA = queue.ask(input('run-A'))
  const replyB = queue.ask(input('run-B'))
  const { pending: [a, b] } = queue.listPending()
  assert.equal(a.runId, 'run-A')
  assert.equal(b.runId, 'run-B')
  assert.match(a.copyText, new RegExp(a.id))
  assert.throws(() => queue.complete(a.id, answer(b.id, 'B only')), { code: 'CHILD_CONSULTATION_MARKER_MISMATCH' })
  assert.deepEqual(queue.complete(b.id, answer(b.id, 'Keep **042**.')), { id: b.id })
  assert.deepEqual(queue.complete(a.id, answer(a.id, 'Keep **007**.')), { id: a.id })
  assert.deepEqual(await replyA, { consultationId: a.id, markdown: 'Keep **007**.', provider: 'manual' })
  assert.deepEqual(await replyB, { consultationId: b.id, markdown: 'Keep **042**.', provider: 'manual' })
  assert.deepEqual(queue.complete(b.id, answer(b.id, 'Keep **042**.')), { id: b.id })
  assert.throws(() => queue.complete(b.id, answer(b.id, 'Overwrite!')), { code: 'CHILD_CONSULTATION_ALREADY_COMPLETED' })
  assert.deepEqual(queue.listPending(), { pending: [] })
})

test('manual queue rejects stale, cancelled, timed-out and oversized replies', async () => {
  const queue = new ChildConsultations({ available: false })
  let current = true
  const stale = assert.rejects(queue.ask(input('run-stale', { isCurrent: () => current })), { code: 'CHILD_CONSULTATION_STALE' })
  const abort = new AbortController()
  const cancelled = assert.rejects(queue.ask(input('run-abort', { signal: abort.signal })), { code: 'CHILD_CONSULTATION_CANCELLED' })
  const { pending: [a, b] } = queue.listPending()
  assert.throws(() => queue.complete(a.id, answer(a.id, '字'.repeat(700))), { code: 'CHILD_CONSULTATION_MARKDOWN_INVALID' })
  current = false
  assert.throws(() => queue.complete(a.id, answer(a.id, 'Old version')), { code: 'CHILD_CONSULTATION_STALE' })
  abort.abort()
  assert.throws(() => queue.complete(b.id, answer(b.id, 'Late reply')), { code: 'CHILD_CONSULTATION_NOT_FOUND' })
  await Promise.all([stale, cancelled])
  assert.deepEqual(queue.listPending(), { pending: [] })
  const shortQueue = new ChildConsultations({ available: false }, { manualTimeoutMs: 25 })
  await assert.rejects(shortQueue.ask(input('run-timeout')), { code: 'CHILD_CONSULTATION_TIMEOUT' })
  assert.deepEqual(shortQueue.listPending(), { pending: [] })
})

test('automatic consultation sends only the bounded question and forwards host cancellation', async () => {
  const config = {
    DSH_WEB_COLLAB_OPEN_WEBUI_URL: 'http://127.0.0.1:3000',
    DSH_WEB_COLLAB_OPEN_WEBUI_MODEL: 'fixture',
    DSH_WEB_COLLAB_OPEN_WEBUI_KEY: 'fixture-key',
  }
  const started = Promise.withResolvers()
  let count = 0
  const advisor = browserAdvisor(config, (_url, options) => {
    count++
    const body = JSON.parse(options.body)
    assert.equal(body.max_tokens, 256)
    assert.match(body.messages[0].content, /concise Markdown/)
    assert.equal(body.messages[1].content, input('unused').question)
    assert.doesNotMatch(options.body, /run-A|attempt-1/)
    if (count === 1) return Response.json({
      choices: [{ message: { content: 'Keep the original **string**.' }, finish_reason: 'stop' }],
    })
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
      started.resolve()
    })
  })
  const queue = new ChildConsultations(advisor)
  const result = await queue.ask(input('run-A'))
  assert.equal(result.provider, 'open-webui')
  assert.equal(result.markdown, 'Keep the original **string**.')
  const abort = new AbortController()
  const cancelled = assert.rejects(queue.ask(input('run-B', { signal: abort.signal })), { code: 'CHILD_CONSULTATION_CANCELLED' })
  await started.promise
  await assert.rejects(queue.ask(input('run-C')), { code: 'ADVISOR_BUSY' })
  assert.equal(count, 2)
  abort.abort()
  await cancelled
  assert.equal(count, 2)
})
