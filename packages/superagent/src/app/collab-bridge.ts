/** Durable report bridge for dsh-collab. This service is trusted host integration, not a model-facing authority. */
import { Service, type Context } from '@deepseek-ai/cordis'
import { randomUUID, createHash } from 'node:crypto'
import type { DomainEvent, Engine, Ticket, WorkerReport } from '../core/index.ts'
import { workerSessionId } from '../executor/dsh.ts'
import type { Store } from './store.ts'
import { captureTaskInput } from './input-snapshot.ts'
import { threadKey } from '../core/index.ts'
import { threadTitle } from './views/records.ts'

export interface CollabRelay { id: string; text: string }
export interface CollabReportEvent {
  id: string; seq: number; kind: 'worker_report'; ticketId: string; assignmentId: string | null; sessionId: string;
  createdAt: string; report: Pick<WorkerReport, 'state' | 'summary' | 'question' | 'answers'>;
  read: string; routeOwner: 'legacy' | 'projection' | 'internal'; routeEpoch: number;
  originalRelay: CollabRelay | null; deliveredRelay: CollabRelay | null;
  codec?: string; version?: string; projectionError?: string;
  reviewContext?: { version:1; inputVersion:string; sources:{read:string;sha256:string;outputFormat:string}[]; children:unknown; verificationScope:string };
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
  engine: Pick<Engine, 'stopTicket' | 'retryTicket' | 'acceptReadyReport' | 'note'>;
  sessions: { relay(id: string, text: string): void };
  masterId: string;
}
export interface CollabCommand { commandId: string; kind: 'stop' | 'retry'; ticketId: string; reason?: string }
export interface CollabOperator { kind: 'operator'; id: string }
export interface CollabLifecycle {
  bindWorker(ticket: Ticket, sessionId: string): void;
  beforeReady(ticket: Ticket): void;
  reviewState?(ticket: Ticket): unknown;
}

