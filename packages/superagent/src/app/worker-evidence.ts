import { isDeepStrictEqual } from 'node:util'
import type { Ticket, Trigger } from '../core/index.ts'
import type { SessionHistoryEvent } from './session-events.ts'
import { localAppendTarget } from './local-tasks.ts'

export interface ObservationIdentity { callId: string; tool: string; sessionId: string; resultSeq: number }
type Lookup = (identity: ObservationIdentity) => { ref: string } | undefined
export interface ReviewMetricSpec { source: string; fields: readonly string[] }
type ObjectValue = Record<string, unknown>
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value)
const parse = (value: string): unknown => { try { return JSON.parse(value) } catch { return undefined } }
const MAX_OBSERVATIONS = 6, MAX_JSON_BYTES = 64 * 1024
const MAX_CHECKS = 8, MAX_WRITTEN_PATH_CHARS = 160
const EXCERPT_CHARS = 320, COMPLETE_LOCAL_REQUEST_CHARS = 1024
const VERIFIED_REQUEST_CHARS = 2048
const scalarFields = ['passed', 'failed', 'success', 'ok', 'written', 'checks', 'score', 'maxScore', 'revision', 'exitCode', 'exit_code']
const pointer = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1')

// Report pointers are assertions to look for in a tool's own JSON output. Never derive a passing
// state from the report, or claim that matching values establish the correctness of an operation.
function comparedFields(summary: string) {
  const result = summary.length <= 20000 ? parse(summary) : null
  return object(result) ? Object.entries(result).filter(([key, value]) =>
    key.length <= 64 && object(value) && Object.keys(value).length >= 2 && JSON.stringify(value).length <= 300).slice(0, 6) : []
}

function checkOutcomes(value: unknown) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_CHECKS) return
  const seen = new Set<string>()
  const checks: { id: string; passed: boolean }[] = []
  for (const check of value) {
    if (!object(check) || typeof check.id !== 'string' || !/^[\p{L}\p{N}_.-]{1,64}$/u.test(check.id)
      || typeof check.passed !== 'boolean' || seen.has(check.id)) return
    seen.add(check.id)
    checks.push({ id: check.id, passed: check.passed })
  }
  return checks
}

/** Only show a short, lexical relative pathname. The receipt does not authorize a filesystem read. */
function reportedWrittenPath(receipt: ObjectValue) {
  const path = receipt.path
  if (receipt.written !== true || typeof path !== 'string' || !path.length || path.length > MAX_WRITTEN_PATH_CHARS) return
  const segments = path.split(/[\\/]/u)
  return segments.every(segment => /^[\p{L}\p{N}_][\p{L}\p{N}_.-]*$/u.test(segment)
    && !/^(?:private|secrets?|credentials?)(?:\.|$)|\.(?:key|pem|pfx|p12)$/iu.test(segment)) ? path : undefined
}

function projectedMetrics(value: ObjectValue, checks: ReturnType<typeof checkOutcomes>, spec?: ReviewMetricSpec) {
  if (!spec || value.passed !== true || !checks?.length || !checks.every(check => check.passed)) return
  const source = value[spec.source]
  if (!object(source)) return
  const values: Record<string, number> = Object.create(null)
  for (const key of spec.fields) {
    const number = source[key]
    if (!Object.hasOwn(source, key) || typeof number !== 'number' || !Number.isFinite(number)
      || Math.abs(number) > Number.MAX_SAFE_INTEGER) return
    values[key] = number
  }
  return { resultPointer: '/' + pointer(spec.source), values }
}

