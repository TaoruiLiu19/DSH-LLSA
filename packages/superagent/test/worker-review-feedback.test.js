import assert from 'node:assert/strict'
import { mkdtempDisposableSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CollabBridge } from '../src/app/collab-bridge.ts'
import { readResource } from '../src/app/resources.ts'
import { Store } from '../src/app/store.ts'
import { DshExecutor, inputMessage, inputResource } from '../src/executor/dsh.ts'
import { Engine } from '../src/core/engine.ts'
import { key } from '../src/core/ids.ts'
import { messageId } from '../src/app/delivery.ts'

function setup(t, { fresh = false, outputFormat = 'json', submissionHint } = {}) {
  const dir = mkdtempDisposableSync(join(tmpdir(), 'llsa-worker-review-'))
  const store = new Store(join(dir.path, 'state.sqlite'))
  const at = '2026-11-19T00:00:00Z'
  const source = { id: 's', text: 'A human task', human: true, source: 'local', at,
    threads: [{ source: 'local', id: 't' }], actor: { source: 'local', id: 'u' }, meta: fresh ? { outputFormat } : {} }
  const ticket = { id: 't', title: 'A task', origin: { triggerId: 's', triggerIds: ['s'] }, mandate: { strength: 'explicit' },
    assignments: [{ id: 'a', state: 'running', report: { state: 'ready', at }, deliveredAt: at }],
    updatedAt: at, createdAt: at, inputs: [], undelivered: [] }
  if (fresh) delete ticket.assignments[0].report
  store.triggers.save(source)
  store.tickets.save(ticket)
  const sent = [], status = [], prompts = [], deliveries = [], promptTexts = []
  const readySubmissionHint = ticketId => ticketId === ticket.id ? submissionHint : undefined
  let history = []
  let beforeAuthorize = () => {}
  const current = () => store.tickets.get('t')
  const engine = {
    note(id, text, feedback) {
      const live = current()
      const note = { id: 'n' + (live.inputs.length + 1), kind: 'note', text, at,
        ...(typeof feedback === 'string' ? { reviewOf: feedback } : { submissionFor: feedback }) }
      live.inputs.push(note); live.undelivered.push(note.id)
      store.tickets.save(live)
    },
    turnEnded() {},
    inputsDelivered(_id, _assignment, ids) {
      const live = current()
      live.undelivered = live.undelivered.filter(id => !ids.includes(id))
      store.tickets.save(live)
      deliveries.push(...ids)
    },
    report(id, report) { const live = current(); live.assignments[0].report = { ...report, at }; store.tickets.save(live); status.push(report); return live },
  }
  const bridge = new CollabBridge(new Context(), { store, masterId: 'main', engine,
    workerHistory: sessionId => sessionId === 'worker-t' ? history : undefined, sessions: { relay() {} } })
  bridge.registerLifecycle({ bindWorker() {}, beforeReady() {} })
  const executor = new DshExecutor({
    context: { agents: { get: () => ({ status: 'running' }) }, get: () => undefined }, closing: () => false, lifetime: new AbortController().signal,
    engine, store, effects: { handle() {} }, health: { get: () => ({ state: 'ready' }), set() {} },
    sessions: { promptedId: id => 'native:' + id, relay: (_id, text) => sent.push(JSON.parse(text)),
      async prompt(_worker, id, text, _mode, authorize) { beforeAuthorize(); authorize(); prompts.push(id); promptTexts.push(text) } },
    readySubmissionHint,
    recoverReviewFeedback: (...args) => bridge.recoverReviewFeedback(...args),
    discardSupersededReminder: (...args) => bridge.discardSupersededReminder(...args),
    recoverDraftSubmission: (...args) => bridge.recoverDraftSubmission(...args),
    discardSupersededSubmission: (...args) => bridge.discardSupersededSubmission(...args),
    ...(fresh && outputFormat === 'text' ? { recordIdleStatus: (...args) => bridge.recordIdleStatus(...args) } : {}),
  })
  const report = fresh ? undefined : bridge.recordReport(ticket, { state: 'ready', summary: 'unverified old answer' })
  if (report) bridge.reviewReport(report.id, false, 'Check what was known at the cutoff.')
  t.after(() => { executor.dispose(); bridge.close(); store.close(); dir.remove() })
  const idle = async (id, reason = 'completed', draft = 'naked answer', observations = []) => {
    const live = current()
    live.undelivered = live.undelivered.filter(x => x !== id)
    store.tickets.save(live)
    const agent = { id: 'worker-t', status: 'idle', whenIdle: async () => {}, session: { snapshotEvents: () => [
      { type: 'turn/start', data: { turn: 8 } },
      { type: 'user/message', data: { id: 'native:' + id, source: { kind: 'dsh-superagent' } } },
      ...(fresh ? [{ type: 'user/message', data: { id: 'native-input:run:' + bridge.inputSnapshot('t').version, source: { kind: 'dsh-collab', form: 'input-reference' } } }] : []),
      ...observations,
      { type: 'assistant/message', data: { turn: 8, step: 4, message: { content: [{ type: 'text', text: draft }] } } },
      { type: 'turn/end', data: { turn: 8, reason: { kind: reason } } },
    ].map((event, index) => ({ seq: index + 1, ...event })) } }
    await executor.workerIdle(live, live.assignments[0], agent)
  }
  return { current, engine, store, bridge, source, report, status, sent, idle, prompts, deliveries, promptTexts,
    readInput: id => readResource({ store, masterId: 'main', readySubmissionHint }, inputResource(ticket.id, id), 0, 4000, ticket.id),
    setHistory: events => { history = events },
    deliver: async action => { beforeAuthorize = action; await executor.deliverQueued('t') } }
}

