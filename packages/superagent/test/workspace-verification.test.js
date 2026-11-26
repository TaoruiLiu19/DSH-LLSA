import assert from 'node:assert/strict'
import { mkdtempDisposableSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CollabBridge } from '../src/app/collab-bridge.ts'
import { installLocalSource, localTrigger } from '../src/app/local-tasks.ts'
import { Store } from '../src/app/store.ts'
import { executorTools } from '../src/app/tools/executor.ts'
import { downloadLocalArtifact, localArtifactDownloadView } from '../src/app/local-artifact-download.ts'
import { localArtifactTools } from '../src/app/tools/artifacts.ts'
import { artifactQuietDraft } from '../src/executor/draft-submission.ts'
import { mainTools } from '../src/app/tools/main.ts'
import { artifactRecovery } from '../src/app/artifact-recovery.ts'
import { Engine } from '../src/core/index.ts'
import { settingsPolicy } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'

const ticketId = 'workspace-task'
const sessionId = `worker-${ticketId}`
const now = '2026-11-24T02:00:00Z'

function workspace(t) {
  const directory = mkdtempDisposableSync(join(tmpdir(), 'llsa-workspace-verification-'))
  const database = join(directory.path, 'state.sqlite')
  const relays = []
  let store, engine, bridge, source, origin
  let revision = 'a'.repeat(64)
  let failNote = false, pendingChildren = false, history = []

  function open() {
    store = new Store(database)
    const sourceRegistry = new SourceRegistry(() => store.settings())
    source = installLocalSource(store)
    sourceRegistry.register(source)
    engine = new Engine({ repo: store, scope: sourceRegistry, policy: () => settingsPolicy(store.settings(), sourceRegistry),
      assessor: {}, executor: { deliver() {}, start() {}, stop() {} }, deferReadyCompletion: () => true, now: () => now,
      outbox: { send: message => store.receipts.add(message), withdraw: id => store.receipts.withdraw(id), status: id => store.replyStatus(id) } })
    bridge = new CollabBridge(new Context(), { store, masterId: 'coordinator', workerHistory: () => history, sessions: {
      relay: (id, text) => store.afterCommit(() => relays.push({ id, payload: JSON.parse(text) })),
    }, engine: { report: (id, report) => engine.report(id, report),
      acceptReadyReport: (id, assignment) => engine.acceptReadyReport(id, assignment), note(...args) {
      engine.note(...args)
      if (failNote) throw new Error('Injected repair enqueue failure')
    } } })
    bridge.registerLifecycle({ bindWorker() {}, beforeReady() {
      if (pendingChildren) throw new Error('Other work still pending')
    } })
    bridge.registerWorkspaceVerification({ applies: id => id === sessionId, currentRevision: () => revision })
  }
  function close() { bridge.close(); store.close() }
  open()
  origin = localTrigger({ requestId: 'workspace-owner-request', prompt: 'Prepare and verify the workspace result.' }, store)
  store.triggers.save(origin)
  store.tickets.save({ id: ticketId, title: 'Verify workspace', origin: { triggerId: origin.id, triggerIds: [origin.id] },
    mandate: { strength: 'explicit', actor: origin.actor }, channels: [origin.channel],
    inputs: [], undelivered: [], assignments: [{ id: 'assignment-1', state: 'running', createdAt: now }], createdAt: now, updatedAt: now })
  t.after(() => { close(); directory.remove() })

  const ticket = () => store.tickets.get(ticketId)
  const assignment = () => ticket().assignments.at(-1)
  const currentScope = () => ({ assignmentId: assignment().id, inputVersion: bridge.inputSnapshot(ticketId).version })
  return { get store() { return store }, get engine() { return engine }, get bridge() { return bridge },
    get revision() { return revision }, relays, ticket, assignment, currentScope,
    enableArtifacts(contract) {
      origin = localTrigger({ requestId:'workspace-artifact-request', prompt:'Prepare verified files.', ...contract }, store)
      store.triggers.save(origin)
      const item = ticket()
      item.origin = { triggerId: origin.id, triggerIds: [origin.id] }
      item.channels = [origin.channel]
      item.execution = { name: 'artifacts', directory: directory.path, assignment: 'Prepare verified files.' }
      store.tickets.save(item)
      return directory.path
    },
    setHistory(events) { history = events },
    restart() { close(); open() },
    edit(char) { revision = char.repeat(64) },
    correct(text = 'Use the newly requested workspace setting.') { store.triggers.save({ ...origin, text }) },
    restoreInput() { store.triggers.save(origin) },
    replaceAssignment() {
      const previous = ticket()
      previous.assignments.at(-1).state = 'ended'
      previous.assignments.push({ id: 'assignment-2', state: 'running', createdAt: now })
      store.tickets.save(previous)
    },
    check(passed, extra = {}) {
      return bridge.recordWorkspaceVerification(sessionId, { ...currentScope(), revision, passed,
        checks: [{ id: 'workspace-output', passed, ...(!passed ? { diagnostic: 'Observed state\nneeds repair.' } : {}) }], ...extra })
    },
    report(state = 'ready') {
      const tool = executorTools({ store, engine, collabBridge: bridge, github: { deployment: { github: { login: 'fixture' } } } }, ticket())
        .find(entry => entry.name === 'orchestrator_report')
      return tool.execute({ state, summary: 'Concrete workspace result and check outcomes.' }, new AbortController().signal)
    },
    repair(id, text = 'Correct the workspace setting and rerun the check.') { return bridge.sendWorkspaceRepair(ticketId, id, text) },
    failNextNote(on) { failNote = on },
    setPendingChildren(on) { pendingChildren = on },
    async issue(report, id) {
      bridge.reviewReport(report, true, 'The recorded workspace checks passed.')
      const message = { id, channel: origin.channel, text: 'Verified workspace output.', ticketId, kind: 'reply' }
      assert.equal(bridge.queueResult(ticketId, () => { store.receipts.add(message); return id }).id, id)
      return async () => { await source.channel.send(undefined, message); store.receipts.settle(message, 'sent') }
    },
  }
}

