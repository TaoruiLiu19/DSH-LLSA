/** Read a complete, stable history snapshot from the Harness session API. */
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'

/** Wire events are extensible; preserve unfamiliar events without pretending they are a known union member. */
export interface SessionHistoryEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

interface HistoryController {
  inspect?: (id: SessionId) => Promise<{ events: readonly SessionEvent[] }>
  events?: (request: {
    address: { kind: 'session'; sessionId: SessionId }
    throughSeq?: number
    beforeSeq?: number
    maxMessages: number
  }, signal: AbortSignal) => Promise<{
    cursor: number
    hasMore: boolean
    records: readonly { type: 'event'; event: SessionHistoryEvent }[]
  }>
}

export async function readSessionEvents(controller: HistoryController, id: SessionId, signal: AbortSignal): Promise<readonly SessionHistoryEvent[]> {
  signal.throwIfAborted()
  if (!controller.events) {
    if (!controller.inspect) throw new Error('Session history API unavailable')
    return (await controller.inspect(id)).events
  }
  const pages: SessionHistoryEvent[][] = []
  let throughSeq: number | undefined
  let beforeSeq: number | undefined
  for (let pageIndex = 0; pageIndex < 1000; pageIndex++) {
    signal.throwIfAborted()
    const page = await controller.events({
      address: { kind: 'session', sessionId: id },
      ...(throughSeq === undefined ? {} : { throughSeq }),
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
      maxMessages: 100,
    }, signal)
    throughSeq ??= page.cursor
    const events = page.records.map(row => row.event)
    pages.push(events)
    if (!page.hasMore) return pages.reverse().flat()
    const first = events[0]?.seq
    if (first === undefined || !Number.isSafeInteger(first) || first < 0 || (beforeSeq !== undefined && first >= beforeSeq)) {
      throw new Error('Session history cursor did not advance')
    }
    beforeSeq = first
  }
  throw new Error('Session history page limit exceeded; refusing incomplete history')
}
