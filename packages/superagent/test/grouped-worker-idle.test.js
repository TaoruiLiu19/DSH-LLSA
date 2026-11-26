import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempDisposableSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CollabBridge } from '../src/app/collab-bridge.ts'
import { Store } from '../src/app/store.ts'
import { reportRelay } from '../src/app/notices.ts'
import { DshExecutor } from '../src/executor/dsh.ts'

test('grouped handoff preserves the worker idle timestamp without relaying a misleading waiting report', async () => {
  const assignment = { id: 'assignment', state: 'running' }
  const ticket = { id: 'ticket', title: 'Section work', assignments: [assignment], inputs: [],
    undelivered: [], origin: { triggerId: 'source' }, mandate: { strength: 'explicit' } }
  const calls = []
  let grouped = true
  const agent = { id: 'worker-ticket', status: 'idle', whenIdle: async () => {}, session: { snapshotEvents: () => [] } }
  const executor = new DshExecutor({
    context: { get: () => undefined },
    store: { tickets: { get: () => ticket }, atomic: run => run() },
    engine: {
      turnEnded(ticketId, assignmentId) { calls.push(['turn', ticketId, assignmentId]) },
      report(ticketId, report) { calls.push(['report', ticketId, report.state]); return ticket },
    },
    effects: { handle() {} },
    sessions: { relay() { calls.push(['relay']) } },
    closing: () => false, lifetime: new AbortController().signal,
    awaitingSectionBatch: (current, sessionId) => grouped && current === ticket && sessionId === agent.id,
  })
  await executor.workerIdle(ticket, assignment, agent)
  assert.deepEqual(calls, [['turn', 'ticket', 'assignment']])

  grouped = false
  await executor.workerIdle(ticket, assignment, agent)
  assert.deepEqual(calls, [
    ['turn', 'ticket', 'assignment'],
    ['turn', 'ticket', 'assignment'], ['report', 'ticket', 'waiting'], ['relay'],
  ])
})

test('ordinary local worker waits remain on the ticket and in durable history without waking the main session', async t => {
  const dir = mkdtempDisposableSync(join(tmpdir(), 'llsa-idle-status-'))
  const file = join(dir.path, 'state.sqlite')
  const relays = []
  let store, bridge
  function open() {
    store = new Store(file)
    bridge = new CollabBridge(new Context(), { store, masterId: 'master', engine: {}, sessions: { relay: (...args) => relays.push(args) } })
  }
  open()
  t.after(() => { bridge.close(); store.close(); dir.remove() })
  const ticket = { id: 'task', title: 'Reduce motion', assignments: [{ id: 'assignment', state: 'running' }], inputs: [],
    undelivered: [], origin: { triggerId: 'origin', triggerIds: ['origin'] }, mandate: { strength: 'explicit' } }
  store.tickets.save(ticket)
  let seq = 45, turn = 1, text = 'Working on a component.'
  const agent = { id: 'worker-task', status: 'idle', whenIdle: async () => {}, session: { snapshotEvents: () => [
    { type: 'turn/start', seq: seq - 2, data: { turn } },
    { type: 'assistant/message', seq: seq - 1, data: { turn, message: { content: [{ type: 'text', text }] } } },
    { type: 'turn/end', seq, data: { turn, reason: { kind: 'completed' } } },
  ] } }
  const executor = new DshExecutor({
    context: { get: () => undefined }, store, effects: { handle() {} }, closing: () => false, lifetime: new AbortController().signal,
    sessions: { relay: (...args) => relays.push(args) }, engine: {
      turnEnded() {},
      report(id, report) {
        const updated = store.tickets.get(id)
        updated.assignments[0].report = { ...report, at: '2026-11-20T05:00:00Z' }
        store.tickets.save(updated)
        return updated
      },
    }, recordIdleStatus: (...args) => bridge.recordIdleStatus(...args),
  })
  const idle = async () => { const current = store.tickets.get(ticket.id); await executor.workerIdle(current, current.assignments[0], agent) }
  await idle()
  await idle() // Duplicate idle after the same turn.
  seq = 61; turn = 2; text = 'Waiting for the next item.'
  await idle()
  assert.equal(store.tickets.get('task').assignments[0].report.summary, text)
  assert.deepEqual(relays, [])
  bridge.close(); store.close(); open()
  const saved = bridge.readLifecycle().events.map(event => event.payload)
  assert.deepEqual(saved.map(item => [item.ticketId, item.assignmentId, item.state, item.turnEndSeq, item.summary]), [
    ['task', 'assignment', 'waiting', 45, 'Working on a component.'],
    ['task', 'assignment', 'waiting', 61, 'Waiting for the next item.'],
  ])
  assert.deepEqual(bridge.readEvents().events, [])
  assert.deepEqual(relays, [])
  executor.dispose()
})

test('routine progress is passive while a question, an answer, a ready result and a blocker reach the coordinator', () => {
  const ticket = { id: 'T', title: 'Task', assignments: [{ id: 'A', state: 'running' }], inputs: [], undelivered: [],
    origin: { triggerId: 'in', triggerIds: ['in'] }, mandate: { strength: 'explicit' } }
  assert.equal(reportRelay(ticket, { state: 'progress', summary: 'Working' }), undefined)
  for (const state of ['ready', 'blocked', 'failed']) {
    assert.equal(JSON.parse(reportRelay(ticket, { state, summary: state }).text).state, state)
  }
  const answer = reportRelay(ticket, { state: 'progress', summary: 'Earlier answer', answers: 'user-question' })
  assert.equal(JSON.parse(answer.text).answer_to, 'user-question')
  const asked = reportRelay({ ...ticket, attention: { id: 'q', question: 'Choose a color?' } },
    { state: 'progress', summary: 'Confirming choice', question: 'Choose a color?' })
  assert.equal(JSON.parse(asked.text).kind, 'worker_attention')
})
