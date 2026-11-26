import assert from 'node:assert/strict'
import test from 'node:test'
import { messageId } from '../src/app/delivery.ts'
import { mainTools } from '../src/app/tools/main.ts'
import { localCoordinatorPhase } from '../src/app/sessions.ts'
import { key } from '../src/core/index.ts'

function fixture() {
  const reportId = 'report', relay = 'native-report-message'
  const call = { type: 'tool-call', id: 'call', name: 'orchestrator_collab_finish' }
  const user = source => ({ type: 'user/message', data: { id: messageId(key(relay)), source } })
  const start = { type: 'turn/start', data: { turn: 1 } }
  const assistant = { type: 'assistant/message', data: { turn: 1, step: 3, message: { content: [call] } } }
  const events = [start, user({ kind: 'runtime-context', form: 'snapshot' }), user({ kind: 'dsh-superagent', form: 'relay' }), assistant]
  const agent = { session: { snapshotEvents: () => events }, inbox: { nextStep: [], nextTurn: [] } }
  let concluded = 0
  const execution = { agent, signal: new AbortController().signal, callId: call.id, concludeTurn: () => concluded++ }
  const review = { reportId, ticketId: 'T', accepted: false }
  const collabBridge = {
    reportTicket: () => review.ticketId, reviewReport: () => review, localReplyFormat: () => 'text',
    readReport: () => ({ deliveredRelay: { id: relay } }),
  }
  const tools = mainTools({ resources: {}, store: { atomic: run => run() }, quietly: run => run(),
    requestPass() {}, collabBridge }, agent)
  const finish = tools.find(tool => tool.name === call.name)
  const args = { report_id: reportId, accepted: false, reason: 'The reported date differs from record 7.' }
  return { events, assistant, execution, agent, review, collabBridge, user, count: () => concluded,
    run: (local = true) => finish.execute(args, execution.signal, local ? execution : undefined) }
}

test('only a single unambiguous native relay gets a narrow coordinator tool set', () => {
  const native = payload => ({ source: { kind: 'dsh-superagent', form: 'relay' },
    content: [{ type: 'text', text: JSON.stringify(payload) }] })
  const candidate = { kind: 'candidate', strength: 'explicit', trigger_id: 'local-1' }
  const review = { state: 'ready', report_id: 'report-1' }
  const runtime = { source: { kind: 'runtime-context', form: 'snapshot' } }
  assert.equal(localCoordinatorPhase([native(candidate)]), 'route')
  assert.equal(localCoordinatorPhase([runtime, native(review)]), 'review')
  for (const messages of [
    [native({ ...candidate, related_tickets: ['T'] })],
    [native({ ...candidate, batch: ['other'] })],
    [native({ kind: 'follow_up', trigger_id: 'local-2' })],
    [native({ ...review, answers: 'user-question' })],
    [native(review), native(candidate)],
    [{ ...native(review), source: { kind: 'user' } }],
  ]) assert.equal(localCoordinatorPhase(messages), undefined)
})

test('a local, single-tool, sole-input rejection yields the original receipt and ends the paid turn', async () => {
  const h = fixture()
  assert.deepEqual(await h.run(), { review: h.review })
  assert.equal(h.count(), 1)
})

test('rejection only concludes for a matched local relay and leaves mixed work, retries and other traffic active', async () => {
  for (const change of [
    h => { h.events.splice(1, 0, h.user({ kind: 'user' })) },
    h => { h.events.splice(1, 0, h.user({ kind: 'dsh-superagent', form: 'relay' })) },
    h => { h.events[2].data.id = messageId(key('other-report')) },
    h => { h.events[2].data.source = { kind: 'user' } },
    h => { h.agent.inbox.nextStep.push(h.user({ kind: 'user' })) },
    h => { h.agent.inbox.nextTurn.push(h.user({ kind: 'user' })) },
    h => { h.execution.parent = Symbol('nested') },
    h => { h.execution.callId = 'other-call' },
    h => { h.assistant.data.message.content.push({ type: 'tool-call', id: 'read', name: 'orchestrator_read' }) },
    h => { h.execution.signal = AbortSignal.abort() },
    h => { h.events.push({ type: 'turn/end', data: { turn: 1 } }) },
    h => { h.review.status = 'unchanged_result' },
    h => { h.collabBridge.readReport = () => undefined },
    h => { h.collabBridge.localReplyFormat = () => undefined },
  ]) {
    const h = fixture(); change(h)
    await h.run()
    assert.equal(h.count(), 0)
  }
  const external = fixture()
  await external.run(false)
  assert.equal(external.count(), 0)
  const error = fixture()
  error.collabBridge.reviewReport = () => { throw Error('Report is stale') }
  await assert.rejects(error.run(), /stale/)
  assert.equal(error.count(), 0)
})

test('a sole successful explicit route ends its local turn while refused, queued and non-local work continues', async () => {
  for (const mode of ['accepted', 'refused', 'queued', 'external', 'other-trigger']) {
    const h = fixture()
    h.assistant.data.message.content[0].name = 'orchestrator_route'
    h.events[2].data.content = [{ type: 'text', text: JSON.stringify({
      kind: 'candidate', strength: 'explicit', trigger_id: mode === 'other-trigger' ? 'other' : 't',
    }) }]
    if (mode === 'queued') h.agent.inbox.nextStep.push(h.user({ kind: 'user' }))
    const decision = mode === 'refused' ? { kind: 'ignore', reason: { code: 'explicitRouted' } }
      : { kind: 'accept', ticketId: 'ticket', reason: { code: 'explicitRouted' }, triggerIds: ['t'] }
    const tools = mainTools({ resources: {}, store: { triggers: { disposition() {} }, tickets: { get: () => ({
      id: 'ticket', title: 'Work', assignments: [], origin: { triggerId: 't' }, inputs: [], mandate: { strength: 'explicit' },
    }) } }, engine: { decide: () => decision }, requestPass() {} }, h.agent)
    const route = tools.find(tool => tool.name === 'orchestrator_route')
    const result = await route.execute({ decisions: [{ trigger_id: 't', kind: 'accept', title: 'Work',
      worktree_name: 'work', acknowledgement: 'Accepted the work.' }] }, h.execution.signal, mode === 'external' ? undefined : h.execution)
    assert.equal(result.results[0].decision, mode === 'refused' ? undefined : 'accept')
    assert.equal(h.count(), mode === 'accepted' ? 1 : 0, mode)
  }
})
