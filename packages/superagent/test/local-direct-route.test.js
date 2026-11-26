import assert from 'node:assert/strict'
import { mkdtempDisposableSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MasterAssessor } from '../src/app/assessment.ts'
import { Effects } from '../src/app/effects.ts'
import { installLocalSource, localAppendTrigger, localDirectOutcome, localTrigger, LocalTaskConflict } from '../src/app/local-tasks.ts'
import { followupNotice } from '../src/app/notices.ts'
import { Runtime } from '../src/app/runtime.ts'
import { Store } from '../src/app/store.ts'
import { Engine, threadKey } from '../src/core/index.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { settingsPolicy } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'

const submission = { requestId: 'direct-route-001', prompt: 'Check the current result\nPreserve identifier 007', outputFormat: 'json', directRoute: true }

test('existing ticket context, grouped messages and inferred requests stay on the coordinator path', () => {
  const trigger = localTrigger(submission, { triggers: { get() {} } })
  const next = localTrigger({ ...submission, requestId: 'direct-followup-002', prompt: 'Use the corrected value' }, { triggers: { get() {} } })
  const candidate = { strength: 'explicit', triggers: [trigger], tickets: [], thread: { ref: trigger.threads[0] } }
  assert.equal(localDirectOutcome(candidate).kind, 'accept')
  for (const change of [{ tickets: [{ id: 'existing-ticket' }] }, { triggers: [trigger, next] }, { strength: 'inferred' }]) {
    assert.equal(localDirectOutcome({ ...candidate, ...change }), undefined)
  }
})

function harness(path, localOnly = true) {
  const store = new Store(path)
  const sources = new SourceRegistry(() => store.settings())
  sources.register(installLocalSource(store))
  const effects = new Effects(store, new HealthBoard())
  const launched = []
  const relayed = []
  const outbox = []
  const assessor = new MasterAssessor({ get engine() { return engine }, effects, localOnly,
    paused: () => store.settings().paused,
    deliver: async (_id, card) => relayed.push(JSON.parse(card)),
    candidateCard: async candidate => ({ trigger_id: candidate.triggers.at(-1).id }) })
  const engine = new Engine({ repo: store, assessor, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    deferReadyCompletion: () => true,
    executor: { start: (ticket, assignment) => launched.push({ ticket, assignment }), deliver() {}, stop() {} },
    outbox: { send: message => outbox.push(message), withdraw() {}, status() {} } })
  return { store, engine, effects, outbox, launched, relayed,
    submit(input) { const trigger = localTrigger(input, store); return { result: engine.receive(trigger), trigger } },
    async settle() { engine.evaluateDue(); await effects.idle() },
    async close() { await effects.drain(); assessor.stop(); store.close() } }
}

test('explicit new local opt-in uses native admission and launches once without a router prompt', async () => {
  using directory = mkdtempDisposableSync(join(tmpdir(), 'llsa-local-direct-'))
  const host = harness(join(directory.path, 'state.sqlite'))
  try {
    host.effects.start()
    const { trigger, result } = host.submit(submission)
    assert.equal(result, 'stored')
    assert.equal(host.submit(submission).result, 'duplicate')
    assert.throws(() => host.submit({ ...submission, directRoute: undefined }), LocalTaskConflict)
    assert.throws(() => host.submit({ ...submission, prompt: 'Different input' }), LocalTaskConflict)
    await host.settle()
    assert.deepEqual(host.relayed, [])
    assert.equal(host.launched.length, 1)
    assert.equal(host.outbox.filter(reply => reply.kind === 'acknowledgement').length, 1)
    const [{ ticket, assignment }] = host.launched
    assert.equal(ticket.origin.triggerId, trigger.id)
    assert.equal(ticket.title, 'Check the current result')
    const [decision] = host.store.decisions.byThread(threadKey(trigger.threads[0]))
    assert.equal(decision.ticketId, ticket.id)
    assert.equal(decision.audit.route, 'local-direct')
    assert.equal(decision.strength, 'explicit')
    assert.equal(decision.mandate.actor.id, 'owner')
    host.engine.assignmentStarted(ticket.id, assignment.id)
    assert.equal(host.engine.report(ticket.id, { state: 'ready', summary: '{"id":"007"}' }).ended, undefined)
    assert.equal(host.outbox.filter(reply => reply.kind === 'reply').length, 0)
    assert.equal(host.submit(submission).result, 'duplicate')
    await host.settle()
    assert.equal(host.launched.length, 1)
  } finally {
    await host.close()
  }
})

test('an authenticated owner append still reaches the native ticket while only it skips a coordinator relay', async () => {
  using directory = mkdtempDisposableSync(join(tmpdir(), 'llsa-local-append-'))
  const host = harness(join(directory.path, 'state.sqlite'))
  try {
    host.effects.start()
    host.submit(submission)
    await host.settle()
    const { ticket, assignment } = host.launched[0]
    host.engine.assignmentStarted(ticket.id, assignment.id)
    const input = { requestId: 'followup-input-001', prompt: 'Use the corrected value 009.' }
    const appended = localAppendTrigger(ticket.id, input, host.store)
    assert.equal(host.engine.receive(appended), 'stored')
    assert.deepEqual(host.store.triggers.disposition(appended.id).fanout, [ticket.id])
    assert.equal(followupNotice(host.store, {}, appended.id), undefined)
    assert.ok(host.store.tickets.get(ticket.id).inputs.some(item => item.triggerId === appended.id))
    assert.deepEqual(localAppendTrigger(ticket.id, input, host.store), host.store.triggers.get(appended.id))
    assert.throws(() => localAppendTrigger(ticket.id, { ...input, prompt: 'Changed' }, host.store), LocalTaskConflict)
    const ordinary = { ...appended, id: 'ordinary-text', text: 'Stop the task', meta: {} }
    assert.equal(host.engine.receive(ordinary), 'stored')
    assert.equal(JSON.parse(followupNotice(host.store, { repliesTo: () => undefined }, ordinary.id).text).trigger_id, ordinary.id)
    host.engine.stopTicket(ticket.id)
    assert.throws(() => localAppendTrigger(ticket.id, { ...input, requestId: 'followup-input-002' }, host.store), LocalTaskConflict)
  } finally { await host.close() }
})

