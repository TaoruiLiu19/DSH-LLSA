import assert from 'node:assert/strict'
import { mkdtempDisposableSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AgentDelivery } from '../src/app/delivery.ts'
import { localAppendTrigger, localTrigger } from '../src/app/local-tasks.ts'
import { Config, machineOf } from '../src/deployment.ts'
import { DshExecutor } from '../src/executor/dsh.ts'

const longText = '核对显示结果。\n' + 'Keep \\"quoted\\" values and  007. '.repeat(54) + '\nRun the final check.'

function fixture(directory, text = longText, machine = { localOnly: true, inlineLocalWorkerNotices: true }) {
  const items = new Map()
  const triggers = { get: id => items.get(id) }
  const origin = localTrigger({ requestId: 'local-worker-notice-origin', prompt: text }, { triggers })
  items.set(origin.id, origin)
  const assignment = { id: 'assignment', state: 'running' }
  const ticket = { id: 'ticket', title: 'Local worker task', assignments: [assignment], inputs: [], undelivered: [],
    origin: { triggerId: origin.id, triggerIds: [origin.id] },
    mandate: { strength: 'explicit', actor: origin.actor }, execution: { directory, assignment: '' } }
  const notices = [], delivered = []
  let holdsInitial = false, beforeSend, sendPrompt
  const agent = { status: 'idle', inbox: { remove() {} } }
  const host = { machine, lifetime: new AbortController().signal, effects: { handle() {} },
    context: { agents: { get: () => agent } },
    closing: () => false, paused: () => false, sourceLink: async () => ({}), repliedTo: () => undefined,
    sessions: { ensure: async () => agent, holds: async (_sessionId, id) => holdsInitial && id === 'assignment:ticket',
      promptedId: id => 'notice:' + id, prompt: async (sessionId, id, message, mode, authorize, accepted) => {
      beforeSend?.({ id, mode })
      if (sendPrompt) return sendPrompt(id, message, mode, authorize, accepted)
      authorize()
      notices.push({ sessionId, id, message, mode })
      accepted?.()
    } },
    store: { tickets: { get: () => ticket, open: () => [ticket] }, triggers,
      settings: () => ({ executor: { maxWorkers: 1 } }) },
    engine: { assignmentStarted(_ticketId, id) { ticket.assignments.find(row => row.id === id).state = 'running' },
      inputsDelivered(_ticketId, id, ids) {
        delivered.push({ assignmentId: id, ids })
        ticket.undelivered = ticket.undelivered.filter(inputId => !ids.includes(inputId))
      } } }
  const executor = new DshExecutor(host)
  return { origin, ticket, machine, notices, delivered, agent,
    launch: () => executor.launch(ticket, ticket.assignments.at(-1)),
    deliverWaiting: () => executor.deliverQueued(ticket.id),
    beforeSend(callback) { beforeSend = callback },
    usePrompt(callback) { sendPrompt = callback },
    append(prompt = longText, ticketId = ticket.id, afterReplyId) {
      const trigger = localAppendTrigger(ticketId, { requestId: 'local-worker-notice-update', prompt,
        ...(afterReplyId ? { afterReplyId } : {}) }, {
        triggers, tickets: { get: () => ({ ...ticket, id: ticketId }) },
        threads: { get: () => ({ subscriptions: [ticketId] }) },
      }, (_ticket, id) => id === 'issued-predecessor')
      return trigger
    },
    resume({ serial = true, history = true, priorReason, context = false } = {}) {
      holdsInitial = history
      assignment.state = 'ended'
      assignment.report = { state: 'ready', summary: 'Earlier result' }
      if (priorReason) assignment.endedReason = priorReason
      ticket.ended = { by: 'executor', outcome: 'completed' }
      const trigger = this.append(longText, ticket.id, serial ? 'issued-predecessor' : undefined)
      items.set(trigger.id, trigger)
      delete ticket.ended
      ticket.assignments.push({ id: 'next', state: 'pending' })
      ticket.inputs.push({ kind: 'resumed', id: 'resume', triggerId: trigger.id, at: trigger.at },
        { kind: 'trigger', id: 'owner', triggerId: trigger.id, human: true, context, at: trigger.at })
      ticket.undelivered.push('resume', 'owner')
      return trigger
    },
    deliver(trigger, properties = {}) {
      items.set(trigger.id, trigger)
      return executor.deliverInput(ticket, assignment,
        { id: 'follow-up-input', kind: 'trigger', triggerId: trigger.id, at: trigger.at, ...properties })
    },
  }
}