test('owner retry keeps the saved file and scope while starting a fresh assignment that still requires review', async t => {
  const f = workspace(t)
  const path = join(f.enableArtifacts({ artifactFiles: ['index.html'] }), 'index.html')
  const draft = '<p>saved intermediate work</p>'
  writeFileSync(path, draft)
  const prior = f.currentScope()
  f.engine.report(ticketId, { state: 'failed', summary: 'Assignment budget reached.', failureCode: 'token_budget' })
  f.restart()
  assert.equal(artifactRecovery(f.ticket())?.kind, 'token_budget')
  const retryTool = mainTools({ store: f.store, engine: f.engine, resources: {} }, {}).find(tool => tool.name === 'orchestrator_ticket_retry')
  await assert.rejects(retryTool.execute({ ticket_id: ticketId }, new AbortController().signal), /owner must resume/i)
  const retried = f.engine.retryTicket(ticketId)
  assert.notEqual(retried.assignments.at(-1).id, prior.assignmentId)
  assert.equal(retried.assignments.at(-2).endedReason, 'retried')
  assert.equal(retried.assignments.at(-2).report.failureCode, 'token_budget')
  assert.equal(f.bridge.localArtifactWorkspace(ticketId)?.directory, retried.execution.directory)
  assert.equal(readFileSync(path, 'utf8'), draft)
  assert.notEqual(f.currentScope().inputVersion, prior.inputVersion)
  assert.equal(artifactRecovery(f.ticket()), undefined)
  assert.throws(() => f.bridge.assertReviewed(ticketId), /Review and accept the latest ready report/)
  assert.throws(() => f.engine.retryTicket(ticketId), { code: 'notRetryable' })
})