test('serial local append consumes one issued predecessor even while paused and replays an identical request', async () => {
  using directory = mkdtempDisposableSync(join(tmpdir(), 'llsa-serial-append-'))
  const host = harness(join(directory.path, 'state.sqlite'))
  try {
    host.effects.start()
    host.submit(submission)
    await host.settle()
    const { ticket, assignment } = host.launched[0]
    host.engine.assignmentStarted(ticket.id, assignment.id)
    const input = { requestId: 'serial-append-001', prompt: 'Begin the next stage.', afterReplyId: 'issued-result-a' }
    let issuedReply = 'issued-result-a'
    let scheduledPasses = 0
    const runtime = { machine: { localOnly: true }, configured: () => true, closing: () => false,
      store: host.store, engine: host.engine, passes: { request() { scheduledPasses++ } },
      collabBridge: { isCurrentIssuedLocalReply: (current, replyId) => current.id === ticket.id && replyId === issuedReply } }
    const append = value => Runtime.prototype.appendLocal.call(runtime, ticket.id, value)

    assert.throws(() => append(input), LocalTaskConflict)
    host.engine.report(ticket.id, { state: 'ready', summary: '{"id":"007"}' })
    assert.throws(() => append(input), LocalTaskConflict, 'a ready worker report alone is insufficient')
    host.engine.acceptReadyReport(ticket.id, assignment.id)
    assert.throws(() => append({ ...input, afterReplyId: 'missing-result' }), LocalTaskConflict)
    assert.throws(() => append({ ...input, afterReplyId: {} }), /invalid_type/)
    host.store.saveSettings({ ...host.store.settings(), paused: true })

    const accepted = append(input)
    assert.equal(accepted.reused, false)
    assert.equal(host.store.triggers.get(accepted.triggerId).meta.localAppendAfterReplyId, input.afterReplyId)
    assert.equal(host.store.tickets.get(ticket.id).ended?.outcome, 'completed', 'a paused Engine has not resumed the ticket')
    assert.throws(() => append({ ...input, requestId: 'serial-append-002' }), LocalTaskConflict)
    issuedReply = 'issued-result-b'
    assert.deepEqual(append(input), { triggerId: accepted.triggerId, reused: true })
    assert.throws(() => append({ ...input, afterReplyId: undefined }), LocalTaskConflict)
    assert.throws(() => append({ ...input, afterReplyId: issuedReply }), LocalTaskConflict)
    assert.throws(() => append({ ...input, prompt: 'Different content' }), LocalTaskConflict)
    assert.equal(scheduledPasses, 1)
  } finally { await host.close() }
})

test('paused admission stays pending through restart and is routed exactly once after resume', async () => {
  using directory = mkdtempDisposableSync(join(tmpdir(), 'llsa-local-direct-resume-'))
  const path = join(directory.path, 'state.sqlite')
  const before = harness(path)
  try {
    before.submit(submission)
    before.engine.evaluateDue()
    assert.equal(before.effects.pending('assessment'), true)
    before.store.saveSettings({ ...before.store.settings(), paused: true })
    before.effects.start()
    await before.settle()
    assert.equal(before.launched.length, 0)
    assert.deepEqual(before.relayed, [])
  } finally { await before.close() }
  const after = harness(path)
  try {
    after.effects.start()
    await after.settle()
    assert.equal(after.launched.length, 0)
    assert.deepEqual(after.relayed, [])
    after.store.saveSettings({ ...after.store.settings(), paused: false })
    await after.settle()
    assert.equal(after.launched.length, 1)
    assert.deepEqual(after.relayed, [])
    assert.equal(after.effects.pending('assessment'), false)
  } finally { await after.close() }
})

test('local direct admission respects native access policy and leaves the legacy route as default', async () => {
  using directory = mkdtempDisposableSync(join(tmpdir(), 'llsa-local-direct-policy-'))
  const host = harness(join(directory.path, 'state.sqlite'))
  try {
    host.effects.start()
    const ordinary = host.submit({ ...submission, directRoute: undefined })
    await host.settle()
    assert.equal(host.launched.length, 0)
    assert.deepEqual(host.relayed, [{ kind: 'candidate', trigger_id: ordinary.trigger.id }])

    const settings = host.store.settings()
    host.store.saveSettings({ ...settings, policy: { ...settings.policy,
      sources: { ...settings.policy.sources, local: { allowed: [] } } } })
    const refused = host.submit({ ...submission, requestId: 'direct-route-002' })
    await host.settle()
    assert.equal(host.launched.length, 0)
    assert.equal(host.relayed.length, 1)
    const [decision] = host.store.decisions.byThread(threadKey(refused.trigger.threads[0]))
    assert.equal(decision.kind, 'ignore')
  } finally { await host.close() }
})

test('a direct flag outside local deployment cannot skip the router', async () => {
  using directory = mkdtempDisposableSync(join(tmpdir(), 'llsa-local-direct-external-'))
  const host = harness(join(directory.path, 'state.sqlite'), false)
  try {
    host.effects.start()
    const { trigger } = host.submit(submission)
    await host.settle()
    assert.equal(host.launched.length, 0)
    assert.deepEqual(host.relayed, [{ kind: 'candidate', trigger_id: trigger.id }])
  } finally { await host.close() }
})
