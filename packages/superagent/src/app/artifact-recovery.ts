import { canRetry, latestAssignment, type Ticket } from '../core/index.ts'

const tokenAdmissionMessage = 'Run token admission budget exceeded'

/** Recognizes the native admission exception and older archived reports containing only its message. */
export function isArtifactTokenBudgetError(error: unknown): boolean {
  const value = error as { code?: string; message?: string; failure?: { code?: string; message?: string } } | null
  if (value?.code === 'TOKEN_BUDGET' || value?.failure?.code === 'TOKEN_BUDGET') return true
  const message = value?.failure?.message ?? value?.message ?? (typeof error === 'string' ? error : undefined)
  return message === tokenAdmissionMessage || message === `Error: ${tokenAdmissionMessage}`
}

/** Owner-facing state of the current file assignment. Older results remain attached to their original attempts. */
export function artifactRecovery(ticket: Ticket) {
  const assignment = latestAssignment(ticket)
  if (ticket.ended || !assignment) return
  const state = { canRetry: canRetry(ticket), assignmentId: assignment.id }
  const report = assignment.report
  if (report?.state === 'failed' && (report.failureCode === 'token_budget' || isArtifactTokenBudgetError(report.summary)))
    return { ...state, kind: 'token_budget' as const, message: report.summary }
  if (ticket.delivery) return { ...state, kind: 'delivery_failed' as const, message: ticket.delivery.error }
  if (report?.state === 'blocked') return { ...state, kind: 'worker_blocked' as const, message: report.summary }
  if (report?.state === 'failed') return { ...state, kind: 'worker_failed' as const, message: report.summary }
}
