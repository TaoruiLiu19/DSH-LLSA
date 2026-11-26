import { randomUUID } from 'node:crypto'
import type { Store } from './store.ts'

export interface WorkspaceVerifier {
  applies(sessionId: string): boolean
  currentRevision(sessionId: string): string | undefined
}

export interface WorkspaceCheck {
  assignmentId: string
  inputVersion: string
  revision: string
  passed: boolean
  checks: readonly WorkspaceOutcome[]
}

interface FailureEvidence { id: string; diagnostic?: string; observed?: string }
interface WorkspaceOutcome extends FailureEvidence { passed: boolean }
type RepairState = ({ count: 1; initial: readonly FailureEvidence[] } | { count: 2 }) & { sent: boolean }
type Scope = Pick<WorkspaceCheck, 'assignmentId' | 'inputVersion'>
export interface WorkspaceReceipt extends WorkspaceCheck {
  id: string
  repairRequested: boolean
  repairSent: boolean
}

const revisionPattern = /^[a-f0-9]{64}$/u
const checkPattern = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/u

function evidenceText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return
  const compact = value.replace(/[\s\p{Cc}]+/gu, ' ').trim()
  const bounded = [...compact].slice(0, limit).join('').trimEnd()
  return bounded || undefined
}

function compactOutcome(item: WorkspaceOutcome, previous?: WorkspaceOutcome): WorkspaceOutcome {
  const diagnostic = evidenceText(item.diagnostic, 180) ?? previous?.diagnostic
  const observed = evidenceText(item.observed, 140) ?? previous?.observed
  return { id: item.id, passed: item.passed, ...(diagnostic ? { diagnostic } : {}),
    ...(observed && observed !== evidenceText(diagnostic, 140) ? { observed } : {}) }
}

function failures(checks: readonly WorkspaceOutcome[]): FailureEvidence[] {
  return checks.filter(item => !item.passed).map(({ passed: _passed, ...evidence }) => evidence)
}

function newEvidence(previous: FailureEvidence | undefined, item: FailureEvidence): boolean {
  if (!previous) return true
  const diagnostic = item.diagnostic && item.diagnostic !== previous.diagnostic && item.diagnostic !== previous.observed
  const observed = item.observed && item.observed !== previous.observed && item.observed !== evidenceText(previous.diagnostic, 140)
  return !!(diagnostic || observed)
}

/** Persistent checkpoint state. The caller binds it to the native assignment, input and workspace. */
export class WorkspaceVerification {
  private verifier?: WorkspaceVerifier