test('only a current passing workspace receipt allows a native ready report and review', async t => {
  const f = workspace(t)
  await assert.rejects(f.report(), /passing workspace verification/)
  assert.equal(f.assignment().report, undefined)

  f.check(false)
  await assert.rejects(f.report(), /passing workspace verification/)
  assert.equal(f.bridge.readEvents().events.length, 0)
  assert.throws(() => f.check(true, { revision: 'b'.repeat(64) }), /stale workspace verification/)
  assert.throws(() => f.check(true, { checks: [{ id: 'workspace-output', passed: false }] }), /workspace verification/)

  f.check(true)
  f.edit('b')
  await assert.rejects(f.report(), /passing workspace verification/)
  const passed = f.check(true)
  assert.equal((await f.report()).reported, true)
  const [report] = f.bridge.readEvents().events
  assert.equal(report.reviewContext.inputVersion, f.currentScope().inputVersion)
  assert.deepEqual(report.reviewContext.workspaceVerification, { id: passed.id, revision: f.revision, checks: ['workspace-output'] })

  f.edit('c')
  assert.throws(() => f.bridge.reviewReport(report.id, true, 'Use the reported result.'), /passing workspace verification/)
  f.check(true)
  assert.throws(() => f.bridge.reviewReport(report.id, true, 'Use the old summary.'), /Report workspace verification is stale/)
  assert.equal(f.ticket().ended, undefined)
})

test('a verified local submission tool can conclude only after a normal ready report is queued for explicit review', async t => {
  const f = workspace(t)
  const artifact = { ticketId, ...f.currentScope(), summary: 'Complete verified output.' }
  const verified = { checks: ['workspace-output'], fields: ['result'] }
  const projector = ({ ticketId: work, assignmentId, inputVersion, sessionId: worker, summary }) =>
    work === ticketId && assignmentId === artifact.assignmentId && inputVersion === artifact.inputVersion &&
    worker === sessionId && summary === artifact.summary ? verified : undefined
  const remove = f.bridge.registerReadyReviewEvidence(projector)
  const controller = new AbortController()
  let conclusions = 0
  const execution = { name: 'workspace_submit', callId: 'call1', rootCallId: 'call1', agent: { id: sessionId },
    signal: controller.signal, concludeTurn() { conclusions++ } }
  const submit = (candidate = artifact, tool = execution) => f.bridge.submitVerifiedReadyArtifact(tool, candidate)
  assert.throws(() => submit(), /registered worker submission tool/)
  remove()
  f.bridge.registerReadyReviewEvidence(projector, { submitTool: 'workspace_submit', requiresSubmission: id => id === ticketId,
    submissionHint: 'Call workspace_submit now.' })
  assert.equal(f.bridge.readySubmissionHint(ticketId), 'Call workspace_submit now.')
  assert.equal(f.bridge.readySubmissionHint('another-ticket'), undefined)
  assert.throws(() => submit(artifact, { ...execution, name: 'workspace_check' }), /registered worker submission tool/)
  assert.throws(() => submit(artifact, { ...execution, signal: AbortSignal.abort() }), /registered worker submission tool/)
  assert.throws(() => submit(artifact, { ...execution, parent: {} }), /registered worker submission tool/)
  assert.throws(() => submit(artifact, { ...execution, agent: { id: 'coordinator' } }), /stale or unavailable/)
  assert.throws(() => submit({ ...artifact, assignmentId: 'old-assignment' }), /stale or unavailable/)
  assert.throws(() => submit(), /passing workspace verification/)
  f.check(true)
  await assert.rejects(f.report(), /Ready requires verified artifact submission\. Call workspace_submit now\./)
  assert.doesNotThrow(() => f.bridge.beforeReport(f.ticket(), { state: 'blocked' }))
  assert.throws(() => f.bridge.queueResult(ticketId, () => assert.fail('No result before acceptance')), /Review and accept/)
  f.setPendingChildren(true)
  assert.throws(() => submit(), /Other work still pending/)
  f.setPendingChildren(false)
  assert.throws(() => submit({ ...artifact, summary: 'A different output.' }), /no current, matching host evidence/)
  f.correct()
  assert.throws(() => submit(), /stale or unavailable/)
  f.restoreInput()
  assert.equal(conclusions, 0)
  assert.equal(f.relays.length, 0)
  assert.equal(f.assignment().report, undefined)

  const { reportId } = submit()
  assert.equal(conclusions, 1)
  assert.equal(f.ticket().ended, undefined)
  assert.equal(f.assignment().report.state, 'ready')
  assert.deepEqual(f.relays.map(relay => relay.payload.report_id), [reportId])
  assert.deepEqual(f.bridge.readReport(reportId).reviewContext.readyEvidence,
    { assignmentId: artifact.assignmentId, inputVersion: artifact.inputVersion, data: verified })
  assert.throws(() => f.bridge.assertReviewed(ticketId), /Review and accept/)
  assert.throws(() => submit(), /already has a ready report/)
  assert.equal(conclusions, 1)
  assert.equal(f.relays.length, 1)
  await (await f.issue(reportId, 'verified-artifact-result'))()
  assert.equal(f.ticket().ended.outcome, 'completed')
  assert.throws(() => submit(), /stale or unavailable/)
})

