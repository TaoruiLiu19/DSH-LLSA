import assert from 'node:assert/strict'
import test from 'node:test'
import { readSessionEvents } from '../src/app/session-events.ts'
import { transcriptEntry } from '../src/app/context.ts'

const envelope = seq => ({ type: 'extension/fixture', seq, time: 1, data: { original: true } })

test('reads chronological pages pinned to the first cursor and preserves extensible wire events', async () => {
  const requests = []
  const controller = { async events(request) {
    requests.push(request)
    return requests.length === 1
      ? { cursor: 10, hasMore: true, records: [8, 9].map(seq => ({ type: 'event', event: envelope(seq) })) }
      : { cursor: 15, hasMore: false, records: [2, 3].map(seq => ({ type: 'event', event: envelope(seq) })) }
  } }
  const result = await readSessionEvents(controller, 'fixture-session', new AbortController().signal)
  assert.deepEqual(result.map(event => event.seq), [2, 3, 8, 9])
  assert.deepEqual(result[0].data, { original: true })
  assert.equal(Object.hasOwn(requests[0], 'throughSeq'), false)
  assert.equal(Object.hasOwn(requests[0], 'beforeSeq'), false)
  assert.equal(requests[1].throughSeq, 10)
  assert.equal(requests[1].beforeSeq, 8)
})

test('rejects nonadvancing history instead of returning an incomplete result', async () => {
  const controller = { async events() { return { cursor: 10, hasMore: true, records: [{ type: 'event', event: envelope(8) }] } } }
  await assert.rejects(() => readSessionEvents(controller, 'fixture-session', new AbortController().signal), /cursor did not advance/)
})

test('honors cancellation before calling the history API', async () => {
  const controller = { async events() { assert.fail('must not call an aborted API') } }
  await assert.rejects(() => readSessionEvents(controller, 'fixture-session', AbortSignal.abort()), { name: 'AbortError' })
})

test('renders validated messages while omitting reasoning blocks and rejects malformed known events', () => {
  assert.deepEqual(transcriptEntry({ type: 'assistant/message', data: { message: { role: 'assistant', content: [
    { type: 'reasoning', text: 'private reasoning' }, { type: 'text', text: 'Result' },
  ] } } }), { type: 'assistant/message', message: { role: 'assistant', content: [{ type: 'text', text: 'Result' }] } })
  assert.equal(transcriptEntry(envelope(1)), undefined)
  assert.throws(() => transcriptEntry({ type: 'user/message', data: { content: [] } }), /Invalid user\/message/)
  assert.throws(() => transcriptEntry({ type: 'user/message', data: { role: 'user', content: [null] } }), /Invalid user\/message/)
})