test('an ordinary JSON draft gets one formal-submission input and never becomes a report or a reply', async t => {
  const f = setup(t, { fresh: true })
  const version = f.bridge.inputSnapshot('t').version
  for (let n = 0; n < 2; n++) await f.idle('assignment:t', 'completed', '{"customer_result":"private draft"}')
  const current = f.current()
  assert.deepEqual(current.undelivered, ['n1'])
  assert.deepEqual(current.inputs[0].submissionFor, { assignmentId: 'a', inputVersion: version })
  assert.equal(current.inputs[0].reviewOf, undefined)
  assert.match(inputMessage(current.inputs[0]), /orchestrator_report/)
  assert.equal(f.bridge.inputSnapshot('t').version, version)
  assert.deepEqual(f.status, [])
  assert.deepEqual(f.sent, [])
  assert.deepEqual(f.bridge.readEvents().events, [])
  await f.idle('n1', 'completed', '{"customer_result":"still unsubmitted"}')
  assert.deepEqual(f.status.map(entry => entry.state), ['blocked'])
  assert.deepEqual(f.sent.map(entry => entry.state), ['blocked'])
  assert.doesNotMatch(JSON.stringify(f.sent), /customer_result|private draft|still unsubmitted/)
  assert.throws(() => f.bridge.assertReviewed('t'), /Review and accept/)
})

test('verified review notes use the same registered submission instruction in delivery and paged reads', async t => {
  const submissionHint = 'Call artifact_check with submit_for_review=true and wait for ready_submitted=true.'
  const f = setup(t, { submissionHint })
  const ticket = f.current()
  const note = ticket.inputs[0]
  note.text = `${note.text} ${'Review this requirement. '.repeat(75)} Last detail.`
  f.store.tickets.save(ticket)

  await f.deliver(() => {})
  const notice = JSON.parse(f.promptTexts[0])
  const page = await f.readInput(note.id)
  for (const message of [notice.text, page.text]) {
    assert.ok(message.includes(submissionHint))
    assert.doesNotMatch(message, /orchestrator_report with state="ready"/)
  }
  assert.equal(notice.read, inputResource(ticket.id, note.id))
  assert.match(page.text, /Last detail\./)

  const resumed = inputMessage({ kind: 'resumed' }, undefined, submissionHint)
  assert.ok(resumed.includes(submissionHint))
  assert.doesNotMatch(resumed, /Report ready when the follow-up is done/)
  assert.match(inputMessage({ kind: 'resumed' }), /Report ready when the follow-up is done/)
})