test('scoped artifact policy cannot accept an older ordinary ready report', async t => {
  const f = workspace(t)
  f.check(true)
  await f.report()
  const [legacy] = f.bridge.readEvents().events
  const remove = f.bridge.registerReadyReviewEvidence(() => undefined, {
    submitTool: 'workspace_submit', requiresSubmission: id => id === ticketId,
  })
  assert.throws(() => f.bridge.reviewReport(legacy.id, true, 'The workspace check passed.'), /lacks a verified artifact submission/)
  assert.equal(f.ticket().ended, undefined)
  remove()
  await (await f.issue(legacy.id, 'ordinary-result'))()
  assert.equal(f.bridge.isCurrentIssuedLocalReply(f.ticket(), 'ordinary-result'), true)
  f.bridge.registerReadyReviewEvidence(() => undefined, { submitTool: 'workspace_submit', requiresSubmission: id => id === ticketId })
  assert.equal(f.bridge.isCurrentIssuedLocalReply(f.ticket(), 'ordinary-result'), false)
})

test('declared local files must be handed in by the assigned worker and stay unchanged through acceptance', async t => {
  const f = workspace(t)
  assert.deepEqual(localArtifactTools(f.bridge, ticketId), [])
  const directory = f.enableArtifacts({ artifactFiles: ['index.html'], artifactInputs: ['source.txt'] })
  writeFileSync(join(directory, 'source.txt'), 'source data')
  const tools = new Map(localArtifactTools(f.bridge, ticketId).map(item => [item.name, item]))
  let concluded = 0
  const signal = new AbortController().signal
  const call = (name, input, agent = sessionId) => {
    const tool = tools.get(name)
    return tool.execute(tool.schema.parse(input), signal,
      { name, agent: { id: agent }, signal, callId: 'artifact', rootCallId: 'artifact', concludeTurn() { concluded++ } })
  }
  const writeSchema = tools.get('artifact_write').schema
  assert.equal(writeSchema.safeParse({ path:'source.txt', content:'replacement' }).success, false)
  await assert.rejects(call('artifact_read', { path:'source.txt' }, 'worker-another-ticket'), /current authorized worker/)
  assert.equal((await call('artifact_read', { path:'source.txt' })).content, 'source data')
  assert.equal((await call('artifact_check', { submit_for_review:true })).passed, false)
  assert.equal(concluded, 0)
  await call('artifact_write', { path:'index.html', content:'<main>ready</main>' })
  f.check(true)
  await assert.rejects(f.report(), /Ready requires verified artifact submission/)
  const submitted = await call('artifact_check', { submit_for_review:true })
  assert.equal(submitted.ready_submitted, true)
  assert.equal(concluded, 1)
  assert.equal(f.bridge.readReport(submitted.report_id).reviewContext.readyEvidence.data.artifactSha256, submitted.artifactSha256)
  assert.equal(f.bridge.readLocalReviewArtifact(ticketId, submitted.report_id, 'index.html', 0, 6).content, '<main>')
  assert.throws(() => f.bridge.readLocalReviewArtifact(ticketId, submitted.report_id, 'source.txt', 0, 6), /outside the current pending review/)
  await assert.rejects(call('artifact_write', { path:'index.html', content:'changed through worker' }), /Wait for review/)
  writeFileSync(join(directory, 'index.html'), '<main>externally changed</main>')
  assert.throws(() => f.bridge.readLocalReviewArtifact(ticketId, submitted.report_id, 'index.html', 0, 6), /files changed/)
  assert.throws(() => f.bridge.reviewReport(submitted.report_id, true, 'The artifact passed.'), /files changed/)
  assert.equal(f.ticket().ended, undefined)
  writeFileSync(join(directory, 'index.html'), '<main>ready</main>')
  await (await f.issue(submitted.report_id, 'native-artifacts-result'))()
  assert.equal(f.bridge.isCurrentIssuedLocalReply(f.ticket(), 'native-artifacts-result'), true)
  writeFileSync(join(directory, 'source.txt'), 'changed from outside the worker')
  assert.equal(f.bridge.isCurrentIssuedLocalReply(f.ticket(), 'native-artifacts-result'), false)
})