  constructor(private readonly store: Pick<Store, 'db'>) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS collab_workspace_checks (ticket_id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collab_workspace_repairs (
        ticket_id TEXT NOT NULL, assignment_id TEXT NOT NULL, input_version TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY(ticket_id, assignment_id, input_version));
    `)
  }

  register(verifier: WorkspaceVerifier): () => void {
    if (this.verifier || typeof verifier?.applies !== 'function' || typeof verifier.currentRevision !== 'function')
      throw new Error('Invalid or duplicate workspace verifier')
    this.verifier = verifier
    return () => { if (this.verifier === verifier) delete this.verifier }
  }

  close(): void { delete this.verifier }
  applies(sessionId: string): boolean { return this.verifier?.applies(sessionId) === true }

  private read(ticketId: string): WorkspaceReceipt | undefined {
    const row = this.store.db.prepare('SELECT value FROM collab_workspace_checks WHERE ticket_id = ?').get(ticketId)
    if (row) return JSON.parse(String(row.value)) as WorkspaceReceipt
  }

  private save(ticketId: string, receipt: WorkspaceReceipt): void {
    this.store.db.prepare('INSERT INTO collab_workspace_checks VALUES (?,?) ON CONFLICT(ticket_id) DO UPDATE SET value=excluded.value')
      .run(ticketId, JSON.stringify(receipt))
  }

  private readRepair(ticketId: string, scope: Scope): RepairState | undefined {
    const row = this.store.db.prepare('SELECT value FROM collab_workspace_repairs WHERE ticket_id = ? AND assignment_id = ? AND input_version = ?')
      .get(ticketId, scope.assignmentId, scope.inputVersion)
    if (row) return JSON.parse(String(row.value)) as RepairState
  }

  private saveRepair(ticketId: string, scope: Scope, state: RepairState): void {
    this.store.db.prepare(`INSERT INTO collab_workspace_repairs VALUES (?,?,?,?)
      ON CONFLICT(ticket_id,assignment_id,input_version) DO UPDATE SET value=excluded.value`)
      .run(ticketId, scope.assignmentId, scope.inputVersion, JSON.stringify(state))
  }

  current(ticketId: string, sessionId: string, scope: Scope): WorkspaceReceipt | undefined {
    if (!this.applies(sessionId)) return
    const receipt = this.read(ticketId)
    if (receipt?.assignmentId === scope.assignmentId && receipt.inputVersion === scope.inputVersion
      && receipt.revision === this.verifier?.currentRevision(sessionId)) return receipt
  }

  record(ticketId: string, sessionId: string, check: WorkspaceCheck): { receipt: WorkspaceReceipt; notice?: FailureEvidence[] } {
    if (!this.applies(sessionId) || !revisionPattern.test(check.revision) || this.verifier?.currentRevision(sessionId) !== check.revision
      || typeof check.passed !== 'boolean' || !Array.isArray(check.checks) || !check.checks.length || check.checks.length > 128
      || !check.checks.every(item => typeof item?.id === 'string' && checkPattern.test(item.id) && typeof item.passed === 'boolean')
      || new Set(check.checks.map(item => item.id)).size !== check.checks.length
      || check.passed !== check.checks.every(item => item.passed)) throw new Error('Invalid or stale workspace verification')
    const last = this.read(ticketId)
    const sameInput = last?.assignmentId === check.assignmentId && last.inputVersion === check.inputVersion
    const sameRevision = sameInput && last.revision === check.revision
    const previousChecks = new Map((sameRevision ? last.checks : []).map(item => [item.id, compactOutcome(item)]))
    const checks = check.checks.map(item => {
      const previous = previousChecks.get(item.id)
      return compactOutcome(item, !item.passed && previous?.passed === false ? previous : undefined)
    })
    if (sameRevision && last.passed === check.passed && previousChecks.size === checks.length && checks.every(item => {
      const previous = previousChecks.get(item.id)
      return previous?.passed === item.passed && (item.passed || !newEvidence(previous, item))
    })) return { receipt: last }

    const storedRepair = this.readRepair(ticketId, check)
    const previousRepair: RepairState | undefined = storedRepair ?? (sameInput && last.repairRequested
      ? { count: 1, initial: failures(last.checks.map(item => compactOutcome(item))), sent: last.repairSent } : undefined)
    const failed = failures(checks)
    const initial = new Map((previousRepair?.count === 1 ? previousRepair.initial : []).map(item => [item.id, item]))
    const changed = new Set(failed.filter(item => newEvidence(initial.get(item.id), item)).map(item => item.id))
    // A revision change can supersede a queued note without earning another alert by itself.
    const notify = !check.passed && (!previousRepair || (initial.size > 0 && (initial.size !== failed.length || changed.size > 0)))
    const repair: RepairState | undefined = notify
      ? previousRepair ? { count: 2, sent: false } : { count: 1, initial: failed, sent: false }
      : previousRepair
    if (repair && (notify || !storedRepair)) this.saveRepair(ticketId, check, repair)
    const receipt: WorkspaceReceipt = { id: `wc-${randomUUID()}`, assignmentId: check.assignmentId, inputVersion: check.inputVersion,
      revision: check.revision, passed: check.passed, checks, repairRequested: !!repair, repairSent: repair?.sent ?? false }
    this.save(ticketId, receipt)
    if (!notify) return { receipt }
    return { receipt, notice: failed.toSorted((a, b) => Number(changed.has(b.id)) - Number(changed.has(a.id))) }
  }

  markRepairSent(ticketId: string, receipt: WorkspaceReceipt): void {
    const state = this.readRepair(ticketId, receipt) ?? { count: 1 as const, initial: failures(receipt.checks.map(item => compactOutcome(item))), sent: false }
    this.saveRepair(ticketId, receipt, { ...state, sent: true })
    this.save(ticketId, { ...receipt, repairSent: true })
  }
}