function resultFacts(text: string, compared: [string, unknown][], metricSpec?: ReviewMetricSpec) {
  const value = Buffer.byteLength(text) <= MAX_JSON_BYTES ? parse(text) : null
  if (!object(value)) return {}
  const fields: Record<string, boolean | number> = {}
  for (const key of scalarFields) {
    const actual = value[key]
    if (typeof actual === 'boolean' || (typeof actual === 'number' && Number.isSafeInteger(actual))) fields[key] = actual
  }
  const arrays: Record<string, number> = Object.create(null)
  const matches: { reportField: string; resultPointer: string }[] = []
  for (const [key, entries] of Object.entries(value)) {
    if (!/^[\w-]{1,40}$/.test(key)) continue
    if (object(entries) && matches.length < 4) {
      const matched = compared.find(([, assertion]) => isDeepStrictEqual(entries, assertion))
      if (matched) matches.push({ reportField: '/' + pointer(matched[0]), resultPointer: '/' + pointer(key) })
    }
    if (!Array.isArray(entries)) continue
    if (Object.keys(arrays).length < 4) arrays[key] = entries.length
    // Tie the exact report object to a concrete row. Limit the scan to modest typed arrays;
    // larger or non-JSON results remain available for a scoped read.
    if (entries.length > 512 || matches.length >= 4) continue
    for (const [reportKey, expected] of compared) {
      const index = entries.findIndex(entry => isDeepStrictEqual(entry, expected))
      if (index >= 0) matches.push({ reportField: '/' + pointer(reportKey), resultPointer: '/' + pointer(key) + '/' + index })
      if (matches.length >= 4) break
    }
  }
  const checks = checkOutcomes(value.checks)
  const metrics = projectedMetrics(value, checks, metricSpec)
  const writtenPath = reportedWrittenPath(value)
  return { ...(Object.keys(fields).length ? { returned: fields } : {}),
    ...(Object.keys(arrays).length ? { arrayLengths: arrays } : {}), ...(matches.length ? { matches } : {}),
    ...(checks ? { checks } : {}), ...(metrics ? { metrics } : {}), ...(writtenPath ? { writtenPath } : {}) }
}

function instructionExcerpt(read: string, text: string, completeLimit = EXCERPT_CHARS) {
  const chars = Array.from(text)
  return chars.length <= completeLimit ? { read, text } : { read, excerpt: chars.slice(0, EXCERPT_CHARS).join(''), totalChars: chars.length }
}

export function instructionExcerpts(ticket: Ticket, sources: Trigger[], sectionPreamble?: string,
  replyFormat?: 'json' | 'text', verifiedMetrics = false, verifiedReady = false) {
  const origin = sources.find(item => item.id === ticket.origin.triggerId && item.human && item.source === 'local')
  if (!origin) return []
  const recent: { read: string; text: string; ticketContext?: true; index: number; completeLimit?: number }[] = []
  const context: typeof recent = []
  const seen = new Set([origin.id])
  for (let index = ticket.inputs.length - 1; index >= 0 && recent.length < 3; index--) {
    const input = ticket.inputs[index]!
    if (input.kind === 'trigger') {
      const source = sources.find(item => item.id === input.triggerId && item.human && item.source === 'local')
      if (!source || input.context || seen.has(source.id)) continue
      seen.add(source.id)
      // A trusted current ready packet and an authenticated serial append belong to
      // the same input version. Give the reviewer that exact bounded instruction once.
      const currentSerial = recent.length === 0 && verifiedReady && replyFormat === 'text' &&
        typeof source.meta.localAppendAfterReplyId === 'string' && source.meta.localAppendAfterReplyId.length > 0 &&
        localAppendTarget(source) === ticket.id && Buffer.byteLength(source.text) <= 4096
      recent.push({ index, read: 'trigger/' + source.id, text: source.text,
        ...(currentSerial ? { completeLimit: VERIFIED_REQUEST_CHARS } : {}) })
    }
    if (context.length < 3 && (input.kind === 'text' || (input.kind === 'note' && !input.reviewOf && !input.submissionFor))) {
      context.push({ index, read: `ticket/${ticket.id}/input/${input.id}`, text: input.text, ticketContext: true })
    }
  }
  // Keep human updates ahead of housekeeping when choosing the bounded set, then restore input order.
  const updates = [...recent, ...context.slice(0, 3 - recent.length)].sort((a, b) => a.index - b.index)
    .map(item => ({ ...instructionExcerpt(item.read, item.text, item.completeLimit), ...(item.ticketContext ? { ticketContext: true } : {}) }))
  const originCovered = !!sectionPreamble?.trim() && origin.text.startsWith(sectionPreamble)
  if (originCovered) return updates
  // Report/submission reminders do not change the task. Keep the expansion for single-source prose only.
  const singleRequest = replyFormat === 'text' && origin.meta.outputFormat !== 'json' && sources.length === 1
    && ticket.origin.triggerIds.every(id => id === origin.id)
    && ticket.inputs.every(input => (input.kind === 'trigger' && input.triggerId === origin.id && !input.context)
      || (input.kind === 'note' && (input.reviewOf || input.submissionFor)))
  const limit = singleRequest ? verifiedMetrics ? VERIFIED_REQUEST_CHARS : COMPLETE_LOCAL_REQUEST_CHARS : EXCERPT_CHARS
  return [instructionExcerpt('trigger/' + origin.id, origin.text, limit), ...updates]
}