test('owner downloads distinguish current sent files from saved drafts and pin the exact bytes', async t => {
  const f = workspace(t)
  const path = '交付.html'
  const bytes = Buffer.from('\ufeff<h1>项目</h1>\r\n')
  const directory = f.enableArtifacts({ artifactFiles: [path, 'styles.css'], artifactInputs: ['notes.txt'] })
  writeFileSync(join(directory, 'notes.txt'), 'owner notes')
  writeFileSync(join(directory, path), bytes)
  const view = () => localArtifactDownloadView(f.bridge, ticketId)
  const download = (draft, sha) => downloadLocalArtifact(f.bridge, ticketId, path, draft, sha)
  let current = view()
  assert.deepEqual(current.artifactWorkspace.outputs.map(file => [file.path, file.status]), [[path, 'draft'], ['styles.css', 'missing']])
  const sha = current.artifactWorkspace.outputs[0].sha256
  assert.equal(current.issuedReplyId, undefined)
  assert.throws(() => download(false), { status: 409 })
  assert.equal(download(true, sha).disposition, 'draft')
  assert.deepEqual(download(true, sha).content, bytes)
  for (const inaccessible of ['../notes.txt', 'notes.txt', 'unlisted.html']) {
    assert.throws(() => downloadLocalArtifact(f.bridge, ticketId, inaccessible, true), { status: 404 })
  }
  assert.throws(() => downloadLocalArtifact(f.bridge, 'other-ticket', path, true), { status: 404 })

  writeFileSync(join(directory, 'styles.css'), 'body {}')
  f.check(true)
  const tool = localArtifactTools(f.bridge, ticketId).find(item => item.name === 'artifact_check')
  const signal = new AbortController().signal
  const { report_id: reportId } = await tool.execute(tool.schema.parse({ submit_for_review: true }), signal, {
    name: 'artifact_check', agent: { id: sessionId }, signal, callId: 'delivery', rootCallId: 'delivery', concludeTurn() {},
  })
  const send = await f.issue(reportId, 'artifact-delivery-reply')
  assert.throws(() => download(false), { status: 409 })
  await send()
  current = view()
  assert.equal(current.issuedReplyId, 'artifact-delivery-reply')
  assert.deepEqual(current.artifactWorkspace.outputs.map(file => file.status), ['delivered', 'delivered'])
  assert.equal(download(false, sha).disposition, 'delivered')
  assert.deepEqual(download(false, sha).content, bytes)

  writeFileSync(join(directory, 'styles.css'), 'body { color: red }')
  assert.equal(view().issuedReplyId, undefined)
  assert.throws(() => download(false, sha), { status: 409 })
  assert.equal(download(true, sha).disposition, 'draft')
  writeFileSync(join(directory, path), 'new version')
  assert.throws(() => download(true, sha), { status: 409 })

  const origin = f.store.triggers.get(f.ticket().origin.triggerId)
  f.store.triggers.save({ ...origin, actor: { source: 'local', id: 'other-actor' } })
  assert.equal(view(), undefined)
  assert.throws(() => download(true), { status: 404 })
})

