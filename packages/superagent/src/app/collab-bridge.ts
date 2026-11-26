/** Durable report bridge for dsh-collab. This service is trusted host integration, not a model-facing authority. */
import { Service, type Context } from '@deepseek-ai/cordis'
import { randomUUID, createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { DomainEvent, Engine, Ticket, WorkerReport } from '../core/index.ts'
import { ticketOfSession, workerSessionId } from '../executor/dsh.ts'
import type { Store } from './store.ts'
import { captureTaskInput } from './input-snapshot.ts'
import { key, liveTicket, threadKey } from '../core/index.ts'
import { threadTitle } from './views/records.ts'
import { instructionExcerpts, workerEvidence, type ObservationIdentity, type ReviewMetricSpec } from './worker-evidence.ts'
import type { SessionHistoryEvent } from './session-events.ts'
import { checkedEditTurn, type DraftSubmission } from '../executor/draft-submission.ts'
import { editProgressHint } from '../executor/edit-progress.ts'
import { freezeMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { messageId } from './delivery.ts'
import { WorkspaceVerification, type WorkspaceCheck, type WorkspaceVerifier } from './workspace-verification.ts'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { applyWorkerReport } from './notices.ts'
import { localArtifactContract } from './local-tasks.ts'
import { localArtifactReceipts, readLocalArtifact } from './local-artifacts.ts'

export interface CollabRelay { id: string; text: string }
export interface CollabSectionReview {
  preamble: string;
  sections: { title: string; inputRef: string; resultEventId: string }[];
}
export interface ReadyReviewEvidenceScope {
  ticketId: string; assignmentId: string; sessionId: string; inputVersion: string; summary: string;
}
export type ReadyReviewEvidenceProjector = (scope: Readonly<ReadyReviewEvidenceScope>) => Record<string, unknown> | undefined;
export type VerifiedReadyArtifact = Omit<ReadyReviewEvidenceScope, 'sessionId'>;
type ReadyReviewEvidence = { inputVersion: string; assignmentId: string; data: Record<string, unknown> };
export interface HistoricalObservation {
  ref: string; ticketId: string; assignmentId: string; inputVersion: string; tool: string;
  sourceSha256: string; bytes: number; historical: true; jsonPointer: '/text';
  verificationScope: 'historical_source_not_current_verification';
}
export interface CollabReportEvent {
  id: string; seq: number; kind: 'worker_report'; ticketId: string; assignmentId: string | null; sessionId: string;
  createdAt: string; report: Pick<WorkerReport, 'state' | 'summary' | 'question' | 'answers'>;
  read: string; routeOwner: 'legacy' | 'projection' | 'internal'; routeEpoch: number;
  originalRelay: CollabRelay | null; deliveredRelay: CollabRelay | null;
  codec?: string; version?: string; projectionError?: string;
  workerEvidenceUnavailable?: true;
  reviewContext?: { version:1; inputVersion:string; sources:{read:string;read_tool?:'orchestrator_read';sha256:string;outputFormat:string}[]; children:unknown; verificationScope:string; sectionReview?: CollabSectionReview;
    instructionExcerpts?: ReturnType<typeof instructionExcerpts>;
    historicalObservations?: HistoricalObservation[];
    workspaceVerification?: { id: string; revision: string; checks: string[] };
    readyEvidence?: ReadyReviewEvidence;
    workerEvidence?: NonNullable<ReturnType<typeof workerEvidence>> & { sources?: ReturnType<typeof instructionExcerpts> };
    reviewHint?: string };
}
export interface CollabProjectionInput {
  eventId: string; ticketId: string; assignmentId: string | null; sessionId: string; read: string;
  report: CollabReportEvent['report']; relay: CollabRelay;
  reviewContext?: CollabReportEvent['reviewContext'];
}
export type CollabProjector = (input: Readonly<CollabProjectionInput>) => { text: string; codec?: string; version?: string } | undefined;
export interface CollabBridgeHost {
  requireCollaboration?: boolean;
  store: Store;
  engine: Pick<Engine, 'stopTicket' | 'retryTicket' | 'acceptReadyReport' | 'note' | 'reply' | 'report'>;
  sessions: { relay(id: string, text: string): void };
  masterId: string;
  workerHistory?(sessionId: string): readonly SessionHistoryEvent[] | undefined;
}
export interface CollabCommand { commandId: string; kind: 'stop' | 'retry'; ticketId: string; reason?: string }
export interface CollabOperator { kind: 'operator'; id: string }
type FreeWorkerRoute = (sessionId: string, provider?: string, model?: string) => boolean
export interface CollabLifecycle {
  bindWorker(ticket: Ticket, sessionId: string): void;
  awaitingSectionBatch?(ticket: Ticket, sessionId: string): boolean;
  beforeReady(ticket: Ticket): void;
  reviewState?(ticket: Ticket): unknown;
  sectionReview?(ticket: Ticket, inputVersion: string): CollabSectionReview | undefined;
  workerObservationRef?(ticket: Ticket, inputVersion: string, identity: ObservationIdentity): {ref: string} | undefined;
  historicalObservations?(ticket: Ticket, inputVersion: string): HistoricalObservation[];
  acceptedTaskResult?(ticket: Ticket, workItemId: string, workerSessionId: string): unknown;
}

declare module '@deepseek-ai/cordis' { interface Context { orchestratorCollabBridge: CollabBridge } }

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const digest = (value:unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const READY_REVIEW_EVIDENCE_BYTES = 16 * 1024;
const hasUnseenHumanInput = (ticket: Ticket) => ticket.inputs.some(input =>
  input.kind === 'trigger' && input.human && !input.context && input.readAt === null);
const issuedLocalWhere = `FROM collab_bridge_events event
  JOIN collab_bridge_local_replies link ON link.report_id = event.id
  JOIN outbox receipt ON receipt.id = link.reply_id
  WHERE event.ticket_id = ? AND receipt.value ->> '$.ticketId' = event.ticket_id
    AND receipt.value ->> '$.kind' = 'reply' AND receipt.value ->> '$.status' = 'sent'
    AND receipt.value ->> '$.channel.source' = 'local'`;
function sameResult(left: string, right: string): boolean {
  if (left === right) return true;
  try { return isDeepStrictEqual(JSON.parse(left), JSON.parse(right)); }
  catch { return false; }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value) }
  return value;
}
function bounded(value: number | undefined, fallback: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0 || result > max) throw new Error('Invalid bridge cursor or limit');
  return result;
}