test('native submission note keys survive an Engine restart and retries cannot queue another delivery or change the fingerprint', t => {
  const f = setup(t, { fresh: true })
  const version = f.bridge.inputSnapshot('t').version
  const feedback = { assignmentId: 'a', inputVersion: version }
  const deliveries = []
  const newEngine = () => new Engine({ repo: f.store, executor: { deliver(ticket) { deliveries.push(...ticket.undelivered) } } })
  newEngine().note('t', 'Submit the draft', feedback)
  newEngine().note('t', 'Submit the draft once', feedback)
  assert.equal(deliveries.length, 1)
  assert.deepEqual(f.current().undelivered, deliveries)
  assert.equal(f.current().inputs.length, 1)
  assert.equal(f.bridge.inputSnapshot('t').version, version)
})

test('a fresh human scope supersedes a first-report reminder during final delivery without changing the scope version', async t => {
  const f = setup(t, { fresh: true })
  await f.idle('assignment:t', 'completed', '["draft"]')
  await f.deliver(() => f.store.triggers.save({ ...f.source, text: 'Updated human scope' }))
  assert.deepEqual(f.prompts, [])
  assert.deepEqual(f.deliveries, [])
  assert.deepEqual(f.current().undelivered, [])
  assert.deepEqual(f.sent, [])
  assert.notEqual(f.bridge.inputSnapshot('t').version, f.current().inputs[0].submissionFor.inputVersion)
})

test('a formal report submitted during a reminder race remains eligible for normal review without another wake', async t => {
  const f = setup(t, { fresh: true })
  await f.idle('assignment:t', 'completed', '["draft"]')
  let report
  await f.deliver(() => {
    const latest = f.engine.report('t', { state: 'ready', summary: '["formal result"]' })
    report = f.bridge.recordReport(latest, latest.assignments[0].report)
  })
  assert.deepEqual(f.prompts, [])
  assert.deepEqual(f.deliveries, [])
  assert.deepEqual(f.sent, [])
  assert.equal(f.bridge.readReport(report.id).report.summary, '["formal result"]')
  assert.throws(() => f.bridge.assertReviewed('t'), /Review and accept/)
})

test('a rejected ready receives one native reminder; repeated idle is idempotent and a second omission becomes blocked', async t => {
  const f = setup(t)
  assert.match(inputMessage(f.current().inputs[0]), /orchestrator_report with state="ready"/)
  assert.match(inputMessage(f.current().inputs[0]), /Check what was known/)
  assert.match(inputMessage({ kind: 'note', text: 'context' }), /for context only/)
  await f.idle('n1')
  assert.deepEqual(f.current().undelivered, ['n2'])
  await f.idle('n1')
  assert.equal(f.current().inputs.length, 2)
  assert.equal(f.bridge.inputSnapshot('t').version, f.report.reviewContext.inputVersion)
  assert.deepEqual(f.status, [])
  assert.deepEqual(f.sent, [])
  await f.idle('n2')
  assert.deepEqual(f.status.map(x => x.state), ['blocked'])
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].state, 'blocked')
  assert.doesNotMatch(JSON.stringify(f.sent), /naked answer/)
  assert.throws(() => f.bridge.assertReviewed('t'), /Review and accept/)
})

test('a superseding formal report disables the reminder and remains subject to independent acceptance', async t => {
  const f = setup(t)
  await f.idle('n1')
  f.bridge.recordReport(f.current(), { state: 'ready', summary: 'new formal result' })
  assert.equal(f.bridge.recoverReviewFeedback('t', 'a', 'n2'), undefined)
  assert.equal(f.current().inputs.length, 2)
  assert.throws(() => f.bridge.assertReviewed('t'), /Review and accept/)
})