declare module '@deepseek-ai/cordis' { interface Context { orchestratorCollabBridge: CollabBridge } }

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const digest = (value:unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
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
      INSERT OR IGNORE INTO collab_bridge_meta VALUES ('schema','1');
    `));
    const schema = host.store.db.prepare("SELECT value FROM collab_bridge_meta WHERE key='schema'").get();
    if (schema?.value !== '1') throw new Error('Unsupported collaboration bridge schema');
    this.routeEpoch = Number(host.store.db.prepare("SELECT value FROM collab_bridge_meta WHERE key='route_epoch'").get()?.value ?? 0);
  }
  private active(): void { if (this.closed) throw new Error('Collaboration bridge stopped') }
  close(): void { this.closed = true; this.projector = undefined; this.lifecycle = undefined }
  compatibility() { return { apiVersion: this.apiVersion, capabilities: { ...this.capabilities, domainEvents: true, coordinatorReview: true,
    managedStartupBarrier: !!this.lifecycle, managedChildren: !!this.lifecycle }, required: !!this.host.requireCollaboration,
    mode: this.lifecycle ? 'managed' : this.projector ? 'report' : 'observe' } }
  registerLifecycle(lifecycle: CollabLifecycle): () => void {
    this.active(); if (this.lifecycle) throw new Error('Collaboration lifecycle already registered');
    this.lifecycle = lifecycle; return () => { if (this.lifecycle === lifecycle) this.lifecycle = undefined };
  }
  prepareWorker(sessionId: string): void {
    const row = this.snapshot().tickets.find(row => row.workerSessionId === sessionId);
    if (!row) return;
    if (!this.lifecycle && this.host.requireCollaboration) throw new Error('Collaboration adapter is required before worker requests');
    this.lifecycle?.bindWorker(row.ticket, sessionId);
  }
  beforeReport(ticket: Ticket, report: Pick<WorkerReport, 'state'>): void {
    if (report.state !== 'ready') return;
    if (!this.lifecycle && this.host.requireCollaboration) throw new Error('Collaboration adapter is required before ready reports');
    this.lifecycle?.beforeReady(ticket);
  }
  recordDomain(event: DomainEvent): void {
    const ticket = 'ticketId' in event.data ? this.host.store.tickets.get(event.data.ticketId) : undefined;
    this.appendLifecycle({ kind: 'domain', event, ...(ticket ? { ticket: clone(ticket) } : {}) });
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
      if (prior) { if (String(prior.value) !== JSON.stringify(value)) throw new Error('Review is immutable; request a new worker report'); return value; }
      if(report.reviewContext && report.reviewContext.inputVersion!==this.inputSnapshot(ticket.id).version)throw new Error('Report predates current task inputs; request an updated report');
      if(accepted)this.beforeReport(ticket,{state:'ready'});
      this.host.store.db.prepare('INSERT INTO collab_bridge_reviews VALUES (?,?)').run(reportId, JSON.stringify(value));
      this.appendLifecycle({ kind: 'coordinator_review', ...value });
      if (accepted && (this.lifecycle || this.host.requireCollaboration)) this.host.engine.acceptReadyReport(report.ticketId, report.assignmentId!);
      if (!accepted) this.host.engine.note(report.ticketId, `Main review rejected report ${reportId}: ${reason}. Correct the result and submit a new report; the rejected original remains archived.`);
      return value;
    });
  }
  assertReviewed(ticketId: string): void {
    if (!this.lifecycle && !this.host.requireCollaboration) return;
    const ticket = this.host.store.tickets.get(ticketId);
    const row = this.host.store.db.prepare('SELECT value FROM collab_bridge_events WHERE ticket_id=? ORDER BY seq DESC LIMIT 1').get(ticketId);
    const report = row && JSON.parse(String(row.value)) as CollabReportEvent | undefined;
    const review = report && this.host.store.db.prepare('SELECT value FROM collab_bridge_reviews WHERE report_id=?').get(report.id);
    if (!report || report.assignmentId !== ticket?.assignments.at(-1)?.id || !review || !JSON.parse(String(review.value)).accepted || (report.reviewContext && ticket && report.reviewContext.inputVersion!==this.inputSnapshot(ticket.id).version))
      throw new Error('Review and accept the latest ready report before replying with a result');
  }
  validateReply(ticketId:string,text:string):void {
    const ticket=this.host.store.tickets.get(ticketId);if(!ticket)throw new Error('Unknown ticket');
    const strict=ticket.origin.triggerIds.some(id=>this.host.store.triggers.get(id)?.meta.outputFormat==='json');
    if(strict){try{JSON.parse(text);}catch{throw new Error('This task requires a complete JSON reply without a preface or markdown fences');}}
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
    this.active();
    return this.host.store.atomic(() => {
      const id = `cb-${randomUUID()}`;
      const event: CollabReportEvent = { id, seq: 0, kind: 'worker_report', ticketId: ticket.id,
        assignmentId: ticket.assignments.at(-1)?.id ?? null, sessionId: workerSessionId(ticket.id),
        createdAt: new Date().toISOString(), report: clone(report), read: `ticket/${ticket.id}/collab-report/${id}`,
        routeOwner: relay ? 'legacy' : 'internal', routeEpoch: this.routeEpoch,
        originalRelay: relay ? clone(relay) : null, deliveredRelay: relay ? clone(relay) : null };
      if(this.lifecycle && report.state==='ready')event.reviewContext={version:1,inputVersion:this.inputSnapshot(ticket.id).version,
        sources:(this.inputSnapshot(ticket.id).content.sources as import('../core/index.ts').Trigger[]).map(source=>({read:`trigger/${source.id}`,sha256:digest(source.text),outputFormat:String(source.meta.outputFormat??'text')})),
        children:clone(this.lifecycle.reviewState?.(ticket)??{available:false}),verificationScope:'Child acceptance is a coordinator assessment; independently compare this report with the original task and necessary evidence.'};
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