test('a quiet declared file task receives one native reminder even on its normal model route', t => {
  const f = workspace(t)
  f.enableArtifacts({ artifactFiles: ['index.html'] })
  const { assignmentId, inputVersion } = f.currentScope()
  const marker = { type:'user/message', data:{ id:`native-input:super-${ticketId}-${assignmentId}:${inputVersion}`,
    source:{ kind:'dsh-collab', form:'input-reference' } } }
  const start = { type:'turn/start', data:{} }, end = { type:'turn/end', data:{ reason:{ kind:'completed' } } }
  const draft = artifactQuietDraft([marker, start, end], f.ticket(), assignmentId, id => id)
  assert.deepEqual(draft, { inputVersion, startupWork:true })
  assert.equal(artifactQuietDraft([marker, start, { type:'turn/end', data:{ reason:{ kind:'failed' } } }], f.ticket(), assignmentId, id => id), undefined)
  assert.equal(f.bridge.recoverDraftSubmission(ticketId, assignmentId, draft), 'queued')
  const ticket = f.ticket()
  const [reminder] = ticket.inputs
  assert.match(reminder.text, /Call the next available artifact tool/)
  ticket.undelivered = []
  f.store.tickets.save(ticket)
  const consumed = { type:'user/message', data:{ id:reminder.id, source:{ kind:'dsh-superagent' } } }
  const repeated = artifactQuietDraft([marker, start, consumed, end], ticket, assignmentId, id => id)
  assert.equal(f.bridge.recoverDraftSubmission(ticketId, assignmentId, repeated), 'blocked')
  assert.equal(f.ticket().inputs.length, 1)
})

test('delivered but unread human input cannot certify an earlier worker action', async t => {
  const f = workspace(t)
  const ticket = f.ticket()
  ticket.inputs.push({ kind: 'trigger', id: 'follow-up', triggerId: ticket.origin.triggerId, human: true, context: false,
    at: ticket.updatedAt, readAt: null, deliveredTo: f.assignment().id })
  f.store.tickets.save(ticket)
  assert.throws(() => f.check(true), /stale or unavailable assignment/)
  await assert.rejects(f.report(), /passing workspace verification/)
  const reference = `native-input:super-${ticket.id}-${f.assignment().id}:${f.currentScope().inputVersion}`
  f.setHistory([{ type: 'user/message', data: { id: reference, source: { kind: 'user' } } }])
  assert.throws(() => f.check(true), /stale or unavailable assignment/)
  f.setHistory([{ type: 'user/message', data: { id: reference, source: { kind: 'dsh-collab', form: 'input-reference' } } }])
  f.check(true)
  f.setHistory([])
  await assert.rejects(f.report(), /passing workspace verification/)
  ticket.inputs[0].readAt = ticket.updatedAt
  f.store.tickets.save(ticket)
  f.check(true)
  assert.equal((await f.report()).reported, true)
})

test('a failing input relays once and repair is transactional, idempotent and durable', t => {
  const f = workspace(t)
  const original = f.check(false)
  assert.equal(original.repairRequested, true)
  assert.deepEqual(f.check(false), original)
  assert.equal(f.relays.length, 1)
  const [notice] = f.relays
  assert.equal(notice.id, original.id)
  assert.equal(notice.payload.kind, 'workspace_check_failed')
  assert.deepEqual(notice.payload.failed_checks, [{ id: 'workspace-output', diagnostic: 'Observed state needs repair.' }])

  f.failNextNote(true)
  assert.throws(() => f.repair(original.id), /Injected repair enqueue failure/)
  assert.deepEqual(f.ticket().inputs, [])
  assert.deepEqual(f.ticket().undelivered, [])
  f.failNextNote(false)
  assert.equal(f.repair(original.id).status, 'queued')
  const [repair] = f.ticket().inputs
  assert.equal(repair.reviewOf, original.id)
  assert.deepEqual(f.ticket().undelivered, [repair.id])

  f.restart()
  assert.equal(f.repair(original.id, 'Do not replace the original repair.').status, 'already_queued')
  assert.deepEqual(f.ticket().inputs, [repair])
  assert.equal(f.relays.length, 1)
})