test('a formal report arriving between queue pickup and final delivery retires only the reminder without waking the worker', async t => {
  const f = setup(t)
  await f.idle('n1')
  assert.deepEqual(f.current().undelivered, ['n2'])
  assert.equal(f.bridge.discardSupersededReminder('t', 'a', 'n2', f.report.id), false)
  await f.deliver(() => f.bridge.recordReport(f.current(), { state: 'ready', summary: 'updated during send' }))
  assert.deepEqual(f.prompts, [])
  assert.deepEqual(f.deliveries, [])
  assert.deepEqual(f.current().undelivered, [])
  assert.equal(f.current().inputs.length, 2, 'both feedback notes remain archived')
  assert.throws(() => f.bridge.assertReviewed('t'), /Review and accept/)
})

test('fresh human input preempts a queued reminder without dropping that input or the original rejection', async t => {
  const f = setup(t)
  await f.idle('n1')
  const live = f.current()
  live.inputs.push({ kind: 'text', text: 'New scope', at: f.source.at, id: 'human-input' })
  live.undelivered.push('human-input')
  f.store.tickets.save(live)
  assert.equal(f.bridge.discardSupersededReminder('t', 'a', 'n1', f.report.id), false)
  await f.deliver(() => {})
  assert.deepEqual(f.prompts, ['human-input'])
  assert.deepEqual(f.deliveries, ['human-input'])
})

test('worker correction recovery requires the same scope, input version, assignment and latest consumed note', t => {
  const f = setup(t)
  const base = f.current()
  base.undelivered = []
  for (const change of [
    ticket => { ticket.assignments[0].id = 'new' },
    ticket => { ticket.ended = { by: 'operator' } },
    ticket => { ticket.attention = { question: 'Confirm?' } },
    ticket => { ticket.inputs.push({ id: 'other', kind: 'text', at: f.source.at, text: 'new input' }) },
  ]) {
    const ticket = structuredClone(base); change(ticket); f.store.tickets.save(ticket)
    assert.equal(f.bridge.recoverReviewFeedback('t', 'a', 'n1'), undefined)
  }
  f.store.tickets.save(base)
  assert.equal(f.bridge.recoverReviewFeedback('t', 'a', 'unknown'), undefined)
  f.store.triggers.save({ ...f.source, text: 'New human correction' })
  assert.equal(f.bridge.recoverReviewFeedback('t', 'a', 'n1'), undefined)
  assert.equal(f.current().inputs.length, 1)
})

// Native Harness turn shape from the reduced-motion incident. Use unrelated tool/field values
// to check that evidence and session binding, rather than a task name or a score, govern the reminder.
function toolReceipt(step, name, value, { isError = false, resultId = 'call-' + step } = {}) {
  const callId = 'call-' + step
  return [
    { type: 'assistant/message', data: { turn: 8, step, message: { content: [{ type: 'tool-call', id: callId, name, arguments: '{}' }] } } },
    { type: 'tool/call', data: { turn: 8, step, callId, name, arguments: '{}' } },
    { type: 'tool/result', data: { turn: 8, step, message: { role: 'tool', toolCallId: resultId, isError,
      content: [{ type: 'text', text: JSON.stringify(value) }] } } },
  ]
}
const successfulWrite = toolReceipt(1, 'edit_configuration', { written: true, path: 'ui.css' })
const verified = { passed: true, checks: [{ id: 'reduced', passed: true }, { id: 'default', passed: true }] }
const successfulCheck = toolReceipt(2, 'check_configuration', verified)
const verifiedTurn = [...successfulWrite, ...successfulCheck]
const prose = 'The configuration has been updated and checked.'