test('full local worker notices explicitly opt in and use the existing assignment and append delivery paths', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'llsa-worker-notice-'))
  assert.equal(machineOf(Config({ stateDir: dir.path })).inlineLocalWorkerNotices, false)
  const machine = machineOf(Config({ stateDir: dir.path, localOnly: true, inlineLocalWorkerNotices: true }))
  assert.equal(machine.inlineLocalWorkerNotices, true)
  const h = fixture(dir.path, longText, machine)
  await h.launch()
  const update = h.append()
  await h.deliver(update)
  const [initial, followup] = h.notices
  assert.deepEqual(h.notices.map(({ sessionId, id, mode }) => [sessionId, id, mode]), [
    ['worker-ticket', 'assignment:ticket', 'queue'], ['worker-ticket', 'follow-up-input', 'steer'],
  ])
  for (const [card, trigger, { message }] of [
    [JSON.parse(initial.message).trigger, h.origin, initial], [JSON.parse(followup.message), update, followup],
  ]) {
    assert.equal(card.text_complete, true)
    assert.equal(card.text, trigger.text)
    assert.equal(card.chars, undefined)
    assert.equal(card.read, `trigger/${trigger.id}`)
    assert.ok(message.length > 1500)
    assert.ok(Buffer.byteLength(message) <= 4096)
  }
  assert.equal(JSON.parse(followup.message).input_action, 'owner_appended_to_this_ticket')
})

test('full delivery preserves bounded references for larger UTF-8 and escaped JSON notices', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'llsa-worker-notice-size-'))
  for (const text of ['界'.repeat(1400), '\\'.repeat(2050)]) {
    const h = fixture(dir.path, text)
    await h.launch()
    const update = h.append(text)
    await h.deliver(update)
    const [initial, followup] = h.notices.map(({ message }) => JSON.parse(message))
    for (const [card, trigger] of [[initial.trigger, h.origin], [followup, update]]) {
      assert.equal(card.text_complete, undefined)
      assert.equal(card.text, text.slice(0, 600) + '…')
      assert.equal(card.read, `trigger/${trigger.id}`)
    }
  }
})

test('legacy previews remain for disabled, inferred, grouped, external and context-only delivery', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'llsa-worker-notice-scope-'))
  for (const change of [
    h => { delete h.machine.inlineLocalWorkerNotices },
    h => { h.machine.localOnly = false },
    h => { h.ticket.mandate.strength = 'inferred' },
    h => { h.ticket.origin.triggerIds.push('other-source') },
    h => { h.origin.source = 'feishu' },
    h => { h.origin.channel.address.requestId = 'other-thread' },
  ]) {
    const h = fixture(dir.path)
    change(h)
    await h.launch()
    const card = JSON.parse(h.notices[0].message).trigger
    assert.equal(card.text_complete, undefined)
    assert.equal(card.read, `trigger/${h.origin.id}`)
    assert.equal(card.text, longText.slice(0, 600) + '…')
  }

  const h = fixture(dir.path)
  for (const [trigger, properties] of [
    [h.append(), { context: true }],
    [h.append(longText, 'another-ticket')],
    [{ ...h.append(), id: 'ordinary-local-message', meta: {} }],
  ]) {
    await h.deliver(trigger, properties)
    const card = JSON.parse(h.notices.at(-1).message)
    assert.equal(card.text_complete, undefined)
    assert.equal(card.read, `trigger/${trigger.id}`)
    assert.equal(card.text, longText.slice(0, 600) + '…')
  }
  assert.equal(JSON.parse(h.notices[0].message).context, true)
})

test('a verified serial owner reopen wakes only for its actual input and keeps both notices durable', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'llsa-local-owner-reopen-'))
  const h = fixture(dir.path)
  const trigger = h.resume()
  await h.launch()
  await h.deliverWaiting()
  assert.deepEqual(h.notices.map(({ id, mode }) => [id, mode]), [
    ['assignment:ticket:next', { inject: 'Assignment resumed' }],
    ['resume', { inject: 'Ticket resumed' }],
    ['owner', 'steer'],
  ])
  assert.match(h.notices[1].message, /resumed it under the same mandate/)
  assert.deepEqual(JSON.parse(h.notices[2].message), {
    ...JSON.parse(h.notices[2].message), trigger_id: trigger.id, text: trigger.text,
    text_complete: true, read: `trigger/${trigger.id}`, input_action: 'owner_appended_to_this_ticket',
  })
  assert.deepEqual(h.delivered, [{ assignmentId: 'next', ids: ['resume'] }, { assignmentId: 'next', ids: ['owner'] }])
  assert.equal(h.ticket.undelivered.length, 0)
})