/** Records original reports atomically with the existing relay effect, exposes stable history, and delegates operator control to Engine. */
export class CollabBridge extends Service {
  readonly apiVersion = 3;
  readonly capabilities = Object.freeze({ durableReportEvents: true, reportProjection: true, stableReportRead: true,
    operatorControl: true, sharedRelayTransaction: true, versionedTaskInput: true, managedStartupBarrier: false, managedChildren: false });
  private projector: CollabProjector | undefined;
  private lifecycle: CollabLifecycle | undefined;
  private freeWorkerRoute: FreeWorkerRoute | undefined
  private scopedWorkspaceEditor: ((sessionId: string) => boolean) | undefined
  private readonly workspaceChecks: WorkspaceVerification
  private readonly reviewMetrics = new Map<string, { spec: ReviewMetricSpec; allows: (sessionId: string) => boolean }>()
  private readyReviewEvidence?: { project: ReadyReviewEvidenceProjector; submitTool: string | undefined;
    requiresSubmission: ((ticketId: string) => boolean) | undefined; submissionHint: string | undefined }
  private routeEpoch = 0;
  private closed = false;
  constructor(ctx: Context, private readonly host: CollabBridgeHost) {
    super(ctx, 'orchestratorCollabBridge');
    host.store.atomic(() => host.store.db.exec(`
      CREATE TABLE IF NOT EXISTS collab_bridge_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collab_bridge_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, ticket_id TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS collab_bridge_ticket ON collab_bridge_events(ticket_id,seq);
      CREATE TABLE IF NOT EXISTS collab_bridge_receipts (consumer TEXT PRIMARY KEY, seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS collab_bridge_commands (id TEXT PRIMARY KEY, request TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collab_bridge_lifecycle (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collab_bridge_reviews (report_id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collab_bridge_local_replies (report_id TEXT PRIMARY KEY, reply_id TEXT NOT NULL);
      INSERT OR IGNORE INTO collab_bridge_meta VALUES ('schema','1');
    `));
    const schema = host.store.db.prepare("SELECT value FROM collab_bridge_meta WHERE key='schema'").get();
    if (schema?.value !== '1') throw new Error('Unsupported collaboration bridge schema');
    this.workspaceChecks = new WorkspaceVerification(host.store)
    this.routeEpoch = Number(host.store.db.prepare("SELECT value FROM collab_bridge_meta WHERE key='route_epoch'").get()?.value ?? 0);
  }
  private active(): void { if (this.closed) throw new Error('Collaboration bridge stopped') }
  close(): void { this.closed = true; this.projector = undefined; this.lifecycle = undefined; this.freeWorkerRoute = undefined; this.scopedWorkspaceEditor = undefined; this.workspaceChecks.close(); this.reviewMetrics.clear(); delete this.readyReviewEvidence }
  compatibility() { return { apiVersion: this.apiVersion, capabilities: { ...this.capabilities, domainEvents: true, coordinatorReview: true,
    managedStartupBarrier: !!this.lifecycle, managedChildren: !!this.lifecycle, acceptedTaskResult: !!this.lifecycle?.acceptedTaskResult }, required: !!this.host.requireCollaboration,
    mode: this.lifecycle ? 'managed' : this.projector ? 'report' : 'observe' } }
  registerLifecycle(lifecycle: CollabLifecycle): () => void {
    this.active(); if (this.lifecycle) throw new Error('Collaboration lifecycle already registered');
    this.lifecycle = lifecycle; return () => { if (this.lifecycle === lifecycle) this.lifecycle = undefined };
  }
  /** A host that owns a tool may opt its recorded, checked numeric fields into local review. */
  registerReviewMetrics(tool: string, spec: ReviewMetricSpec, allows: (sessionId: string) => boolean): () => void {
    this.active()
    const key = /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/u
    if (!key.test(tool) || !key.test(spec.source) || !Array.isArray(spec.fields) || !spec.fields.length || spec.fields.length > 8
      || !spec.fields.every(field => typeof field === 'string' && key.test(field))
      || new Set(spec.fields).size !== spec.fields.length || typeof allows !== 'function' || this.reviewMetrics.has(tool))
      throw new Error('Invalid or duplicate review metrics registration')
    const registration = { spec: { source: spec.source, fields: [...spec.fields] }, allows }
    this.reviewMetrics.set(tool, registration)
    return () => { if (this.reviewMetrics.get(tool) === registration) this.reviewMetrics.delete(tool) }
  }
  /**
   * A trusted host may attach evidence for an ordinary ready review. The projector must verify the
   * complete scope and return only data suitable for the coordinator and durable report archive.
   * A host may require submission through its registered tool for selected tickets.
   */
  registerReadyReviewEvidence(projector: ReadyReviewEvidenceProjector, options?: {
    submitTool: string; requiresSubmission?: (ticketId: string) => boolean; submissionHint?: string
  }): () => void {
    this.active()
    const submitTool = options?.submitTool
    if (typeof projector !== 'function' || this.readyReviewEvidence || (options && (!/^[a-zA-Z0-9_-]{1,64}$/u.test(submitTool ?? '')
      || (options.requiresSubmission !== undefined && typeof options.requiresSubmission !== 'function')
      || (options.submissionHint !== undefined && (typeof options.submissionHint !== 'string' || !options.submissionHint.trim()
        || options.submissionHint.length > 240)))))
      throw new Error('Invalid or duplicate ready review evidence projector')
    const registration = { project: projector, submitTool, requiresSubmission: options?.requiresSubmission, submissionHint: options?.submissionHint }
    this.readyReviewEvidence = registration
    return () => { if (this.readyReviewEvidence === registration) delete this.readyReviewEvidence }
  }
  private projectReadyReviewEvidence(scope: ReadyReviewEvidenceScope) {
    if (!this.readyReviewEvidence) return
    try {
      const data = this.readyReviewEvidence.project(Object.freeze(scope))
      if (data instanceof Promise) {
        void data.catch(() => {})
        return
      }
      if (!data || typeof data !== 'object' || Array.isArray(data) || 'then' in data) return
      const encoded = JSON.stringify(data)
      if (!encoded?.startsWith('{') || encoded === '{}' || Buffer.byteLength(encoded) > READY_REVIEW_EVIDENCE_BYTES) return
      return { inputVersion: scope.inputVersion, assignmentId: scope.assignmentId, data: JSON.parse(encoded) as Record<string, unknown> }
    } catch { /* Optional host evidence never interferes with the existing review. */ }
  }
  /** Submit an explicitly handed-in artifact from an opted-in worker tool after independent host verification. */
  submitVerifiedReadyArtifact(execution: ToolRunContext, artifact: VerifiedReadyArtifact): { reportId: string } {
    return this.submitArtifact(execution, artifact, this.readyReviewEvidence?.submitTool, scope => this.projectReadyReviewEvidence(scope))
  }

