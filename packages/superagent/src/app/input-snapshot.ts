import { createHash } from 'node:crypto'
import type { Ticket, Trigger } from '../core/index.ts'

/** Only task semantics participate in the version; delivery cursors are transport state. */
export function captureTaskInput(ticket: Ticket, readTrigger: (id: string) => Trigger | undefined) {
  const inputs = ticket.inputs.map(input => {
    if (input.kind !== 'trigger') return { ...input }
    const { readAt: _read, deliveredAt: _at, deliveredTo: _to, ...semantic } = input
    return semantic
  })
  const ids = [...new Set([ticket.origin.triggerId, ...ticket.origin.triggerIds,
    ...inputs.flatMap(input => 'triggerId' in input ? [input.triggerId] : [])])]
  const sources = ids.map(id => {
    const source = readTrigger(id)
    if (!source) throw new Error(`Cannot snapshot missing task source: trigger/${id}`)
    return source
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
