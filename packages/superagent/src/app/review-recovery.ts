import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { transient } from '../executor/dsh.ts'
import type { CollabBridge } from './collab-bridge.ts'
import type { Effects } from './effects.ts'
import type { Sessions } from './sessions.ts'
import type { Store } from './store.ts'

interface Host {
  masterId: string
  store: Pick<Store, 'tickets'>
  bridge: Pick<CollabBridge, 'pendingLocalReview' | 'readReport'>
  effects: Pick<Effects, 'handle' | 'enqueue'>
  sessions: Pick<Sessions, 'prompt' | 'promptedId'>
  paused(): boolean
  closing(): boolean
}
const recoveryId = (reportId: string, attempt: number, afterTurn?: number) =>
  `review-recovery:${reportId}:${attempt}${afterTurn === undefined ? '' : `:after:${afterTurn}`}`

type ReviewMessage = { reportId?: string; attempt?: number; afterTurn?: number; status?: string; replyId?: string;
  review?: { accepted?: boolean; reportId?: string } }
function object(text: string): ReviewMessage | undefined {
  try { const value = JSON.parse(text); return value && typeof value === 'object' ? value as ReviewMessage : undefined }
  catch { return undefined }
}

/** Redeliver only a compact wake-up after a transient failure in a turn which consumed that review.
 * Each retry message has a stable receipt and can schedule at most its successor. The effect survives restart. */
export function installReviewRecovery(ctx: Context, host: Host): () => void {
  const { bridge, sessions } = host
  host.effects.handle('reviewRecovery', async ({ ticketId, reportId, attempt, afterTurn }) => {
    const current = () => bridge.pendingLocalReview(ticketId)?.id === reportId
    if (!current()) return
    const stale = new Error('Review superseded')
    try {
      const text = afterTurn === undefined
        ? `The model connection interrupted your review of ${reportId}. Resume from the ready report already in this session. Check it against the task and finish the review.`
        : JSON.stringify({ kind: 'pending_local_review', reportId, attempt, afterTurn,
            instruction: 'Another ticket was delivered. Review this pending ready report already in the session.' })
      await sessions.prompt(host.masterId, recoveryId(reportId, attempt, afterTurn), text, 'queue',
        () => { if (!current()) throw stale })
    } catch (error) { if (error !== stale) throw error }
  }, { limit: () => host.paused() ? 0 : 1 })

  return ctx.on('session/event', (session: Session, event) => {
    if (session.id !== host.masterId || event.type !== 'turn/end' || host.closing()) return
    const interrupted = event.data.reason.kind === 'error' && transient(event.data.reason.error)
    if (!interrupted && event.data.reason.kind !== 'completed') return
    const inputIds = new Set<string>()
    const carried = new Map<string, number>()
    const finishCalls = new Set<string>()
    const sent = new Set<string>()
    const history = session.snapshotEvents()
    const start = history.findLastIndex(item => item.type === 'turn/start')
    const first = history[start]
    if (first?.type !== 'turn/start' || first.data.turn !== event.data.turn) return
    for (let i = start + 1; i < history.length; i++) {
      const item = history[i]!
      if (item.type === 'user/message' && item.data.source.kind === 'dsh-superagent') {
        inputIds.add(item.data.id)
        for (const block of item.data.content) {
          if (block.type !== 'text' || !block.text.startsWith('{"kind":"pending_local_review",')) continue
          const wake = object(block.text)
          if (wake && typeof wake.reportId === 'string' && Number.isSafeInteger(wake.afterTurn)
            && typeof wake.attempt === 'number' && [0, 1, 2].includes(wake.attempt)
            && sessions.promptedId(recoveryId(wake.reportId, wake.attempt, wake.afterTurn)) === item.data.id) {
            carried.set(wake.reportId, Math.max(carried.get(wake.reportId) ?? 0, wake.attempt))
          }
        }
      }
      if (interrupted) continue
      if (item.type === 'tool/call' && ['orchestrator_collab_finish', 'orchestrator_collab_review'].includes(item.data.name)) {
        finishCalls.add(item.data.callId)
      }
      if (item.type === 'tool/result' && finishCalls.has(item.data.message.toolCallId) && !item.data.message.isError) {
        const block = item.data.message.content[0]
        const result = block?.type === 'text' && block.text.startsWith('{') ? object(block.text) : undefined
        if (result?.status === 'sent' && typeof result.replyId === 'string' && result.review?.accepted === true
          && typeof result.review.reportId === 'string') sent.add(result.review.reportId)
      }
    }
    // A sibling review needs two independently delivered messages in the same turn.
    if (!inputIds.size || (!interrupted && inputIds.size < 2)) return
    function consumed(reportId: string, relayId: string): number {
      const ids = [relayId, recoveryId(reportId, 1), recoveryId(reportId, 2)]
      return Math.max(carried.get(reportId) ?? -1, ids.findLastIndex(id => inputIds.has(sessions.promptedId(id))))
    }
    // A normal turn may consume several ready reports and finish only one. Continue its siblings
    // only upon actual delivery of a consumed report. A turn with no progress cannot requeue itself.
    if (!interrupted && ![...sent].some(reportId => {
      const report = bridge.readReport(reportId)
      return report?.deliveredRelay && consumed(reportId, report.deliveredRelay.id) >= 0
    })) return
    for (const ticket of host.store.tickets.open()) {
      const report = bridge.pendingLocalReview(ticket.id)
      if (!report?.deliveredRelay) continue
      // The original failed turn gets one wake, and a failed first wake gets one more.
      // An unrelated turn or an exhausted second wake gets none.
      const previous = consumed(report.id, report.deliveredRelay.id)
      if (previous < 0 || (interrupted && previous >= 2)) continue
      const attempt = previous + (interrupted ? 1 : 0)
      const afterTurn = interrupted ? undefined : event.data.turn
      host.effects.enqueue('reviewRecovery', recoveryId(report.id, attempt, afterTurn),
        { ticketId: ticket.id, reportId: report.id, attempt, ...(afterTurn === undefined ? {} : { afterTurn }) },
        interrupted ? 2000 * attempt : 0)
    }
  })
}