export function workerEvidence(inputVersion: string, sessionId: string,
  events: readonly SessionHistoryEvent[], summary: string, lookup: Lookup,
  metricsFor?: (identity: ObservationIdentity) => ReviewMetricSpec | undefined) {
  // The digest includes ticket and assignment IDs. Trust the host source and message ID, never a
  // marker string in message content. If the applicable marker is unavailable, use normal review.
  const start = events.findLastIndex(event => {
    if (event.type !== 'user/message' || !object(event.data) || !object(event.data.source)) return false
    return event.data.source.kind === 'dsh-collab' && event.data.source.form === 'input-reference'
  })
  const marker = events[start]?.data
  if (!object(marker) || typeof marker.id !== 'string' || !marker.id.startsWith('native-input:') || !marker.id.endsWith(':' + inputVersion)) return
  const calls = new Map<string, { tool: string; seq: number; turn: number; step: number }>()
  const results: { identity: ObservationIdentity; callSeq: number; text: string }[] = []
  let errors = 0
  for (let i = start + 1; i < events.length; i++) {
    const event = events[i]!, data = event.data
    if (!object(data) || typeof data.turn !== 'number' || typeof data.step !== 'number') continue
    if (event.type === 'tool/call' && typeof data.callId === 'string' && typeof data.name === 'string'
      && !data.name.startsWith('orchestrator_') && !data.name.startsWith('collab_')) {
      calls.set(data.callId, { tool: data.name, seq: event.seq, turn: data.turn, step: data.step })
    }
    if (event.type !== 'tool/result' || !object(data.message)) continue
    const message = data.message
    if (message.role !== 'tool' || typeof message.toolCallId !== 'string') continue
    const call = calls.get(message.toolCallId)
    if (!call || call.seq >= event.seq || call.turn !== data.turn || call.step !== data.step) continue
    calls.delete(message.toolCallId)
    if (message.isError === true) { errors++; continue }
    if (message.isError !== false || !Array.isArray(message.content) || message.content.length !== 1) continue
    const block = message.content[0]
    if (!object(block) || block.type !== 'text' || typeof block.text !== 'string') continue
    results.push({ identity: { callId: message.toolCallId, tool: call.tool, sessionId, resultSeq: event.seq }, callSeq: call.seq, text: block.text })
  }
  const compared = comparedFields(summary)
  const observed = []
  for (const result of results.slice(-MAX_OBSERVATIONS)) {
    const ref = lookup(result.identity)?.ref
    if (!ref) continue
    observed.push({ tool: result.identity.tool, callSeq: result.callSeq, resultSeq: result.identity.resultSeq, ref,
      ...resultFacts(result.text, compared, metricsFor?.(result.identity)) })
  }
  if (!observed.length) return
  return { inputVersion, observed,
    unlistedTextResults: results.length - observed.length, toolErrors: errors }
}