test('failed observations on a new revision do not wake again until the input version changes', t => {
  const f = workspace(t)
  const oldScope = f.currentScope()
  const old = f.check(false)
  f.edit('b')
  assert.throws(() => f.repair(old.id), /superseded/)
  const current = f.check(false)
  assert.notEqual(current.id, old.id)
  assert.equal(f.relays.length, 1)
  assert.equal(f.repair(current.id).status, 'queued')
  const [note] = f.ticket().inputs
  assert.equal(f.bridge.discardSupersededReminder(ticketId, oldScope.assignmentId, note.id, current.id), false)

  f.edit('c')
  assert.equal(f.bridge.discardSupersededReminder(ticketId, oldScope.assignmentId, note.id, current.id), true)
  assert.deepEqual(f.ticket().undelivered, [])
  f.check(false)
  assert.equal(f.relays.length, 1)

  f.correct()
  assert.throws(() => f.check(true, oldScope), /stale or unavailable assignment/)
  assert.equal(f.bridge.discardSupersededReminder(ticketId, oldScope.assignmentId, note.id, current.id), true)
  assert.deepEqual(f.ticket().undelivered, [])
  const newInput = f.check(false)
  assert.equal(f.relays.length, 2)
  assert.equal(f.relays[1].id, newInput.id)
  assert.equal(f.repair(newInput.id, 'Apply the new requested setting and rerun the check.').status, 'queued')
  const newNote = f.ticket().inputs.at(-1)

  const priorAssignment = f.currentScope()
  f.replaceAssignment()
  assert.equal(f.bridge.discardSupersededReminder(ticketId, priorAssignment.assignmentId, newNote.id, newInput.id), true)
  assert.throws(() => f.check(true, priorAssignment), /stale or unavailable assignment/)
  assert.throws(() => f.repair(newInput.id), /superseded/)
})

test('fresh host evidence permits one more transactional repair and suppresses repeated observations', t => {
  const f = workspace(t)
  const fail = (diagnostic, observed) => ({ id: 'workspace-output', passed: false, diagnostic, observed })
  const success = { id: 'checked-format', passed: true }
  const first = f.check(false, { checks: [fail('Count\nwas 2', 'Count was 2'), success] })
  assert.deepEqual(f.relays[0].payload.failed_checks, [{ id: 'workspace-output', diagnostic: 'Count was 2' }])
  assert.deepEqual(f.check(false, { checks: [success, fail('  Count\t  was 2 ')] }), first)
  assert.equal(f.repair(first.id).status, 'queued')
  const firstNote = f.ticket().inputs.at(-1)

  f.edit('b')
  f.check(false, { checks: [success, fail('Count was 2')] })
  assert.equal(f.relays.length, 1)
  assert.equal(f.bridge.discardSupersededReminder(ticketId, f.assignment().id, firstNote.id, first.id), true)
  const observed = 'Endpoint now returns ' + '😺'.repeat(150)
  const second = f.check(false, { checks: [success, fail('Count was 2', observed)] })
  assert.equal(f.relays.length, 2)
  assert.equal(f.relays[1].id, second.id)
  assert.notEqual(second.id, first.id)
  assert.equal([...f.relays[1].payload.failed_checks[0].observed].length, 140)
  assert.throws(() => f.repair(first.id), /superseded/)
  assert.deepEqual(f.check(false, { checks: [fail('Count was 2'), success] }), second)
  f.failNextNote(true)
  assert.throws(() => f.repair(second.id), /Injected repair enqueue failure/)
  assert.equal(f.ticket().undelivered.length, 0)
  f.failNextNote(false)
  assert.equal(f.repair(second.id).status, 'queued')

  f.restart()
  assert.equal(f.repair(second.id).status, 'already_queued')
  const saturated = f.check(false, { checks: [fail('New diagnosis', 'Count now 3'), success] })
  assert.notEqual(saturated.id, second.id)
  assert.equal(f.relays.length, 2)
  assert.equal(f.repair(saturated.id).status, 'already_queued')
  f.correct()
  f.check(false, { checks: [success, fail('New diagnosis')] })
  assert.equal(f.relays.length, 3)
  f.restoreInput()
  const restored = f.check(false, { checks: [success, fail('Restored earlier input scope')] })
  assert.equal(f.relays.length, 3)
  assert.equal(f.repair(restored.id).status, 'already_queued')
})

