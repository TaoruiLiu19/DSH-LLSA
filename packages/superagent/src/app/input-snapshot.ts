import { createHash } from 'node:crypto'
import type { Ticket, Trigger } from '../core/index.ts'
import { browserAdviceOf } from './local-tasks.ts'

/** Only task semantics participate in the version; delivery cursors are transport state. */
export function captureTaskInput(ticket: Ticket, readTrigger: (id: string) => Trigger | undefined) {
  const inputs = ticket.inputs.map(input => {
    if (input.kind !== 'trigger') return { ...input }
    const { readAt: _read, deliveredAt: _at, deliveredTo: _to, ...semantic } = input
    return semantic
  })
  const ids = [...new Set([ticket.origin.triggerId, ...ticket.origin.triggerIds,
    ...inputs.flatMap(input => 'triggerId' in input ? [input.triggerId] : [])])]
  const ownedSources = new Set([ticket.origin.triggerId, ...ticket.origin.triggerIds,
    ...inputs.flatMap(input => input.kind === 'trigger' && !input.context ? [input.triggerId] : [])])
  const sources = ids.map(id => {
    const source = readTrigger(id)
    if (!source) throw new Error(`Cannot snapshot missing task source: trigger/${id}`)
    if (source.source !== 'local' || (!Object.hasOwn(source.meta, 'browserAdvice') &&
        !Object.hasOwn(source.meta, 'webConsultationEnabled'))) return source
    // Advice is read through its scoped resource. Preserve its version without carrying its text as a task source.
    const { browserAdvice: _advice, webConsultationEnabled, ...meta } = source.meta
    const advice = ownedSources.has(id) ? browserAdviceOf(source) : undefined
    return { ...source, meta: { ...meta,
      ...(id === ticket.origin.triggerId && webConsultationEnabled === true ? { webConsultationEnabled: true } : {}),
      ...(advice ? { browserAdviceSha256: createHash('sha256').update(advice.text).digest('hex') } : {}),
    } }
  })
  const content = JSON.parse(JSON.stringify({ schema: 1, ticketId: ticket.id,
    assignmentId: ticket.assignments.at(-1)?.id ?? null, origin: ticket.origin,
    mandate: ticket.mandate ?? null, execution: ticket.execution ?? null, inputs, sources }))
  // Canonical keys prevent object insertion order from creating a new semantic version.
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]))
      : value
  const text = JSON.stringify(canonical(content))
  return { version: createHash('sha256').update(text).digest('hex'), content: JSON.parse(text), text }
}