test('a verified local edit gets one report hint in the next planned step without creating a report or waking an agent', t => {
  const f = setup(t, { fresh: true, outputFormat: 'text' })
  const timeline = [
    { type: 'turn/start', data: { turn: 8 } },
    { type: 'user/message', data: { id: 'native-input:run:' + f.bridge.inputSnapshot('t').version,
      source: { kind: 'dsh-collab', form: 'input-reference' } } },
    ...verifiedTurn,
  ].map((event, index) => ({ seq: index + 1, ...event }))
  const guidance = f.bridge.checkedEditGuidance('worker-t', timeline, [])
  assert.match(guidance.content[0].text, /orchestrator_report.*actual change.*concrete check/)
  assert.equal(f.bridge.checkedEditGuidance('worker-t', [...timeline, { type: 'user/message', data: guidance }], []), undefined)
  assert.equal(f.bridge.checkedEditGuidance('worker-t', timeline, [guidance]), undefined)
  assert.equal(f.bridge.checkedEditGuidance('worker-t', timeline, [{ source: { kind: 'user' } }]), undefined)
  assert.equal(f.bridge.checkedEditGuidance('worker-t', timeline.slice(0, -1), []), undefined)
  assert.equal(f.bridge.checkedEditGuidance('worker-t', [...timeline, { type: 'turn/end', data: { turn: 8 } }], []), undefined)
  assert.equal(f.bridge.checkedEditGuidance('main', timeline, []), undefined)
  assert.deepEqual(f.bridge.readEvents().events, [])
  assert.deepEqual(f.current().inputs, [])
  assert.deepEqual(f.prompts, [])
  assert.deepEqual(f.sent, [])
  f.store.triggers.save({ ...f.source, text: 'Recheck with updated instructions.' })
  assert.equal(f.bridge.checkedEditGuidance('worker-t', timeline, []), undefined)
})

test('a failed edit guides same-turn repair and a later successful check still guides formal delivery', t => {
  const f = setup(t, { fresh: true, outputFormat: 'text' })
  const numbered = events => events.map((event, index) => ({ ...event, seq: index + 1 }))
  const events = [{ type: 'turn/start', data: { turn: 8 } },
    { type: 'user/message', data: { id: 'native-input:run:' + f.bridge.inputSnapshot('t').version,
      source: { kind: 'dsh-collab', form: 'input-reference' } } },
    ...successfulWrite, ...toolReceipt(2, 'check_configuration', { passed: false, checks: [{ id: 'default', passed: false }] })]
  const repair = f.bridge.checkedEditGuidance('worker-t', numbered(events), [])
  assert.match(repair.content[0].text, /correct the edit and rerun the check/)
  events.push({ type: 'user/message', data: repair })
  assert.equal(f.bridge.checkedEditGuidance('worker-t', numbered(events), []), undefined)
  events.push(...toolReceipt(3, 'edit_configuration', { written: true }), ...toolReceipt(4, 'check_configuration', verified))
  const submit = f.bridge.checkedEditGuidance('worker-t', numbered(events), [])
  assert.match(submit.content[0].text, /state="ready"/)
  assert.notEqual(repair.id, submit.id)
  assert.deepEqual(f.current().inputs, [])
  assert.deepEqual(f.bridge.readEvents().events, [])
})

test('an unchanged failed check guides the next planned worker step once before any write', t => {
  const f = setup(t, { fresh: true, outputFormat: 'text' })
  const numbered = events => events.map((event, index) => ({ ...event, seq: index + 1 }))
  const failed = { passed: false, checks: [{ id: 'default', passed: false }] }
  const events = [{ type: 'turn/start', data: { turn: 8 } },
    { type: 'user/message', data: { id: 'native-input:run:' + f.bridge.inputSnapshot('t').version,
      source: { kind: 'dsh-collab', form: 'input-reference' } } }, ...toolReceipt(1, 'check_configuration', failed)]
  assert.equal(f.bridge.checkedEditGuidance('worker-t', numbered(events), []), undefined)
  events.push(...toolReceipt(2, 'check_configuration', failed))
  assert.equal(f.bridge.checkedEditGuidance('worker-t', numbered(events), []), undefined)
  f.bridge.registerScopedWorkspaceEditor(id => id === 'worker-t')
  const hint = f.bridge.checkedEditGuidance('worker-t', numbered(events), [])
  assert.match(hint.content[0].text, /same checks failed.*make the edit/)
  assert.equal(f.bridge.checkedEditGuidance('worker-t', numbered(events), [{ source: { kind: 'user' } }]), undefined)
  f.store.triggers.save({ ...f.source, text: 'Updated scope' })
  assert.equal(f.bridge.checkedEditGuidance('worker-t', numbered(events), []), undefined)
  f.store.triggers.save(f.source)
  events.push({ type: 'user/message', data: hint }, ...toolReceipt(3, 'check_configuration', failed))
  assert.equal(f.bridge.checkedEditGuidance('worker-t', numbered(events), []), undefined)
  assert.deepEqual(f.current().inputs, [])
  assert.deepEqual(f.bridge.readEvents().events, [])
  assert.deepEqual(f.prompts, [])
  assert.deepEqual(f.sent, [])
})