test('a changed failure set earns the bounded follow-up and puts newly failing checks first', t => {
  const f = workspace(t)
  const originallyFailed = Array.from({ length: 10 }, (_, index) => ({ id: `failure-${index}`, passed: false }))
  const first = f.check(false, { checks: originallyFailed })
  assert.equal(f.relays[0].payload.failed_count, 10)
  assert.equal(f.relays[0].payload.failed_checks.length, 8)
  f.repair(first.id)

  f.edit('b')
  f.check(true)
  assert.throws(() => f.repair(first.id), /superseded/)
  f.restart()
  f.edit('c')
  f.check(false, { checks: [...originallyFailed].reverse() })
  assert.equal(f.relays.length, 1)

  const newFailure = { id: 'late-failure', passed: false }
  const second = f.check(false, { checks: [...originallyFailed.slice(1), { id: 'failure-0', passed: true }, newFailure] })
  assert.equal(f.relays.length, 2)
  assert.equal(f.relays[1].id, second.id)
  assert.deepEqual(f.relays[1].payload.failed_checks[0], { id: 'late-failure' })
  assert.equal(f.repair(second.id).status, 'queued')
  f.check(false, { checks: [newFailure] })
  assert.equal(f.relays.length, 2)
})

test('a persisted single-repair receipt can recover newer evidence without a migration', t => {
  const f = workspace(t)
  const first = f.check(false)
  assert.equal(f.repair(first.id).status, 'queued')
  f.store.db.prepare('DELETE FROM collab_workspace_repairs WHERE ticket_id = ?').run(ticketId)

  f.restart()
  assert.deepEqual(f.check(false), first)
  assert.equal(f.repair(first.id).status, 'already_queued')
  const next = f.check(false, { checks: [{ id: 'workspace-output', passed: false, observed: 'Current match count is 0' }] })
  assert.equal(f.relays.length, 2)
  assert.equal(f.repair(next.id).status, 'queued')
})

test('a serial successor requires the exact issued reply and its current accepted workspace checkpoint', async t => {
  const f = workspace(t)
  const issuedId = 'workspace-stage-reply'
  f.check(true)
  await f.report()
  const [report] = f.bridge.readEvents().events
  const send = await f.issue(report.id, issuedId)
  assert.equal(f.bridge.isCurrentIssuedLocalReply(f.ticket(), issuedId), false)
  await send()
  assert.equal(f.bridge.isCurrentIssuedLocalReply(f.ticket(), issuedId), true)
  assert.equal(f.bridge.isCurrentIssuedLocalReply(f.ticket(), 'another-reply'), false)
  f.restart()
  assert.equal(f.bridge.isCurrentIssuedLocalReply(f.ticket(), issuedId), true)
  f.edit('b')
  assert.equal(f.bridge.isCurrentIssuedLocalReply(f.ticket(), issuedId), false)
  f.edit('a')
  f.correct('Now verify a new input.')
  assert.equal(f.bridge.isCurrentIssuedLocalReply(f.ticket(), issuedId), false)
})
