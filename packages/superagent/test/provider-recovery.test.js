import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import { DshExecutor, transient } from '../src/executor/dsh.ts'
import { CollabBridge } from '../src/app/collab-bridge.ts'
import { Store } from '../src/app/store.ts'
import { Effects } from '../src/app/effects.ts'
import { installReviewRecovery } from '../src/app/review-recovery.ts'
import { artifactRecovery } from '../src/app/artifact-recovery.ts'
import { localTrigger } from '../src/app/local-tasks.ts'

const outage = () => new LlmError('API_TRANSPORT_ERROR', 'INVALID_REQUEST', { status: 502 })

test('uses actual Harness provider facts and leaves permanent errors terminal', () => {
  assert.equal(transient(outage()), true)
  assert.equal(transient(outage().failure), true)
  for (const code of ['TIMEOUT', 'TRANSPORT', 'SERVER', 'RATE_LIMIT']) {
    assert.equal(transient(new LlmError('Interrupted upstream', code).failure), true)
  }
  for (const [message, code, status] of [
    ['bad credentials', 'AUTH', 401], ['limit', 'ACCOUNT_QUOTA', 429],
    ['MODEL_CALL_LIMIT', 'INVALID_REQUEST', 429], ['invalid row', 'INVALID_REQUEST', 400], ['user stopped', 'ABORTED', 502],
  ]) assert.equal(transient(new LlmError(message, code, { status })), false)
})

function workerHost({ artifact = false } = {}) {
  const events = {}, timers = [], prompts = [], failed = [], relays = []
  const ticket = { id: 'T', assignments: [{ id: 'A', state: 'running' }], inputs: [], undelivered: [] }
  const source = artifact && localTrigger({ requestId: 'local-budget-recovery', prompt: 'Write a file', artifactFiles: ['index.html'] },
    { triggers: { get() {} } })
  if (source) ticket.origin = { triggerId: source.id, triggerIds: [source.id] }
  let turn = 2
  const agent = { id: 'worker-T', status: 'idle', session: { snapshotEvents: () => [{ type: 'turn/start', data: { turn } }] } }
  const executor = new DshExecutor({
    context: { agents: { get: () => agent }, on(name, cb) { events[name] = cb; return () => {} } },
    effects: { handle() {} }, closing: () => false, paused: () => false,
    machine: { localOnly: true },
    store: { tickets: { get: () => ticket, open: () => [ticket] }, triggers: { get: () => source },
      settings: () => ({ executor: { maxWorkers: 1 } }), atomic: run => run() },
    health: { get: () => ({ state: 'ready' }) },
    engine: { report(id, report) {
      failed.push({ id, report })
      ticket.assignments[0].report = { ...report, at: '2026-11-26T01:00:00Z' }
      return ticket
    } },
    sessions: { async prompt(_session, id, _text, _mode, authorize) { authorize(); prompts.push(id) },
      relay(id, text) { relays.push({ id, text }) } },
  })
  executor.after = (ms, go) => { timers.push({ ms, go }) }
  if (!artifact) executor.failed = (id, message) => { failed.push({ id, message }) }
  executor.install()
  const fail = (n, error = outage()) => { turn = n; events['agent/error']({ agent, error, turn }) }
  const run = async () => { timers.shift().go(); await new Promise(resolve => setImmediate(resolve)) }
  return { executor, ticket, timers, prompts, failed, relays, fail, run, userTurn: n => { turn = n } }
}

test('native file budget failure is visible to the owner without waking either model', async () => {
  const h = workerHost({ artifact: true })
  const error = Object.assign(new Error('Run token admission budget exceeded'), { code: 'TOKEN_BUDGET', status: 429 })
  h.fail(2, error); h.fail(2, error)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.failed.length, 1)
  assert.equal(h.failed[0].report.failureCode, 'token_budget')
  assert.deepEqual(h.timers, [])
  assert.deepEqual(h.relays, [])
  assert.deepEqual(h.prompts, [])
  const recovery = artifactRecovery(h.ticket)
  assert.equal(recovery.kind, 'token_budget')
  assert.equal(recovery.canRetry, true)
  assert.equal(recovery.assignmentId, 'A')
  assert.match(recovery.message, /saved files remain/i)
  h.ticket.assignments[0].report.summary = 'Error: Run token admission budget exceeded'
  delete h.ticket.assignments[0].report.failureCode
  assert.equal(artifactRecovery(h.ticket).kind, 'token_budget')
  h.ticket.assignments.push({ id: 'B', state: 'pending' })
  assert.equal(artifactRecovery(h.ticket), undefined)
})