test('unsigned reopen, cold worker, retry, and context-only input keep their normal wake sequence', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'llsa-owner-reopen-scope-'))
  for (const options of [{ serial: false }, { history: false }, { priorReason: 'retried' }, { context: true }]) {
    const h = fixture(dir.path)
    h.resume(options)
    await h.launch()
    await h.deliverWaiting()
    assert.deepEqual(h.notices.map(({ mode }) => mode), ['queue', 'steer', 'steer'])
  }
})

test('human stop or changed owner delivery order prevents a stale non-waking resume', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'llsa-owner-reopen-guard-'))
  const stopped = fixture(dir.path)
  stopped.resume()
  stopped.ticket.ended = { by: 'human', outcome: 'stopped' }
  await stopped.launch()
  await stopped.deliverWaiting()
  assert.deepEqual(stopped.notices, [])

  const changed = fixture(dir.path)
  changed.resume()
  changed.beforeSend(({ id }) => {
    if (id === 'assignment:ticket:next') changed.ticket.undelivered.reverse()
  })
  await assert.rejects(changed.launch(), /Serial owner continuation changed/)
  assert.deepEqual(changed.notices, [])
  assert.deepEqual(changed.delivered, [])
  assert.equal(changed.ticket.assignments.at(-1).state, 'pending')
})

test('serial reopen keeps the assignment pending on flush failure and replays without duplicate notice or owner wake', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'llsa-owner-reopen-flush-'))
  for (const recovery of ['retry-buffered', 'restart-durable', 'restart-uncommitted']) {
    const h = fixture(dir.path)
    h.resume()
    const buffered = [], persisted = [], injected = [], steered = []
    let fail = true
    const persist = () => persisted.push(...buffered.splice(0))
    Object.assign(h.agent, { id: 'worker-ticket', session: {},
      inbox: { nextTurn: [], nextStep: [], remove() {} },
      inject(message) { injected.push(message.id); buffered.push({ type: 'user/message', data: message }) },
      steer(message) { steered.push(message.id) },
    })
    const context = { on() {}, agents: { get: () => h.agent }, sessionPersistence: {
      async flush() {
        if (fail && buffered.length) {
          fail = false
          if (recovery === 'restart-durable') persist()
          throw new Error('Assignment notice flush failed')
        }
        persist()
      },
      async open() {
        return { async read(offset) { return { events: persisted.slice(offset) } }, async [Symbol.asyncDispose]() {} }
      },
    } }
    const useSession = () => {
      const delivery = new AgentDelivery(context)
      h.usePrompt((id, message, mode, authorize, accepted) =>
        delivery.send(h.agent, id, message, mode, new AbortController().signal, authorize, accepted))
    }
    useSession()
    await assert.rejects(h.launch(), /Assignment notice flush failed/)
    assert.equal(h.ticket.assignments.at(-1).state, 'pending')
    assert.deepEqual(h.ticket.undelivered, ['resume', 'owner'])
    await h.deliverWaiting()
    assert.deepEqual(steered, [])

    if (recovery !== 'retry-buffered') {
      h.agent.session = {}
      if (recovery === 'restart-uncommitted') buffered.length = 0
      useSession()
    }
    await h.launch()
    assert.equal(h.ticket.assignments.at(-1).state, 'running')
    const assignmentId = 'dsh-superagent:assignment:ticket:next'
    assert.equal(persisted.filter(event => event.data.id === assignmentId).length, 1)
    assert.equal(injected.filter(id => id === assignmentId).length, recovery === 'restart-uncommitted' ? 2 : 1)
    await h.deliverWaiting()
    assert.deepEqual(steered, ['dsh-superagent:owner'])
    assert.deepEqual(h.delivered, [{ assignmentId: 'next', ids: ['resume'] }, { assignmentId: 'next', ids: ['owner'] }])
  }
})