test('a scoped free worker that stopped at inspection gets one startup reminder without waking the coordinator', async t => {
  const f = setup(t, { fresh: true, outputFormat: 'text' })
  f.bridge.registerFreeWorkerRoute((id, provider, model) => id === 'worker-t'
    && (provider === undefined || (provider === 'local-backend' && model === 'approved-worker')))
  const withdraw = f.bridge.registerScopedWorkspaceEditor(id => id === 'worker-t')
  const version = f.bridge.inputSnapshot('t').version
  const read = toolReceipt(1, 'read_configuration', { path: 'panel.js', start: 10, lines: '10 const active = false;' })
  await f.idle('assignment:t', 'completed', 'I located the setting.', read)
  const note = f.current().inputs[0]
  assert.deepEqual(note.submissionFor, { assignmentId: 'a', inputVersion: version, startupWork: true })
  assert.match(inputMessage(note), /Resume the same assignment.*scoped editor/)
  assert.deepEqual(f.sent, [])
  assert.deepEqual(f.bridge.readEvents().events, [])
  await f.deliver(() => {})
  assert.deepEqual(f.prompts, [note.id])
  f.setHistory([{ type: 'turn/start', data: { turn: 9 } }, { type: 'user/message', data: {
    id: messageId(key(note.id)), source: { kind: 'dsh-superagent', form: 'relay' },
  } }])
  assert.doesNotThrow(() => f.bridge.assertReminderRoute('worker-t', 'local-backend', 'approved-worker'))
  assert.throws(() => f.bridge.assertReminderRoute('worker-t', 'paid-backend', 'approved-worker'), /free native worker/)
  withdraw()
  assert.throws(() => f.bridge.assertReminderRoute('worker-t', 'local-backend', 'approved-worker'), /scoped editor/)
  f.bridge.registerScopedWorkspaceEditor(id => id === 'worker-t')
  await f.idle(note.id, 'completed', 'I still have no changes.')
  assert.equal(f.current().inputs.length, 1)
  assert.deepEqual(f.status.map(report => report.state), ['blocked'])
  assert.equal(f.sent.length, 1)
})

test('workspace startup recovery needs both scoped editing and a free worker, and revalidates before sending', async t => {
  const read = toolReceipt(1, 'read_configuration', { path: 'panel.js', start: 12, lines: '12 const active = false;' })
  for (const route of [false, true]) {
    const f = setup(t, { fresh: true, outputFormat: 'text' })
    if (route) f.bridge.registerFreeWorkerRoute(() => true)
    else f.bridge.registerScopedWorkspaceEditor(() => true)
    await f.idle('assignment:t', 'completed', 'I found the target.', read)
    assert.deepEqual(f.current().inputs, [])
    assert.deepEqual(f.sent, [])
  }
  const f = setup(t, { fresh: true, outputFormat: 'text' })
  f.bridge.registerFreeWorkerRoute(() => true)
  const withdraw = f.bridge.registerScopedWorkspaceEditor(() => true)
  await f.idle('assignment:t', 'completed', 'I found the target.', read)
  assert.deepEqual(f.current().undelivered, ['n1'])
  await f.deliver(withdraw)
  assert.deepEqual(f.current().undelivered, [])
  assert.deepEqual(f.prompts, [])
})

