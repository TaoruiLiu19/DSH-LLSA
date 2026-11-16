import assert from 'node:assert/strict'
import test from 'node:test'
import { browserAdvisor } from '../src/browser-advisor.js'

const config = {
  DSH_WEB_COLLAB_OPEN_WEBUI_URL: 'http://127.0.0.1:3000',
  DSH_WEB_COLLAB_OPEN_WEBUI_MODEL: 'fixture',
  DSH_WEB_COLLAB_OPEN_WEBUI_KEY: 'fixture-key',
}
const reply = (content, finish_reason = 'stop') => Response.json({ choices: [{ message: { content }, finish_reason }] })

test('consults the configured Open WebUI with only the reviewed context and one bounded reply', async () => {
  const calls = []
  const advisor = browserAdvisor(config, async (url, options) => {
    calls.push({ url: url.href, options, body: JSON.parse(options.body) })
    return reply(' 核对原始编号。 ')
  })
  assert.equal(advisor.available, true)
  assert.deepEqual(await advisor.consult({ context: ' 原始编号为 007。 ' }), { advice: '核对原始编号。' })
  assert.equal(calls.length, 1)
  const [{ url, options, body }] = calls
  assert.equal(url, 'http://127.0.0.1:3000/api/chat/completions')
  assert.equal(options.redirect, 'error')
  assert.equal(options.headers.Authorization, 'Bearer fixture-key')
  assert.equal(body.model, 'fixture')
  assert.equal(body.stream, false)
  assert.equal(body.max_tokens, 512)
  assert.deepEqual(body.tool_ids, [])
  assert.deepEqual(body.messages[1], { role: 'user', content: '原始编号为 007。' })
  assert.equal(body.chat_id, undefined)
})

test('manual consultation remains available when the endpoint is not configured', async () => {
  const advisor = browserAdvisor({ ...config, DSH_WEB_COLLAB_OPEN_WEBUI_URL: 'http://external.test:3000' },
    () => assert.fail('No outbound request should be made'))
  assert.equal(advisor.available, false)
  await assert.rejects(advisor.consult({ context: 'Review this.' }), { code: 'ADVISOR_UNAVAILABLE' })
})

test('rejects duplicate in-flight calls, oversized context and truncated advice', async () => {
  const pending = Promise.withResolvers()
  const advisor = browserAdvisor(config, () => pending.promise)
  await assert.rejects(advisor.consult({ context: '字'.repeat(3000) }), { code: 'INVALID_WEB_CONTEXT' })
  await assert.rejects(advisor.consult({ context: 'Review this.', model: 'untrusted' }), { code: 'INVALID_WEB_CONTEXT' })
  const first = advisor.consult({ context: 'Review this.' })
  await assert.rejects(advisor.consult({ context: 'Second.' }), { code: 'ADVISOR_BUSY' })
  pending.resolve(reply('Partial.', 'length'))
  await assert.rejects(first, { code: 'INVALID_WEB_ADVICE' })
  const oversized = browserAdvisor(config, async () => reply('字'.repeat(1400)))
  await assert.rejects(oversized.consult({ context: 'Review this.' }), { code: 'INVALID_WEB_ADVICE' })
})