test('transient worker failures queue an idempotent resume and stop after three consecutive attempts', async () => {
  const host = workerHost()
  for (let turn = 2; turn <= 4; turn++) {
    host.fail(turn); host.fail(turn)
    assert.equal(host.timers.length, 1)
    assert.equal(host.timers[0].ms, 15000 * 2 ** (turn - 2))
    await host.run()
  }
  host.fail(5); host.fail(5)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.timers.length, 0)
  assert.equal(host.failed.length, 1)
  assert.deepEqual(host.prompts, ['retry:A:turn:2', 'retry:A:turn:3', 'retry:A:turn:4'])
})

test('a ready report, cancellation, new assignment or later user turn supersedes worker recovery', async () => {
  for (const change of [
    h => { h.ticket.assignments[0].report = { state: 'ready' } },
    h => { h.ticket.ended = { by: 'operator' } },
    h => { h.ticket.assignments[0].id = 'B' },
    h => { h.userTurn(3) },
    h => { h.ticket.attention = { id: 'question' } },
  ]) {
    const host = workerHost()
    host.fail(2); change(host); await host.run()
    assert.deepEqual(host.prompts, [])
    assert.deepEqual(host.failed, [])
  }
})

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'llsa-review-recovery-'))
  const path = join(dir, 'state.sqlite')
  const at = new Date().toISOString()
  const source = { id: 'source', source: 'local', actor: { source: 'local', id: 'owner' }, human: true,
    threads: [{ source: 'local', id: 'thread' }], text: 'Reconcile all rows', meta: { outputFormat: 'json' }, at }
  const ticket = { id: 'T', decisionId: 'd', title: 'Rows', mandate: { strength: 'explicit' }, channels: [],
    assignments: [{ id: 'A', state: 'running', report: { state: 'ready', at, summary: '{}' } }], inputs: [], undelivered: [],
    origin: { triggerId: 'source', triggerIds: ['source'] }, createdAt: at, updatedAt: at }
  let store, bridge, effects, listener, clock = 0, paused = false
  const sent = [], ids = new Set(), board = { claim: () => ({ set() {} }) }
  const promptedId = id => 'dsh-superagent:' + id
  const install = () => {
    store = new Store(path)
    effects = new Effects(store, board, () => clock)
    bridge = new CollabBridge(new Context(), { store, masterId: 'master', sessions: { relay() {} },
      engine: { acceptReadyReport() {} } })
    bridge.registerLifecycle({ bindWorker() {}, beforeReady() {} })
    installReviewRecovery({ on(_name, cb) { listener = cb; return () => {} } }, {
      store, bridge, effects, masterId: 'master', closing: () => false, paused: () => paused,
      sessions: { promptedId, async prompt(_master, id, text, mode, authorize) {
        authorize()
        if (!ids.has(id)) { ids.add(id); sent.push({ id, text, mode }) }
      } },
    })
    effects.start()
  }
  install()
  store.triggers.save(source); store.tickets.save(ticket)
  const report = bridge.recordReport(ticket, { state: 'ready', summary: '{}' }, { id: 'relay', text: '{}' })
  const failTurn = (turn, ids, reason = { kind: 'error', error: outage().failure }, kind = 'dsh-superagent', extra = []) => {
    const data = { turn, reason }
    const events = [{ type: 'turn/start', data: { turn } }, ...ids.map(id => ({
      type: 'user/message', data: { id: promptedId(id), source: { kind }, content: [{
        type: 'text', text: sent.find(message => message.id === id)?.text ?? 'Original relay',
      }] } })), ...extra, { type: 'turn/end', data }]
    listener({ id: 'master', snapshotEvents: () => events }, { type: 'turn/end', data })
  }
  const close = async () => { await effects.drain(); bridge.close(); store.close() }
  t.after(async () => { await close(); rmSync(dir, { force: true, recursive: true }) })
  return { report, ticket, source, sent, failTurn, get store() { return store }, get bridge() { return bridge },
    advance: async ms => { clock += ms; await effects.idle() },
    pause: value => { paused = value },
    restart: async () => { await close(); install() },
  }
}