test('a verified prose result on a free local worker gets one formal-report reminder and still needs coordinator review', async t => {
  const f = setup(t, { fresh: true, outputFormat: 'text' })
  f.bridge.registerFreeWorkerRoute(id => id === 'worker-t')
  const version = f.bridge.inputSnapshot('t').version
  for (let i = 0; i < 2; i++) await f.idle('assignment:t', 'completed', prose, verifiedTurn)
  const notes = f.current().inputs
  assert.equal(notes.length, 1)
  assert.deepEqual(notes[0].submissionFor, { assignmentId: 'a', inputVersion: version, verifiedWork: true })
  assert.match(inputMessage(notes[0]), /orchestrator_report/)
  assert.equal(f.bridge.inputSnapshot('t').version, version)
  assert.deepEqual(f.bridge.readEvents().events, [])
  assert.deepEqual(f.sent, [])
  assert.throws(() => f.bridge.assertReviewed('t'), /Review and accept/)
  await f.deliver(() => {})
  assert.deepEqual(f.prompts, ['n1'])
  assert.deepEqual(f.deliveries, ['n1'])
  const current = f.engine.report('t', { state: 'ready', summary: prose })
  const formal = f.bridge.recordReport(current, { state: 'ready', summary: prose })
  assert.throws(() => f.bridge.assertReviewed('t'), /Review and accept/)
  assert.equal(f.bridge.readReport(formal.id).report.summary, prose)
})

test('a verified prose reminder fails closed if its free worker route is withdrawn during final delivery', async t => {
  const f = setup(t, { fresh: true, outputFormat: 'text' })
  const withdraw = f.bridge.registerFreeWorkerRoute(id => id === 'worker-t')
  await f.idle('assignment:t', 'completed', prose, verifiedTurn)
  assert.deepEqual(f.current().undelivered, ['n1'])
  await f.deliver(withdraw)
  assert.deepEqual(f.current().undelivered, [])
  assert.deepEqual(f.prompts, [])
  assert.deepEqual(f.deliveries, [])
  assert.deepEqual(f.sent, [])
})

test('a free worker that omits its report again stops after the single prose reminder', async t => {
  const f = setup(t, { fresh: true, outputFormat: 'text' })
  f.bridge.registerFreeWorkerRoute(id => id === 'worker-t')
  await f.idle('assignment:t', 'completed', prose, verifiedTurn)
  await f.deliver(() => {})
  await f.idle('n1', 'completed', 'I have completed the work.')
  assert.equal(f.current().inputs.length, 1)
  assert.deepEqual(f.prompts, ['n1'])
  assert.deepEqual(f.status.map(x => x.state), ['blocked'])
  assert.deepEqual(f.bridge.readEvents().events, [])
  assert.throws(() => f.bridge.assertReviewed('t'), /Review and accept/)
})

test('verification failures, stale checks, ordinary reads and unconfirmed worker routes cannot trigger a prose reminder', async t => {
  const wrongStep = structuredClone(successfulCheck)
  wrongStep.at(-1).data.step++
  const cases = [
    ['no proof', []],
    ['read only', toolReceipt(1, 'read_file', { text: JSON.stringify(verified) })],
    ['raw verification from a read without an earlier write', toolReceipt(2, 'read_file', verified)],
    ['unsuccessful write before a valid check', [...toolReceipt(1, 'edit_configuration', { written: false }), ...successfulCheck]],
    ['unpaired edit receipt before a valid check', [...toolReceipt(1, 'edit_configuration', { written: true }, { resultId: 'orphan' }), ...successfulCheck]],
    ['top-level failure', [...successfulWrite, ...toolReceipt(2, 'check_configuration', { ...verified, passed: false })]],
    ['one failed check', [...successfulWrite, ...toolReceipt(2, 'check_configuration', { passed: true, checks: [{ id: 'default', passed: false }] })]],
    ['no checks', [...successfulWrite, ...toolReceipt(2, 'check_configuration', { checks: [], passed: true })]],
    ['errored result', [...successfulWrite, ...toolReceipt(2, 'check_configuration', verified, { isError: true })]],
    ['mismatched result', [...successfulWrite, ...toolReceipt(2, 'check_configuration', verified, { resultId: 'different-call' })]],
    ['result from different step', [...successfulWrite, ...wrongStep]],
    ['new change after check', [...verifiedTurn, ...toolReceipt(3, 'edit_configuration', { written: true })]],
    ['unknown role', verifiedTurn, 'unknown'],
    ['paid worker', verifiedTurn, 'paid'],
  ]
  for (const [label, observations, route = 'free'] of cases) {
    const f = setup(t, { fresh: true, outputFormat: 'text' })
    if (route !== 'unknown') f.bridge.registerFreeWorkerRoute(id => route === 'free' && id === 'worker-t')
    await f.idle('assignment:t', 'completed', prose, observations)
    assert.deepEqual(f.current().inputs, [], label)
    assert.deepEqual(f.prompts, [], label)
    assert.deepEqual(f.sent, [], label)
  }
})