  localArtifactWorkspace(ticketId: string, execution?: ToolRunContext) {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !this.localReplyFormat(ticketId) || ticket.origin.triggerIds.length !== 1) return undefined
    const contract = localArtifactContract(this.host.store.triggers.get(ticket.origin.triggerId))
    if (!contract || !ticket.execution?.directory) return undefined
    if (execution && (execution.agent?.id !== workerSessionId(ticketId) || execution.signal.aborted || execution.parent ||
      execution.callId !== execution.rootCallId || !liveTicket(ticket) || ticket.assignments.at(-1)?.state !== 'running')) return undefined
    return { directory: ticket.execution.directory, files: contract.files, inputs: contract.inputs ?? [] }
  }

  localArtifactEvidence(ticketId: string, execution?: ToolRunContext) {
    const scope = this.localArtifactWorkspace(ticketId, execution)
    if (!scope) throw new Error('No authorized workspace artifact contract for this assignment')
    const files = localArtifactReceipts(scope.directory, scope.files)
    const inputs = localArtifactReceipts(scope.directory, scope.inputs)
    const complete = files.length === scope.files.length && files.every(file => file.bytes > 0) && inputs.length === scope.inputs.length
    return { passed: complete, verificationScope: 'local_workspace_integrity', artifactSha256: digest(files), files, inputs }
  }

  readLocalReviewArtifact(ticketId: string, reportId: string, path: string, offset: number, limit: number) {
    const ticket = this.host.store.tickets.get(ticketId)
    const scope = this.localArtifactWorkspace(ticketId)
    const report = this.pendingLocalReview(ticketId)
    if (!ticket || !scope?.files.includes(path) || !report || report.id !== reportId ||
      report.reviewContext?.inputVersion !== this.inputSnapshot(ticketId).version)
      throw new Error('Artifact is outside the current pending review')
    this.requireVerifiedReport(ticketId, report)
    const page = readLocalArtifact(scope.directory, path, offset, limit)
    const files = report.reviewContext?.readyEvidence?.data.files as { path: string; sha256: string }[] | undefined
    if (!page.exists || page.sha256 !== files?.find(file => file.path === path)?.sha256)
      throw new Error('Artifact changed after submission')
    return page
  }

  submitLocalArtifact(execution: ToolRunContext, ticketId: string, summary: string): { reportId: string } {
    const ticket = this.host.store.tickets.get(ticketId)
    const assignment = ticket?.assignments.at(-1)
    if (!assignment || !this.localArtifactWorkspace(ticketId, execution)) throw new Error('No current workspace assignment')
    const inputVersion = this.inputSnapshot(ticketId, assignment.id).version
    return this.submitArtifact(execution, { ticketId, assignmentId: assignment.id, inputVersion, summary }, 'artifact_check', scope => {
      const data = this.localArtifactEvidence(ticketId, execution)
      if (!data.passed) throw new Error('Every declared output must exist and be nonempty, and every declared input must exist')
      return { inputVersion: scope.inputVersion, assignmentId: scope.assignmentId, data }
    })
  }

  private submitArtifact(execution: ToolRunContext, artifact: VerifiedReadyArtifact, submitTool: string | undefined,
    project: (scope: ReadyReviewEvidenceScope) => ReadyReviewEvidence | undefined): { reportId: string } {
    this.active()
    const sessionId = execution.agent?.id
    if (!sessionId || !execution.name || execution.name !== submitTool || execution.parent
      || execution.callId !== execution.rootCallId || execution.signal.aborted)
      throw new Error('Only the registered worker submission tool may hand in verified artifacts')
    const reportId = this.host.store.atomic(() => {
      const { ticketId, assignmentId, inputVersion, summary } = artifact
      const ticket = this.host.store.tickets.get(ticketId)
      const assignment = ticket?.assignments.at(-1)
      if (!this.lifecycle || !ticket || !liveTicket(ticket) || sessionId !== workerSessionId(ticket.id) ||
        assignment?.id !== assignmentId || assignment.state !== 'running' || ticket.attention || ticket.undelivered.length ||
        !this.localReplyFormat(ticket.id) || !this.workspaceInputDelivered(ticket, sessionId, assignmentId, inputVersion) ||
        this.inputSnapshot(ticket.id, assignmentId).version !== inputVersion || this.lifecycle.sectionReview?.(ticket, inputVersion))
        throw new Error('Verified artifact belongs to a stale or unavailable local assignment')
      if (this.pendingLocalReview(ticket.id)) throw new Error('This assignment already has a ready report pending coordinator review')
      if (typeof summary !== 'string' || !summary.trim() || summary.length > 20000)
        throw new Error('Verified artifact requires a complete ready summary')
      this.validateReply(ticket.id, summary)
      const report = { state: 'ready' as const, summary }
      this.beforeReadyReport(ticket)
      const evidence = project({ ticketId, assignmentId, sessionId, inputVersion, summary })
      if (!evidence || execution.signal.aborted) throw new Error('Verified artifact has no current, matching host evidence')
      const { ticket: updated, relay } = applyWorkerReport(this.host.engine, ticket.id, report)
      if (!liveTicket(updated) || !relay) throw new Error('Verified artifact requires independent coordinator review')
      return this.archiveReport(updated, report, relay, evidence).id
    })
    execution.concludeTurn()
    return { reportId }
  }
  registerFreeWorkerRoute(verify: FreeWorkerRoute): () => void {
    this.active()
    if (this.freeWorkerRoute) throw new Error('Free worker route already registered')
    this.freeWorkerRoute = verify
    return () => { if (this.freeWorkerRoute === verify) this.freeWorkerRoute = undefined }
  }
  private hasFreeWorkerRoute(sessionId: string, provider?: string, model?: string): boolean {
    try { return this.freeWorkerRoute?.(sessionId, provider, model) === true } catch { return false }
  }
  /** The host that installs scoped edit tools attests which native worker may use them. */
  registerScopedWorkspaceEditor(verify: (sessionId: string) => boolean): () => void {
    this.active()
    if (this.scopedWorkspaceEditor) throw new Error('Scoped workspace editor already registered')
    this.scopedWorkspaceEditor = verify
    return () => { if (this.scopedWorkspaceEditor === verify) this.scopedWorkspaceEditor = undefined }
  }
  /** Only the trusted workspace host can register a verifier or attest its tool's result. */
  registerWorkspaceVerification(verifier: WorkspaceVerifier): () => void {
    this.active()
    return this.workspaceChecks.register(verifier)
  }
  private workspaceInputDelivered(ticket: Ticket, sessionId: string, assignmentId: string, inputVersion: string): boolean {
    const pendingScope = ticket.inputs.some(input => ticket.undelivered.includes(input.id)
      && input.kind !== 'resumed' && !(input.kind === 'note' && (input.reviewOf || input.submissionFor)))
    if (!pendingScope && !hasUnseenHumanInput(ticket)) return true
    // The managed bridge can supply the current immutable input before the ordinary trigger is read.
    const input = this.host.workerHistory?.(sessionId)?.findLast(event => {
      if (event.type !== 'user/message' || !event.data || typeof event.data !== 'object') return false
      const message = event.data as { source?: { kind?: string; form?: string } }
      return message.source?.kind === 'dsh-collab' && message.source.form === 'input-reference'
    })?.data as { id?: string } | undefined
    return input?.id === `native-input:super-${ticket.id}-${assignmentId}:${inputVersion}`
  }
  private currentWorkspaceCheck(ticket: Ticket) {
    const assignment = ticket.assignments.at(-1), sessionId = workerSessionId(ticket.id)
    if (!assignment || !this.workspaceChecks.applies(sessionId)) return
    const inputVersion = this.inputSnapshot(ticket.id, assignment.id).version
    if (!this.workspaceInputDelivered(ticket, sessionId, assignment.id, inputVersion)) return
    return this.workspaceChecks.current(ticket.id, sessionId, { assignmentId: assignment.id, inputVersion })
  }
  recordWorkspaceVerification(sessionId: string, check: WorkspaceCheck): { id: string; repairRequested: boolean } {
    this.active()
    return this.host.store.atomic(() => {
      const ticketId = ticketOfSession(sessionId)
      const ticket = ticketId && this.host.store.tickets.get(ticketId)
      const assignment = ticket ? ticket.assignments.at(-1) : undefined
      if (!ticket || !liveTicket(ticket) || assignment?.state !== 'running' || assignment.id !== check.assignmentId
        || ticket.attention || !this.localReplyFormat(ticket.id)
        || this.inputSnapshot(ticket.id, assignment.id).version !== check.inputVersion
        || !this.workspaceInputDelivered(ticket, sessionId, assignment.id, check.inputVersion))
        throw new Error('Workspace verification belongs to a stale or unavailable assignment')
      const { receipt, notice } = this.workspaceChecks.record(ticket.id, sessionId, check)
      if (notice) this.host.sessions.relay(receipt.id, JSON.stringify({ kind: 'workspace_check_failed', ticket_id: ticket.id,
        verification_id: receipt.id, failed_checks: notice.slice(0, 8),
        ...(notice.length > 8 ? { failed_count: notice.length } : {}),
        instruction: 'Use these diagnostics as evidence. Send one short targeted repair via orchestrator_ticket_note with this verification_id. The worker already has the task and workspace. Ask it to recheck after editing.' }))
      return { id: receipt.id, repairRequested: receipt.repairRequested }
    })
  }
  sendWorkspaceRepair(ticketId: string, verificationId: string, instruction: string): { status: 'queued' | 'already_queued'; verificationId: string } {
    this.active()
    return this.host.store.atomic(() => {
      const ticket = this.host.store.tickets.get(ticketId)
      const receipt = ticket && liveTicket(ticket) && !ticket.attention && this.currentWorkspaceCheck(ticket)
      if (!ticket || !receipt || receipt.id !== verificationId || receipt.passed || !receipt.repairRequested)
        throw new Error('Workspace check was superseded; inspect the current result')
      if (receipt.repairSent) return { status: 'already_queued', verificationId }
      if (!instruction.trim() || instruction.length > 700) throw new Error('Use a concise repair instruction of at most 700 characters')
      this.host.engine.note(ticket.id, instruction.trim(), receipt.id)
      this.workspaceChecks.markRepairSent(ticket.id, receipt)
      return { status: 'queued', verificationId }
    })
  }
  private canEditWorkspace(sessionId: string): boolean {
    try { return this.scopedWorkspaceEditor?.(sessionId) === true } catch { return false }
  }
  assertReminderRoute(sessionId: string, provider: string, model: string): void {
    const ticketId = ticketOfSession(sessionId)
    const ticket = ticketId && this.host.store.tickets.get(ticketId)
    if (!ticket) return
    const reminders = new Map<string, DraftSubmission & { assignmentId: string }>()
    for (const input of ticket.inputs) {
      if (input.kind === 'note' && (input.submissionFor?.verifiedWork || input.submissionFor?.startupWork)) {
        reminders.set(messageId(key(input.id)), input.submissionFor)
      }
    }
    if (!reminders.size) return
    const events = this.host.workerHistory?.(sessionId) ?? []
    const start = events.findLastIndex(event => event.type === 'turn/start')
    if (start < 0) return
    for (const event of events.slice(start + 1)) {
      if (event.type !== 'user/message') continue
      const data = event.data as { id?: string; source?: { kind?: string } }
      if (data.source?.kind !== 'dsh-superagent' || !data.id) continue
      const reminder = reminders.get(data.id)
      if (!reminder) continue
      if (reminder.startupWork && reminder.assignmentId === ticket.assignments.at(-1)?.id && this.localArtifactWorkspace(ticket.id) &&
        reminder.inputVersion === this.inputSnapshot(ticket.id).version) continue
      if (!this.hasFreeWorkerRoute(sessionId, provider, model)) throw new Error('Workspace reminder requires the free native worker route')
      if (reminder.startupWork && !this.canEditWorkspace(sessionId)) throw new Error('Workspace startup reminder requires the scoped editor')
    }
  }
  prepareWorker(sessionId: string): void {
    const row = this.snapshot().tickets.find(row => row.workerSessionId === sessionId);
    if (!row) return;
    if (!this.lifecycle && this.host.requireCollaboration) throw new Error('Collaboration adapter is required before worker requests');
    this.lifecycle?.bindWorker(row.ticket, sessionId);
    const assignment = row.ticket.assignments.at(-1);
    if (assignment) this.reuseOriginalAcknowledgement(row.ticket.id, assignment.id);
  }
  private originalAcknowledgement(ticketId: string, assignmentId: string) {
    const ticket = this.host.store.tickets.get(ticketId);
    const assignment = ticket?.assignments.at(-1);
    if (!ticket || !liveTicket(ticket) || assignment?.id !== assignmentId || assignment.state !== 'running'
      || ticket.origin.triggerIds.length !== 1 || ticket.origin.triggerIds[0] !== ticket.origin.triggerId) return;
    const trigger = this.host.store.triggers.get(ticket.origin.triggerId);
    if (trigger?.source !== 'local' || !trigger.human || trigger.channel?.source !== 'local') return;
    const receipt = this.host.store.receipts.get(key('ack', trigger.id));
    if (receipt?.status !== 'sent' || receipt.kind !== 'acknowledgement' || receipt.ticketId !== ticketId
      || !isDeepStrictEqual(receipt.channel, trigger.channel)) return;
    return { triggerId: trigger.id, text: receipt.text };
  }
  /** Reuse an already delivered original acknowledgement through the normal worker take-up path. */
  reuseOriginalAcknowledgement(ticketId: string, assignmentId: string): string | undefined {
    this.active();
    return this.host.store.atomic(() => {
      const ack = this.originalAcknowledgement(ticketId, assignmentId);
      if (!ack) return;
      if (!this.host.store.triggers.disposition(ack.triggerId)?.acked?.includes(ticketId))
        this.host.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: ack.triggerId, text: ack.text });
      return this.sentOriginalAcknowledgement(ticketId, assignmentId);
    });
  }
  sentOriginalAcknowledgement(ticketId: string, assignmentId: string): string | undefined {
    const ack = this.originalAcknowledgement(ticketId, assignmentId);
    return ack && this.host.store.triggers.disposition(ack.triggerId)?.acked?.includes(ticketId) ? ack.triggerId : undefined;
  }
  beforeReport(ticket: Ticket, report: Pick<WorkerReport, 'state'>): void {
    if (report.state !== 'ready') return;
    const submission = this.readySubmissionHint(ticket.id)
    if (submission) throw new Error(`Ready requires verified artifact submission. ${submission}`)
    this.beforeReadyReport(ticket)
  }
  readySubmissionHint(ticketId: string): string | undefined {
    if (this.localArtifactWorkspace(ticketId)) return 'Use artifact_check with submit_for_review=true to deliver the declared files.'
    const policy = this.readyReviewEvidence
    if (policy?.requiresSubmission?.(ticketId))
      return policy.submissionHint ?? `Call ${policy.submitTool} with its submission option and wait for the host receipt.`
  }
  private beforeReadyReport(ticket: Ticket): void {
    if (this.workspaceChecks.applies(workerSessionId(ticket.id)) && !this.currentWorkspaceCheck(ticket)?.passed)
      throw new Error('Ready requires passing workspace verification for the current input and revision. Fix the failing checks, or report blocked with the exact gap.')
    if (!this.lifecycle && this.host.requireCollaboration) throw new Error('Collaboration adapter is required before ready reports');
    this.lifecycle?.beforeReady(ticket);
  }
  isAwaitingSectionBatch(ticket: Ticket, sessionId: string): boolean {
    return !this.closed && this.lifecycle?.awaitingSectionBatch?.(ticket, sessionId) === true;
  }
  recordDomain(event: DomainEvent): void {
    const ticket = 'ticketId' in event.data ? this.host.store.tickets.get(event.data.ticketId) : undefined;
    this.appendLifecycle({ kind: 'domain', event, ...(ticket ? { ticket: clone(ticket) } : {}) });
  }
  /** A worker's quiet end is available to the UI and history without becoming a reviewable report or a master inbox item. */
  recordIdleStatus(ticket: Ticket, assignmentId: string, endSeq: number): void {
    const report = ticket.assignments.at(-1)?.report
    if (ticket.assignments.at(-1)?.id !== assignmentId || report?.state !== 'waiting') return
    this.active()
    const id = `idle:${ticket.id}:${assignmentId}:${endSeq}`
    this.host.store.db.prepare('INSERT INTO collab_bridge_lifecycle(id,value) VALUES (?,?) ON CONFLICT(id) DO NOTHING')
      .run(id, JSON.stringify({ kind: 'worker_status', ticketId: ticket.id, assignmentId, turnEndSeq: endSeq,
        state: report.state, at: report.at, summary: report.summary, read: `ticket/${ticket.id}/result` }))
  }
  private appendLifecycle(payload: unknown): void {
    this.active(); const id = `cl-${randomUUID()}`;
    this.host.store.db.prepare('INSERT INTO collab_bridge_lifecycle(id,value) VALUES (?,?)').run(id, JSON.stringify(payload));
  }
  readLifecycle(afterSeq = 0, limit = 200) {
    this.active(); bounded(afterSeq, 0, Number.MAX_SAFE_INTEGER); bounded(limit, 200, 1000);
    const events = this.host.store.db.prepare('SELECT seq,id,value FROM collab_bridge_lifecycle WHERE seq>? ORDER BY seq LIMIT ?').all(afterSeq, limit)
      .map(row => ({ id: String(row.id), seq: Number(row.seq), payload: JSON.parse(String(row.value)) as unknown }));
    return { events, nextSeq: events.at(-1)?.seq ?? afterSeq };
  }
  reviewReport(reportId: string, accepted: boolean, reason: string) {
    this.active(); if (typeof accepted !== 'boolean' || !reason.trim()) throw new Error('An explicit assessment and reason are required');
    return this.host.store.atomic(() => {
      const report = this.readReport(reportId); if (!report || report.report.state !== 'ready') throw new Error('Review an existing ready report');
      const ticket = this.host.store.tickets.get(report.ticketId);
      if (!ticket || ticket.assignments.at(-1)?.id !== report.assignmentId
        || this.readEvents({ ticketId: ticket.id, afterSeq: report.seq }).events.length) throw new Error('Report is stale; read the latest report');
      const value = { reportId, ticketId: report.ticketId, assignmentId: report.assignmentId, accepted, reason, actorId: this.host.masterId };
      const prior = this.host.store.db.prepare('SELECT value FROM collab_bridge_reviews WHERE report_id=?').get(reportId);
      if(report.reviewContext && report.reviewContext.inputVersion!==this.inputSnapshot(ticket.id).version)throw new Error('Report predates current task inputs; request an updated report');
      if (accepted) this.requireVerifiedReport(ticket.id, report)
      if (prior) {
        const recorded = JSON.parse(String(prior.value)) as typeof value;
        if (accepted && recorded.accepted && this.localReplyFormat(ticket.id)) return recorded;
        if (String(prior.value) !== JSON.stringify(value)) throw new Error('Review is immutable; request a new worker report');
        return value;
      }
      const repeated = !accepted && this.repeatedLocalResult(ticket, report);
      if (repeated) return { ...value, status: 'unchanged_result' as const, previousReportId: repeated,
        guidance: 'Correction already delivered for this result. Verify the disputed claim against the source before accepting this report or sending new facts.' };
      if (accepted) {
        this.beforeReadyReport(ticket)
        const checked = report.reviewContext?.workspaceVerification
        if (checked && checked.id !== this.currentWorkspaceCheck(ticket)?.id) throw new Error('Report workspace verification is stale; submit the current result')
      }
      this.host.store.db.prepare('INSERT INTO collab_bridge_reviews VALUES (?,?)').run(reportId, JSON.stringify(value));
      this.appendLifecycle({ kind: 'coordinator_review', ...value });
      if (accepted && (this.lifecycle || this.host.requireCollaboration)) this.host.engine.acceptReadyReport(report.ticketId, report.assignmentId!);
      if (!accepted) this.host.engine.note(report.ticketId, `Coordinator assessment: ${reason}`, reportId);
      return value;
    });
  }
  private currentReviewFeedback(ticket: Ticket, assignmentId: string) {
    const assignment = ticket.assignments.at(-1)
    if (ticket.ended || ticket.attention || assignment?.id !== assignmentId || assignment.state !== 'running'
      || !['ready', 'waiting'].includes(assignment.report?.state ?? '') || !this.localReplyFormat(ticket.id)) return
    const latest = ticket.inputs.at(-1)
    if (latest?.kind !== 'note' || !latest.reviewOf) return
    const row = this.host.store.db.prepare(`SELECT event.id, event.value, review.value AS review
      FROM collab_bridge_events AS event LEFT JOIN collab_bridge_reviews AS review ON review.report_id = event.id
      WHERE event.ticket_id = ? ORDER BY event.seq DESC LIMIT 1`).get(ticket.id)
    if (row?.id !== latest.reviewOf || !row.review || JSON.parse(String(row.review)).accepted !== false) return
    const report = JSON.parse(String(row.value)) as CollabReportEvent
    if (report.assignmentId !== assignmentId || report.report.state !== 'ready'
      || report.reviewContext?.inputVersion !== this.inputSnapshot(ticket.id).version) return
    return { latest, reportId: report.id }
  }
  /** Retire a stale reminder without recording a delivery or changing the last-input timestamp. */
  discardSupersededReminder(ticketId: string, assignmentId: string, inputId: string, reportId: string): boolean {
    return this.host.store.atomic(() => {
      const ticket = this.host.store.tickets.get(ticketId)
      if (!ticket) return false
      const notes = ticket.inputs.filter(input => input.kind === 'note' && input.reviewOf === reportId)
      if (reportId.startsWith('wc-')) {
        if (!notes.some(input => input.id === inputId)) return false
        const check = this.currentWorkspaceCheck(ticket)
        if (check?.id === reportId && check.assignmentId === assignmentId && check.repairSent && !check.passed) return false
      } else {
        if (!notes.slice(1).some(input => input.id === inputId)) return false
        if (this.currentReviewFeedback(ticket, assignmentId)?.latest.id === inputId) return false
      }
      if (ticket.undelivered.includes(inputId)) {
        ticket.undelivered = ticket.undelivered.filter(id => id !== inputId)
        this.host.store.tickets.save(ticket)
      }
      return true
    })
  }
  /** Queue one native feedback input for a consumed correction that ended without a new formal report. */
  recoverReviewFeedback(ticketId: string, assignmentId: string, consumedInputId: string): 'queued' | 'blocked' | undefined {
    return this.host.store.atomic(() => {
      const ticket = this.host.store.tickets.get(ticketId)
      if (!ticket) return
      const feedback = this.currentReviewFeedback(ticket, assignmentId)
      if (!feedback) return
      const { latest, reportId } = feedback
      const notes = ticket.inputs.filter(item => item.kind === 'note' && item.reviewOf === reportId)
      if (!notes.some(item => item.id === consumedInputId)) return
      // The original turn may emit the same idle notification after its durable reminder was queued.
      if (notes.length > 1 && consumedInputId !== latest.id) return 'queued'
      if (ticket.undelivered.length) return
      if (notes.length > 1) return 'blocked'
      this.host.engine.note(ticketId, 'Your last turn ended without a worker report. Submit the corrected answer already in this session through the report tool now.', reportId)
      return 'queued'
    })
  }
  private initialSubmissionAllowed(ticket: Ticket, assignmentId: string, draft: DraftSubmission): boolean {
    const assignment = ticket.assignments.at(-1)
    const sessionId = workerSessionId(ticket.id)
    const workspace = draft.verifiedWork || draft.startupWork
    const artifact = draft.startupWork && !!this.localArtifactWorkspace(ticket.id)
    return !!this.lifecycle && !ticket.ended && !ticket.attention && assignment?.id === assignmentId
      && assignment.state === 'running' && !assignment.report && this.localReplyFormat(ticket.id) === (workspace ? 'text' : 'json')
      && (!workspace || (ticket.mandate.strength === 'explicit' && (artifact || this.hasFreeWorkerRoute(sessionId))))
      && (!draft.startupWork || artifact || this.canEditWorkspace(sessionId))
  }
  /** Guide the worker's next already-planned step. This message neither wakes a worker nor creates a ready report. */
  checkedEditGuidance(sessionId: string, history: readonly SessionEvent[], incoming: readonly UserMessage[]): UserMessage | undefined {
    if (!this.lifecycle || incoming.some(message => ['user', 'dsh-superagent', 'dsh-collab'].includes(message.source.kind))) return
    const ticketId = ticketOfSession(sessionId)
    const ticket = ticketId && this.host.store.tickets.get(ticketId)
    if (!ticket || ticket.ended || ticket.attention || ticket.undelivered.length || ticket.mandate.strength !== 'explicit'
      || this.localReplyFormat(ticket.id) !== 'text') return
    const assignment = ticket.assignments.at(-1)
    if (assignment?.state !== 'running' || assignment.report?.state === 'ready') return
    const signal = checkedEditTurn(history) ?? (this.canEditWorkspace(sessionId) ? editProgressHint(history) : undefined)
    if (!signal) return
    const checked = 'passed' in signal
    const id = messageId(checked ? `edit-check:${signal.turnSeq}:${signal.passed ? 'passed' : 'failed'}`
      : `edit-progress:${signal.turnSeq}:${signal.kind}`)
    if (history.some(event => event.type === 'user/message' && event.data.id === id) || incoming.some(message => message.id === id)) return
    if (this.inputSnapshot(ticket.id).version !== signal.inputVersion) return
    const submission = this.readySubmissionHint(ticket.id)
    const text = checked
      ? signal.passed
        ? submission
          ? `The edit and checks returned receipts. If they cover the whole request, submit the checked revision now. ${submission} Continue if required work is open.`
          : 'The edit and checks returned receipts. If they cover the whole request, call orchestrator_report with state="ready" now. In summary give the actual change: name the file and the exact key rule, setting or value you changed. Give concrete check results. Continue if required work is open.'
        : 'An edit check failed. Use its diagnostics to correct the edit and rerun the check now. Use the editing and checking tools directly. If blocked, report the specific blocker with orchestrator_report.'
      : signal.kind === 'RepeatedCheck'
        ? 'The same checks failed without a verified edit. Use the latest diagnostics to choose one required, independently checkable change. Read only its target if needed, make the edit through an approved tool, then rerun the check. If blocked, report the specific blocker with orchestrator_report.'
        : 'This source range has already been read without a verified edit. Reuse the existing result. For an authorized workspace change, make one targeted edit and verify it. Read a different range only when it resolves a missing detail. If blocked, report the specific blocker with orchestrator_report.'
    return freezeMessage({ id, role: 'user', source: { kind: 'dsh-superagent', form: 'notice', summary: checked ? 'Edit check' : 'Edit progress' },
      content: [{ type: 'text', text }] })
  }
  recoverDraftSubmission(ticketId: string, assignmentId: string, draft: DraftSubmission): 'queued' | 'blocked' | undefined {
    return this.host.store.atomic(() => {
      const ticket = this.host.store.tickets.get(ticketId)
      if (!ticket || !this.initialSubmissionAllowed(ticket, assignmentId, draft)) return
      if (this.inputSnapshot(ticket.id).version !== draft.inputVersion || ticket.undelivered.length) return 'queued'
      const prior = ticket.inputs.find(input => input.kind === 'note' && input.submissionFor?.assignmentId === assignmentId
        && input.submissionFor.inputVersion === draft.inputVersion)
      if (prior) return prior.id === draft.reminderId ? 'blocked' : 'queued'
      const submission = this.readySubmissionHint(ticketId)
      const text = submission
        ? `Your prior turn ended without handing in the declared output. Reuse any edits already confirmed by tool receipts. Call the next available artifact tool to do the work. If the work is ready, ${submission} If blocked, report the exact blocker with orchestrator_report. A plan or waiting message does not execute tools.`
        : draft.startupWork
        ? 'Your last turn ended without verified acceptance. Resume the same assignment now. Run the required check if you already edited. If work is still missing, use the scoped editor to make one bounded change and check it. Reuse existing inspection. Submit the result or the exact blocker with orchestrator_report.'
        : draft.verifiedWork
          ? 'Submit the checked result from the previous turn now. Call orchestrator_report with state="ready". In summary name the file, the exact key rule, setting or value you changed, and concrete check results. Reuse recorded receipts. If unresolved, report the specific blocker.'
          : 'Your JSON draft is still in this session. Submit it with orchestrator_report, state="ready" and the complete answer in summary. If unresolved, report the specific blocker. The coordinator must review a formal report.'
      this.host.engine.note(ticketId, text, { assignmentId, inputVersion: draft.inputVersion, ...(draft.verifiedWork ? { verifiedWork: true } : {}),
        ...(draft.startupWork ? { startupWork: true } : {}) })
      return 'queued'
    })
  }
  discardSupersededSubmission(ticketId: string, assignmentId: string, inputId: string): boolean {
    return this.host.store.atomic(() => {
      const ticket = this.host.store.tickets.get(ticketId)
      const input = ticket?.inputs.find(item => item.id === inputId)
      if (!ticket || input?.kind !== 'note' || !input.submissionFor) return false
      if (input.submissionFor.assignmentId === assignmentId && this.initialSubmissionAllowed(ticket, assignmentId, input.submissionFor)
        && this.inputSnapshot(ticket.id).version === input.submissionFor.inputVersion) return false
      ticket.undelivered = ticket.undelivered.filter(id => id !== inputId)
      this.host.store.tickets.save(ticket)
      return true
    })
  }
  /** Suppress another correction when the previous review saw the same result and evidence. */
  private repeatedLocalResult(ticket: Ticket, report: CollabReportEvent): string | undefined {
    if (!report.reviewContext || !this.requiresJsonReply(ticket, true)) return undefined;
    const row = this.host.store.db.prepare(`SELECT event.value AS report, review.value AS review
      FROM collab_bridge_events AS event JOIN collab_bridge_reviews AS review ON review.report_id = event.id
      WHERE event.ticket_id = ? AND event.seq < ? ORDER BY event.seq DESC LIMIT 1`).get(ticket.id, report.seq);
    if (!row || JSON.parse(String(row.review)).accepted !== false) return undefined;
    const previous = JSON.parse(String(row.report)) as CollabReportEvent;
    if (previous.assignmentId !== report.assignmentId || previous.reviewContext?.inputVersion !== report.reviewContext.inputVersion
      || !isDeepStrictEqual(previous.reviewContext.children, report.reviewContext.children)
      || !isDeepStrictEqual(previous.reviewContext.workerEvidence, report.reviewContext.workerEvidence)
      || !isDeepStrictEqual(previous.reviewContext.readyEvidence, report.reviewContext.readyEvidence)
      || previous.report.answers !== report.report.answers || previous.report.question !== report.report.question
      || !sameResult(previous.report.summary, report.report.summary)) return undefined;
    return previous.id;
  }
  assertReviewed(ticketId: string): void {
    if (!this.lifecycle && !this.host.requireCollaboration) return;
    const ticket = this.host.store.tickets.get(ticketId);
    const row = this.host.store.db.prepare('SELECT value FROM collab_bridge_events WHERE ticket_id=? ORDER BY seq DESC LIMIT 1').get(ticketId);
    const report = row && JSON.parse(String(row.value)) as CollabReportEvent | undefined;
    const review = report && this.host.store.db.prepare('SELECT value FROM collab_bridge_reviews WHERE report_id=?').get(report.id);
    if (!report || report.assignmentId !== ticket?.assignments.at(-1)?.id || !review || !JSON.parse(String(review.value)).accepted || (report.reviewContext && ticket && report.reviewContext.inputVersion!==this.inputSnapshot(ticket.id).version))
      throw new Error('Review and accept the latest ready report before replying with a result');
    this.requireVerifiedReport(ticketId, report)
    const checked = report.reviewContext?.workspaceVerification
    if (checked && (!ticket || this.currentWorkspaceCheck(ticket)?.id !== checked.id))
      throw new Error('The accepted workspace verification is stale')
  }
  private requireVerifiedReport(ticketId: string, report: CollabReportEvent): void {
    if (this.localArtifactWorkspace(ticketId)) {
      const latest = this.localArtifactEvidence(ticketId)
      if (!latest.passed || !isDeepStrictEqual(latest, report.reviewContext?.readyEvidence?.data))
        throw new Error('The workspace files changed after submission. Submit the current files for review.')
      return
    }
    if (this.readyReviewEvidence?.requiresSubmission?.(ticketId) && !report.reviewContext?.readyEvidence)
      throw new Error('The ready report lacks a verified artifact submission for this ticket')
  }
  validateReply(ticketId:string,text:string):void {
    const ticket=this.host.store.tickets.get(ticketId);if(!ticket)throw new Error('Unknown ticket');
    const strict = this.requiresJsonReply(ticket);
    if(strict){try{JSON.parse(text);}catch{throw new Error('This task requires a complete JSON reply without a preface or markdown fences');}}
  }
  private requiresJsonReply(ticket: Ticket, localOnly = false): boolean {
    return ticket.origin.triggerIds.some(id => {
      const trigger = this.host.store.triggers.get(id)
      return trigger?.meta.outputFormat === 'json' && (!localOnly || trigger.source === 'local')
    })
  }
  /** Only a local origin and local destination can receive an automatically reused answer. */
  localReplyFormat(ticketId: string): 'json' | 'text' | undefined {
    const ticket = this.host.store.tickets.get(ticketId);
    if (!ticket) return;
    const origin = this.host.store.triggers.get(ticket.origin.triggerId);
    const channel = origin?.channel ?? ticket.channels?.[0];
    if (origin?.source !== 'local' || (channel && channel.source !== 'local')) return;
    const origins = ticket.origin.triggerIds.map(id => this.host.store.triggers.get(id));
    return origin.meta.outputFormat === 'json' && origins.every(trigger => trigger?.source === 'local' && trigger.meta.outputFormat === 'json')
      ? 'json' : 'text';
  }
  /** Only the actual outbox text of an issued, reviewed local result counts as the historical answer. */
  issuedLocalResults(ticketId: string, offset: number, limit: number) {
    this.active();
    const start = bounded(offset, 0, Number.MAX_SAFE_INTEGER), size = Math.max(1, bounded(limit, 10, 20));
    if (!this.localReplyFormat(ticketId)) return { items: [], next_offset: null };
    const rows = this.host.store.db.prepare(`SELECT receipt.id AS id, event.id AS report,
      event.value ->> '$.assignmentId' AS assignment,
      substr(receipt.value ->> '$.text', 1, 120) AS preview
      ${issuedLocalWhere} ORDER BY event.seq LIMIT ? OFFSET ?`).all(ticketId, size + 1, start);
    const items = rows.slice(0, size).map(({ id, report, assignment, preview }) =>
      ({ id, report, assignment, preview, read: `ticket/${ticketId}/issued/${id}` }));
    return { items, next_offset: rows.length > size ? start + size : null };
  }
  issuedLocalResult(ticketId: string, replyId: string): string | undefined {
    this.active();
    if (!this.localReplyFormat(ticketId)) return;
    const row = this.host.store.db.prepare(`SELECT receipt.value ->> '$.text' AS text
      ${issuedLocalWhere} AND receipt.id = ? LIMIT 1`).get(ticketId, replyId);
    return typeof row?.text === 'string' ? row.text : undefined;
  }
  /** Validate a serial handoff against the latest accepted report and sent result. */
  isCurrentIssuedLocalReply(ticket: Ticket, replyId: string): boolean {
    const issued = this.currentIssuedLocalReport(ticket, replyId)
    if (!issued) return false
    if (this.localArtifactWorkspace(ticket.id)) {
      try { this.requireVerifiedReport(ticket.id, issued.report) } catch { return false }
    }
    return true
  }
  currentIssuedLocalReplyId(ticket: Ticket): string | undefined {
    return this.currentIssuedLocalReport(ticket)?.replyId
  }
  /** Return the sent review evidence; the download must still compare it against the current file bytes. */
  issuedLocalArtifactEvidence(ticketId: string) {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !this.localArtifactWorkspace(ticketId)) return
    const issued = this.currentIssuedLocalReport(ticket)
    const evidence = issued?.report.reviewContext?.readyEvidence?.data
    if (issued && evidence) return { evidence, replyId: issued.replyId }
  }
  private currentIssuedLocalReport(ticket: Ticket, replyId?: string) {
    this.active()
    if (!this.localReplyFormat(ticket.id) || ticket.ended?.outcome !== 'completed' || ticket.ended.by !== 'executor') return
    if (this.workspaceChecks.applies(workerSessionId(ticket.id)) && !this.currentWorkspaceCheck(ticket)?.passed) return
    const row = this.host.store.db.prepare(`SELECT event.value AS report, receipt.id AS reply,
      (SELECT value FROM collab_bridge_reviews WHERE report_id=event.id) AS review
      ${issuedLocalWhere} AND event.seq=(SELECT MAX(seq) FROM collab_bridge_events WHERE ticket_id=event.ticket_id)`).get(ticket.id)
    if (typeof row?.reply !== 'string' || (replyId !== undefined && row.reply !== replyId)
      || !row.review || JSON.parse(String(row.review)).accepted !== true) return
    const report = JSON.parse(String(row.report)) as CollabReportEvent
    if (report.report.state === 'ready' && report.assignmentId === ticket.assignments.at(-1)?.id
      && report.reviewContext?.inputVersion === this.inputSnapshot(ticket.id).version
      && (!this.readyReviewEvidence?.requiresSubmission?.(ticket.id) || Boolean(report.reviewContext.readyEvidence))
      && (!report.reviewContext.workspaceVerification || report.reviewContext.workspaceVerification.id === this.currentWorkspaceCheck(ticket)?.id))
      return { report, replyId: row.reply }
  }
  /** Bind one Engine outbox entry to the accepted local report, even when a replay rewords the reply. */
  queueResult(ticketId: string, enqueue: () => string): { id: string; reused?: true } {
    if (!this.localReplyFormat(ticketId)) return { id: enqueue() };
    return this.host.store.atomic(() => {
      if (this.localArtifactWorkspace(ticketId) || this.readyReviewEvidence?.requiresSubmission?.(ticketId)) this.assertReviewed(ticketId)
      const latest = this.host.store.db.prepare('SELECT id FROM collab_bridge_events WHERE ticket_id=? ORDER BY seq DESC LIMIT 1').get(ticketId);
      if (!latest) return { id: enqueue() };
      const reportId = String(latest.id);
      const review = this.host.store.db.prepare('SELECT value FROM collab_bridge_reviews WHERE report_id=?').get(reportId);
      if (!review || JSON.parse(String(review.value)).accepted !== true) return { id: enqueue() };
      this.assertReviewed(ticketId);
      const prior = this.host.store.db.prepare('SELECT reply_id FROM collab_bridge_local_replies WHERE report_id=?').get(reportId);
      if (prior) return { id: String(prior.reply_id), reused: true };
      const id = enqueue();
      this.host.store.db.prepare('INSERT INTO collab_bridge_local_replies (report_id,reply_id) VALUES (?,?)').run(reportId, id);
      return { id };
    });
  }
  /** Resolve an accepted whole-task child result for the owning worker's local JSON ready report. */
  acceptedTaskResult(ticket: Ticket, workItemId: string): string {
    this.active()
    if (!this.requiresJsonReply(ticket, true) || !this.lifecycle?.acceptedTaskResult) {
      throw new Error('This ticket requires a ready report summary')
    }
    const result = this.lifecycle.acceptedTaskResult(ticket, workItemId, workerSessionId(ticket.id))
    if (!result || typeof result !== 'object') throw new Error('Accepted work must provide a complete JSON result')
    const summary = JSON.stringify(result)
    if (!summary || summary.length > 20000) throw new Error('Accepted work exceeds the ready result limit; report a complete summary instead')
    return summary
  }
  /** Reuse an entire ready JSON report after the coordinator explicitly reviews it. */
  readyJsonReply(reportId: string): string | undefined {
    return this.readyLocalReply(reportId, false)
  }
  /** Resolve the exact archived summary; reviewReport still owns acceptance and the input-version gate. */
  readyLocalReply(reportId: string, useReport: boolean): string | undefined {
    const report = this.readReport(reportId)
    if (report?.report.state !== 'ready') return undefined
    const format = this.localReplyFormat(report.ticketId)
    if (!format || (!useReport && format !== 'json')) return undefined
    if (useReport) {
      const ticket = this.host.store.tickets.get(report.ticketId)
      if (!report.reviewContext || !ticket || !ticket.origin.triggerIds.every(id => this.host.store.triggers.get(id)?.source === 'local')) return undefined
    }
    const reply = report.report.summary
    if (!reply.trim() || reply.length > 20000) return undefined
    return reply
  }
  reportTicket(reportId:string):string {
    const report=this.readReport(reportId);if(!report)throw new Error('Unknown report');return report.ticketId;
  }
  /** Host-only title sources; the HUD adapter sanitizes and pins the resulting assignment label. */
  displayTitles(ticketId: string) {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket) return {}
    const origin = this.host.store.triggers.get(ticket.origin.triggerId)
    const thread = origin?.threads.map(ref => this.host.store.threads.get(threadKey(ref))).find(Boolean)
    return { assignmentTitle: ticket.execution?.name || ticket.title, threadTitle: thread ? threadTitle(this.host.store, thread) : '' }
  }

  /** Returns detached snapshots; the existing Engine remains the sole Ticket/Assignment authority. */
  snapshot(ticketId?: string) {
    this.active();
    const tickets = ticketId ? [this.host.store.tickets.get(ticketId)].filter((ticket): ticket is Ticket => !!ticket) : this.host.store.tickets.list();
    return { masterSessionId: this.host.masterId, tickets: tickets.map(ticket => ({ ticket: clone(ticket),
      workerSessionId: workerSessionId(ticket.id), assignmentId: ticket.assignments.at(-1)?.id ?? null })) };
  }
  /** Full, immutable input view for the current assignment. Never exposes delivery bookkeeping. */
  inputSnapshot(ticketId: string, assignmentId?: string) {
    this.active();
    const ticket = this.host.store.tickets.get(ticketId);
    if (!ticket || (assignmentId && ticket.assignments.at(-1)?.id !== assignmentId)) throw new Error('Unknown or stale input assignment');
    return freeze(captureTaskInput(ticket, id => this.host.store.triggers.get(id)));
  }
  /** Only one synchronous projector owns future report representation. Existing durable effects are never rewritten. */
  registerProjection(projector: CollabProjector): () => void {
    this.active();
    if (typeof projector !== 'function' || this.projector) throw new Error('A report projector is already registered or invalid');
    this.routeEpoch++;
    this.host.store.db.prepare("INSERT INTO collab_bridge_meta VALUES ('route_epoch',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(this.routeEpoch));
    this.projector = projector;
    return () => { if (this.projector === projector) this.projector = undefined };
  }
  /** Called inside the report's original Store.atomic boundary. No asynchronous work or second delivery queue is introduced. */
  recordReport(ticket: Ticket, report: CollabReportEvent['report'], relay?: CollabRelay): CollabReportEvent {
    if (report.state === 'ready' && (this.localArtifactWorkspace(ticket.id) || this.readyReviewEvidence?.requiresSubmission?.(ticket.id)))
      throw new Error('The ready report must come from the registered artifact submission tool')
    return this.archiveReport(ticket, report, relay)
  }
  private archiveReport(ticket: Ticket, report: CollabReportEvent['report'], relay?: CollabRelay, evidence?: ReadyReviewEvidence): CollabReportEvent {
    this.active();
    return this.host.store.atomic(() => {
      const id = `cb-${randomUUID()}`;
      const event: CollabReportEvent = { id, seq: 0, kind: 'worker_report', ticketId: ticket.id,
        assignmentId: ticket.assignments.at(-1)?.id ?? null, sessionId: workerSessionId(ticket.id),
        createdAt: new Date().toISOString(), report: clone(report), read: `ticket/${ticket.id}/collab-report/${id}`,
        routeOwner: relay ? 'legacy' : 'internal', routeEpoch: this.routeEpoch,
        originalRelay: relay ? clone(relay) : null, deliveredRelay: relay ? clone(relay) : null };
      if (this.lifecycle && report.state === 'ready') {
        const snapshot = this.inputSnapshot(ticket.id);
        event.reviewContext = { version: 1, inputVersion: snapshot.version,
          sources: (snapshot.content.sources as import('../core/index.ts').Trigger[]).map(source =>
            ({ read: `trigger/${source.id}`, read_tool: 'orchestrator_read', sha256: digest(source.text), outputFormat: String(source.meta.outputFormat ?? 'text') })),
          children: clone(this.lifecycle.reviewState?.(ticket) ?? { available: false }),
          verificationScope: 'Child acceptance is a coordinator assessment; independently compare this report with the original task and necessary evidence.' };
        const checked = this.currentWorkspaceCheck(ticket)
        if (checked?.passed) event.reviewContext.workspaceVerification = { id: checked.id, revision: checked.revision,
          checks: checked.checks.map(item => item.id) }
        if (this.lifecycle.sectionReview) {
          const sectionReview = this.lifecycle.sectionReview(ticket, snapshot.version);
          if (sectionReview) event.reviewContext.sectionReview = clone(sectionReview);
        }
        const local = this.localReplyFormat(ticket.id)
        if (local) {
          if (relay && event.assignmentId && liveTicket(ticket)
            && ticket.assignments.at(-1)?.state === 'running' && !event.reviewContext.sectionReview) {
            const packet = evidence ?? this.projectReadyReviewEvidence({ ticketId: ticket.id, assignmentId: event.assignmentId,
              sessionId: event.sessionId, inputVersion: snapshot.version, summary: report.summary })
            if (packet) {
              event.reviewContext.readyEvidence = packet
              event.reviewContext.reviewHint = 'Review the current request and this scoped evidence together. Judge whether the checks cover the requirements. Read an exact source for a material gap, contradiction or requested audit. If the evidence settles the report, call orchestrator_collab_finish.'
              if (packet.data.verificationScope === 'local_workspace_integrity')
                event.reviewContext.reviewHint += ` The host checked file integrity. To inspect a specific submitted file, use orchestrator_read with ticket/${ticket.id}/artifact/${event.id}/<path>.`
            }
          }
          const verifiedReady = Boolean(event.reviewContext.readyEvidence)
          const excerpts = instructionExcerpts(ticket, snapshot.content.sources, event.reviewContext.sectionReview?.preamble, local,
            verifiedReady, verifiedReady)
          if (excerpts.length) event.reviewContext.instructionExcerpts = excerpts
          try {
            const historical = this.lifecycle.historicalObservations?.(ticket, snapshot.version)
            if (historical?.length) event.reviewContext.historicalObservations = clone(historical.slice(0, 2))
          } catch { /* Optional historical hints never turn old evidence into a required current check. */ }
        }
        if (local && !event.reviewContext.sectionReview && this.host.workerHistory && this.lifecycle.workerObservationRef) {
          try {
            const history = this.host.workerHistory(event.sessionId)
            if (history) {
              const evidence = workerEvidence(snapshot.version, event.sessionId, history, report.summary,
                identity => this.lifecycle?.workerObservationRef?.(ticket, snapshot.version, identity),
                identity => {
                  const registration = this.reviewMetrics.get(identity.tool)
                  return registration?.allows(identity.sessionId) ? registration.spec : undefined
                })
              if (evidence) {
                event.reviewContext.workerEvidence = evidence
                if (evidence.observed.some(observation => observation.metrics)) {
                  event.reviewContext.instructionExcerpts = instructionExcerpts(ticket, snapshot.content.sources, undefined, local,
                    true, Boolean(event.reviewContext.readyEvidence))
                }
                const instructions = event.reviewContext.instructionExcerpts
                if (local === 'text' && !event.reviewContext.readyEvidence && instructions?.length === 1 && 'text' in instructions[0]!
                  && evidence.observed.some(observation => observation.checks?.length)) {
                  event.reviewContext.reviewHint = 'Review the complete request, report and recorded outcomes here. Use orchestrator_collab_finish when they settle the result. Read a source only for a specific missing fact, conflict or requested audit.'
                }
              }
            }
          } catch { event.workerEvidenceUnavailable = true } // Optional observations cannot interrupt the original review relay.
        }
      }
      if (relay && this.lifecycle) {
        const native = JSON.parse(relay.text) as Record<string, unknown>;
        event.deliveredRelay = { id: relay.id, text: JSON.stringify({ ...native, read: event.read, report_id: id,...event.reviewContext?{review_context:event.reviewContext}:{} }) };
      }
      if (relay && this.projector) {
        try {
          const projected = this.projector(freeze({ eventId: id, ticketId: event.ticketId,
            assignmentId: event.assignmentId, sessionId: event.sessionId, read: event.read, report: clone(event.report), reviewContext:event.reviewContext,relay: clone(event.deliveredRelay!) }));
          if (projected !== undefined) {
            if (typeof projected !== 'object' || !projected || 'then' in projected || typeof projected.text !== 'string' || !projected.text.trim())
              throw new Error('Projection must synchronously return non-empty text');
            event.routeOwner = 'projection';
            event.deliveredRelay = { id: relay.id, text: projected.text };
            if (projected.codec !== undefined) event.codec = String(projected.codec);
            if (projected.version !== undefined) event.version = String(projected.version);
          }
        } catch (error) { event.projectionError = error instanceof Error ? error.message : String(error) }
      }
      const row = this.host.store.db.prepare('INSERT INTO collab_bridge_events(id,ticket_id,value) VALUES (?,?,?) RETURNING seq')
        .get(id, ticket.id, JSON.stringify(event));
      event.seq = Number(row!.seq);
      // Sequence is SQL-owned; JSON is written once after insertion, before this transaction can become visible.
      this.host.store.db.prepare('UPDATE collab_bridge_events SET value=? WHERE id=?').run(JSON.stringify(event), id);
      if (event.deliveredRelay) this.host.sessions.relay(event.deliveredRelay.id, event.deliveredRelay.text);
      return clone(event);
    });
  }
  readEvents(query: { afterSeq?: number; ticketId?: string; limit?: number } = {}) {
    this.active();
    const after = bounded(query.afterSeq, 0, Number.MAX_SAFE_INTEGER), limit = bounded(query.limit, 100, 1000);
    const rows = query.ticketId
      ? this.host.store.db.prepare('SELECT value FROM collab_bridge_events WHERE seq>? AND ticket_id=? ORDER BY seq LIMIT ?').all(after, query.ticketId, limit)
      : this.host.store.db.prepare('SELECT value FROM collab_bridge_events WHERE seq>? ORDER BY seq LIMIT ?').all(after, limit);
    const events = rows.map(row => JSON.parse(String(row.value)) as CollabReportEvent);
    return { events, nextSeq: events.at(-1)?.seq ?? after };
  }
  readReport(eventId: string): CollabReportEvent | undefined {
    this.active();
    const row = this.host.store.db.prepare('SELECT value FROM collab_bridge_events WHERE id=?').get(eventId);
    return row ? JSON.parse(String(row.value)) as CollabReportEvent : undefined;
  }
  /** Return the latest relayed ready report only while its original local assignment can still be reviewed. */
  pendingLocalReview(ticketId: string): CollabReportEvent | undefined {
    const ticket = this.host.store.tickets.get(ticketId);
    if (!ticket || ticket.ended || ticket.attention || ticket.undelivered.length) return;
    const assignment = ticket.assignments.at(-1);
    if (assignment?.state !== 'running' || assignment.report?.state !== 'ready') return;
    if (this.host.store.triggers.get(ticket.origin.triggerId)?.source !== 'local') return;
    const row = this.host.store.db.prepare(`SELECT event.value, review.report_id AS reviewed
      FROM collab_bridge_events AS event LEFT JOIN collab_bridge_reviews AS review ON review.report_id = event.id
      WHERE event.ticket_id = ? ORDER BY event.seq DESC LIMIT 1`).get(ticketId);
    if (!row || row.reviewed) return;
    const event = JSON.parse(String(row.value)) as CollabReportEvent;
    if (!event.deliveredRelay || event.report.state !== 'ready' || event.assignmentId !== assignment.id
      || !event.reviewContext || event.reviewContext.inputVersion !== this.inputSnapshot(ticketId).version) return;
    return event;
  }
  /** Consumer must commit its local copied events and cursor before acknowledging. This never deletes source events. */
  acknowledge(consumer: string, seq: number): void {
    this.active();
    if (!consumer || consumer.length > 200) throw new Error('Invalid bridge consumer');
    bounded(seq, 0, Number.MAX_SAFE_INTEGER);
    const maximum = Number(this.host.store.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM collab_bridge_events').get()!.seq);
    if (seq > maximum) throw new Error('Cannot acknowledge a future event');
    this.host.store.db.prepare('INSERT INTO collab_bridge_receipts VALUES (?,?) ON CONFLICT(consumer) DO UPDATE SET seq=MAX(seq,excluded.seq)').run(consumer, seq);
  }
  /** Trusted local management adapters only; never expose this method to an LLM or accept an actor from untrusted request JSON. */
  operatorControl(command: CollabCommand, actor: CollabOperator) {
    this.active();
    if (!actor || actor.kind !== 'operator' || !actor.id) throw new Error('Operator authorization required');
    if (!command.commandId || !command.ticketId || !['stop', 'retry'].includes(command.kind)) throw new Error('Invalid management command');
    return this.host.store.atomic(() => {
      const request = JSON.stringify({ command, actor });
      const prior = this.host.store.db.prepare('SELECT request,result FROM collab_bridge_commands WHERE id=?').get(command.commandId);
      if (prior) {
        if (prior.request !== request) throw new Error('Command id reused with different content');
        return JSON.parse(String(prior.result)) as { commandId: string; kind: string; ticket: Ticket };
      }
      const ticket = command.kind === 'stop' ? this.host.engine.stopTicket(command.ticketId, command.reason) : this.host.engine.retryTicket(command.ticketId);
      const result = { commandId: command.commandId, kind: command.kind, ticket: clone(ticket) };
      this.host.store.db.prepare('INSERT INTO collab_bridge_commands VALUES (?,?,?)').run(command.commandId, request, JSON.stringify(result));
      return result;
    });
  }
}