test('one master consuming four reports can finish one per turn and carry the remaining reviews across restart and a 502', async t => {
  const f = fixture(t)
  const reports = [f.report, ...['B', 'C', 'D'].map(id => {
    const ticket = { ...f.ticket, id }
    f.store.tickets.save(ticket)
    return f.bridge.recordReport(ticket, { state: 'ready', summary: '{}' }, { id, text: '{}' })
  })]
  const finish = (turn, inputs, report) => {
    f.bridge.reviewReport(report.id, true, 'checked')
    const callId = 'call-' + turn
    const result = { status: 'sent', replyId: 'reply-' + report.id, review: { reportId: report.id, accepted: true } }
    f.failTurn(turn, inputs, { kind: 'completed' }, 'dsh-superagent', [
      { type: 'tool/call', data: { name: 'orchestrator_collab_finish', callId } },
      { type: 'tool/result', data: { message: { toolCallId: callId, isError: false, content: [{ type: 'text', text: JSON.stringify(result) }] } } },
    ])
  }
  finish(1, ['relay', 'B', 'C', 'D'], reports[0])
  await f.restart(); await f.advance(1)
  assert.equal(f.sent.length, 3)
  const second = f.sent.map(message => message.id)
  finish(2, second, reports[1]); await f.advance(1)
  assert.equal(f.sent.length, 5)
  const third = f.sent.slice(3).map(message => message.id)
  f.failTurn(3, third); await f.advance(2000)
  assert.equal(f.sent.length, 7)
  const fourth = f.sent.slice(5).map(message => message.id)
  finish(4, fourth, reports[2]); await f.advance(1)
  assert.equal(f.sent.length, 8)
  const fifth = f.sent.at(-1)
  assert.equal(JSON.parse(fifth.text).attempt, 1, 'ordinary continuation preserves the consumed failure budget')
  finish(5, [fifth.id], reports[3]); await f.advance(1)
  assert.equal(f.sent.length, 8)
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM collab_bridge_reviews').get().n, 4)
})

test('an ordinary master turn ending without any successful delivery cannot create a polling loop', async t => {
  const f = fixture(t)
  f.failTurn(1, ['relay', 'other'], { kind: 'completed' })
  await f.advance(5000)
  assert.deepEqual(f.sent, [])
})

test('interrupted master review wakes after restart, keeps the report immutable, and stops after two model retries', async t => {
  const f = fixture(t)
  f.failTurn(1, ['unrelated'])
  f.failTurn(2, ['relay'], { kind: 'aborted' })
  f.failTurn(3, ['relay'], { kind: 'error', error: { status: 401, message: 'AUTH' } })
  f.failTurn(4, ['relay'], undefined, 'user')
  await f.advance(5000)
  assert.equal(f.sent.length, 0)
  f.failTurn(5, ['relay']); f.failTurn(5, ['relay'])
  await f.advance(1000)
  assert.equal(f.sent.length, 0)
  await f.restart()
  f.pause(true); await f.advance(2000)
  assert.equal(f.sent.length, 0)
  f.pause(false); await f.advance(1)
  assert.equal(f.sent.length, 1)
  const first = f.sent[0]
  assert.ok(first.text.includes(f.report.id))
  assert.equal(first.text.includes('Reconcile all rows'), false)
  assert.equal(first.mode, 'queue')
  f.failTurn(6, [first.id]); await f.advance(5000)
  assert.equal(f.sent.length, 2)
  f.failTurn(7, [f.sent[1].id]); await f.advance(5000)
  assert.equal(f.sent.length, 2)
  assert.equal(f.bridge.readEvents().events.length, 1)
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM collab_bridge_reviews').get().n, 0)
})

for (const [name, change] of Object.entries({
  review: f => f.bridge.reviewReport(f.report.id, true, 'checked'),
  cancellation: f => f.store.tickets.save({ ...f.ticket, ended: { by: 'operator' } }),
  assignment: f => f.store.tickets.save({ ...f.ticket, assignments: [{ id: 'new', state: 'running' }] }),
  correction: f => f.store.triggers.save({ ...f.source, text: 'Updated requirements' }),
  newerReport: f => f.bridge.recordReport(f.ticket, { state: 'progress', summary: 'New evidence' }),
})) test(`queued master recovery observes ${name} before delivery`, async t => {
  const f = fixture(t)
  f.failTurn(1, ['relay']); change(f); await f.advance(2500)
  assert.deepEqual(f.sent, [])
})