test('an outstanding human question takes precedence over a successful prose verification', async t => {
  const f = setup(t, { fresh: true, outputFormat: 'text' })
  f.bridge.registerFreeWorkerRoute(id => id === 'worker-t')
  const current = f.current()
  current.attention = { id: 'human', question: 'Confirm the choice?' }
  f.store.tickets.save(current)
  await f.idle('assignment:t', 'completed', prose, verifiedTurn)
  assert.deepEqual(f.current().inputs, [])
  assert.equal(f.current().attention.id, 'human')
  assert.deepEqual(f.prompts, [])
})

test('a same-turn input correction invalidates earlier writes, checks and any late-arriving old tool receipt', async t => {
  const marker = version => ({ type: 'user/message', data: {
    id: 'native-input:run:' + version, source: { kind: 'dsh-collab', form: 'input-reference' },
  } })
  const cases = [
    ['after both receipts', update => [...verifiedTurn, update]],
    ['after old check call but before its result', update => [...successfulWrite, ...successfulCheck.slice(0, 2), update, successfulCheck[2]]],
    ['between edit and verification', update => [...successfulWrite, update, ...successfulCheck]],
  ]
  for (const [order, timeline] of cases) {
    const f = setup(t, { fresh: true, outputFormat: 'text' })
    f.bridge.registerFreeWorkerRoute(id => id === 'worker-t')
    const original = f.bridge.inputSnapshot('t').version
    f.store.triggers.save({ ...f.source, text: 'Recheck using the updated scope.' })
    const replacement = f.bridge.inputSnapshot('t').version
    assert.notEqual(original, replacement)
    await f.idle('assignment:t', 'completed', prose, [marker(original), ...timeline(marker(replacement))])
    assert.deepEqual(f.current().inputs, [], order)
    assert.deepEqual(f.sent, [], order)
    assert.deepEqual(f.prompts, [], order)
  }
})

test('dispatch of a consumed verified reminder requires the actual free backend while a later human turn remains independent', async t => {
  const f = setup(t, { fresh: true, outputFormat: 'text' })
  const remove = f.bridge.registerFreeWorkerRoute((id, provider, model) =>
    id === 'worker-t' && (provider === undefined || (provider === 'local-backend' && model === 'approved-worker')))
  await f.idle('assignment:t', 'completed', prose, verifiedTurn)
  const note = f.current().inputs[0]
  const start = { type: 'turn/start', data: { turn: 9 } }
  const consumption = { type: 'user/message', data: { id: messageId(key(note.id)), source: { kind: 'dsh-superagent', form: 'relay' } } }
  f.setHistory([start, consumption])
  assert.doesNotThrow(() => f.bridge.assertReminderRoute('worker-t', 'local-backend', 'approved-worker'))
  assert.throws(() => f.bridge.assertReminderRoute('worker-t', 'paid-backend', 'approved-worker'), /free/i)
  assert.throws(() => f.bridge.assertReminderRoute('worker-t', 'local-backend', 'unknown-model'), /free/i)
  remove()
  assert.throws(() => f.bridge.assertReminderRoute('worker-t', 'local-backend', 'approved-worker'), /free/i)
  f.setHistory([start, consumption, { type: 'turn/end', data: { turn: 9, reason: { kind: 'completed' } } },
    { type: 'turn/start', data: { turn: 10 } }, { type: 'user/message', data: { id: 'human', source: { kind: 'user' } } }])
  assert.doesNotThrow(() => f.bridge.assertReminderRoute('worker-t', 'paid-backend', 'permitted-for-human-task'))
})
