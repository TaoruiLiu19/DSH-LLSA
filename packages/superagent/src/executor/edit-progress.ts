import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Ticket } from '../core/index.ts'

type ToolCall = Extract<SessionEvent, { type: 'tool/call' }>
type ToolResult = Extract<SessionEvent, { type: 'tool/result' }>
type Receipt = Record<string, unknown>

export interface EditProgressHint {
  turnSeq: number
  inputVersion: string
  kind: 'RepeatedCheck' | 'RepeatedRead'
}

function matchesToolResult(call: ToolCall, result: ToolResult): boolean {
  return result.seq > call.seq && result.data.turn === call.data.turn && result.data.step === call.data.step
    && result.data.message.role === 'tool' && result.data.message.toolCallId === call.data.callId
}

function toolReceipt(call: ToolCall, result: ToolResult): Receipt | undefined {
  if (!matchesToolResult(call, result)) return
  const message = result.data.message
  if (message.isError !== false || message.content.length !== 1) return
  const block = message.content[0]
  if (block?.type !== 'text' || block.text.length > 16_384) return
  try {
    const value: unknown = JSON.parse(block.text)
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Receipt
  } catch { return }
}

/** Compare stable result fields only. Diagnostics and timings can vary without an edit. */
function checkReport(receipt: Receipt): { passed: boolean; outcomes: Map<string, boolean> } | undefined {
  if (typeof receipt.passed !== 'boolean' || !Array.isArray(receipt.checks) || receipt.checks.length === 0 || receipt.checks.length > 128) return
  const outcomes = new Map<string, boolean>()
  for (const check of receipt.checks as unknown[]) {
    if (check === null || typeof check !== 'object' || !('id' in check) || typeof check.id !== 'string'
      || check.id.length === 0 || check.id.length > 256 || outcomes.has(check.id)
      || !('passed' in check) || typeof check.passed !== 'boolean') return
    outcomes.set(check.id, check.passed)
  }
  if ([...outcomes.values()].every(Boolean) !== receipt.passed) return
  return { passed: receipt.passed, outcomes }
}

function failingChecks(receipt: Receipt): string | undefined {
  const report = checkReport(receipt)
  if (report?.passed !== false) return
  return JSON.stringify([...report.outcomes].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
}

function readSpan(receipt: Receipt): { key: string; lines?: string } | undefined {
  if (typeof receipt.path !== 'string' || receipt.path.length === 0 || typeof receipt.start !== 'number'
    || !Number.isSafeInteger(receipt.start) || receipt.start < 1) return
  if (typeof receipt.lines === 'string' && receipt.lines.length > 0) {
    const end = receipt.start + receipt.lines.split('\n').length - 1
    if (!Number.isSafeInteger(end)) return
    return { key: JSON.stringify([receipt.path, receipt.start, end]), lines: receipt.lines }
  }
  if (receipt.status === 'repeated_read' && receipt.unchanged === true && typeof receipt.end === 'number'
    && Number.isSafeInteger(receipt.end) && receipt.end >= receipt.start) {
    return { key: JSON.stringify([receipt.path, receipt.start, receipt.end]) }
  }
}

function taskVersion(history: readonly SessionEvent[]): { markerAt: number; inputVersion: string } | undefined {
  const markerAt = history.findLastIndex(event => {
    if (event.type !== 'user/message') return false
    const source: { kind: string; form?: string } = event.data.source
    return source.kind === 'dsh-collab' && source.form === 'input-reference'
  })
  const marker = history[markerAt]
  const inputVersion = marker?.type === 'user/message' && /^native-input:[^:]+:([a-f0-9]{64})$/.exec(marker.data.id)?.[1]
  if (inputVersion) return { markerAt, inputVersion }
}

/** Observe an open turn in the current task version; never schedule a new turn or infer a successful edit. */
export function editProgressHint(history: readonly SessionEvent[]): EditProgressHint | undefined {
  const turnAt = history.findLastIndex(event => event.type === 'turn/start' || event.type === 'turn/end')
  const turn = history[turnAt]
  if (turn?.type !== 'turn/start') return
  const version = taskVersion(history)
  if (!version) return
  const { markerAt, inputVersion } = version

  const scopeAt = Math.max(turnAt, markerAt)
  const scopeSeq = history[scopeAt]!.seq
  const latestCallAt = history.findLastIndex(event => event.type === 'tool/call')
  const latestCall = history[latestCallAt]
  const latestResult = history.findLast(event => event.type === 'tool/result')
  if (latestCallAt <= scopeAt || latestCall?.type !== 'tool/call' || latestCall.data.turn !== turn.data.turn || !latestResult) return
  const latest = toolReceipt(latestCall, latestResult)
  if (!latest || latest.written === true) return
  const failedSignature = failingChecks(latest)
  const latestRead = failedSignature === undefined ? readSpan(latest) : undefined
  if (failedSignature === undefined && latestRead === undefined) return

  const calls = new Map<string, ToolCall>()
  let repeated = false
  for (let index = markerAt + 1; index < history.length; index++) {
    const event = history[index]!
    if (index > turnAt && event.type === 'user/message' && event.data.source.kind === 'user') return
    if (event.type === 'tool/call') calls.set(event.data.callId, event)
    if (event.type !== 'tool/result') continue
    const id = event.data.message.toolCallId
    const call = calls.get(id)
    if (!call) continue
    const receipt = toolReceipt(call, event)
    if (!receipt) continue
    calls.delete(id)
    if (receipt.written === true) return
    if (index <= scopeAt || call.seq <= scopeSeq || id === latestCall.data.callId || call.data.turn !== turn.data.turn
      || call.data.name !== latestCall.data.name) continue
    if (failedSignature !== undefined) {
      if (call.data.arguments === latestCall.data.arguments) repeated = failingChecks(receipt) === failedSignature
    } else if (!repeated && latestRead !== undefined) {
      const previousRead = readSpan(receipt)
      repeated = previousRead?.key === latestRead.key && previousRead.lines !== undefined
        && (latestRead.lines === undefined || previousRead.lines === latestRead.lines)
    }
  }
  if (repeated) return { turnSeq: turn.seq, inputVersion, kind: failedSignature === undefined ? 'RepeatedRead' : 'RepeatedCheck' }
}

function scopedSourceRead(receipt: Receipt): boolean {
  if (typeof receipt.path !== 'string' || /[:\u0000]/.test(receipt.path)) return false
  const parts = receipt.path.replaceAll('\\', '/').split('/')
  return parts.every(part => part !== '' && part !== '..')
    && (readSpan(receipt)?.lines !== undefined || (receipt.status === 'source_search_miss' && receipt.found === false))
}

/** Detect a terminal workspace draft that still needs its first edit or a valid passing check. */
export function unfinishedEditDraft(history: readonly SessionEvent[], ticket: Ticket, assignmentId: string,
  receipt: (id: string) => string): { inputVersion: string; startupWork: true; reminderId?: string } | undefined {
  const endAt = history.findLastIndex(event => event.type === 'turn/start' || event.type === 'turn/end')
  const end = history[endAt]
  if (end?.type !== 'turn/end' || end.data.reason.kind !== 'completed') return
  const startAt = history.slice(0, endAt).findLastIndex(event => event.type === 'turn/start' || event.type === 'turn/end')
  const start = history[startAt]
  if (start?.type !== 'turn/start' || start.data.turn !== end.data.turn) return
  const version = taskVersion(history)
  if (!version || version.markerAt >= endAt) return
  const { markerAt, inputVersion } = version

  const turn = history.slice(startAt + 1, endAt)
  const input = turn.filter(event => event.type === 'user/message')
  if (history.findLastIndex(event => event.type === 'user/message' && event.data.source.kind === 'user') > startAt) return
  const last = turn.findLast(event => event.type === 'assistant/message')
  if (last?.data.turn !== end.data.turn) return
  const blocks = last.data.message.content
  if (blocks.some(block => block.type === 'tool-call')) return
  const prose = blocks.filter(block => block.type === 'text').map(block => block.text).join('').trim()
  if (!prose || prose.startsWith('{') || prose.startsWith('[')) return

  const consumed = new Set<string>(input.filter(event => event.data.source.kind === 'dsh-superagent').map(event => event.data.id))
  const reminder = ticket.inputs.findLast(item => item.kind === 'note' && item.submissionFor?.startupWork === true
    && item.submissionFor.assignmentId === assignmentId && item.submissionFor.inputVersion === inputVersion && consumed.has(receipt(item.id)))
  if (!reminder && !consumed.has(receipt(`assignment:${ticket.id}`)) && !consumed.has(receipt(`assignment:${ticket.id}:${assignmentId}`))
    && !ticket.inputs.some(item => item.kind === 'trigger' && !item.context && consumed.has(receipt(item.id)))) return

  const calls = new Map<string, { call: ToolCall; index: number }>()
  let investigated = false
  let wrote = false
  let passed = false
  for (let index = Math.min(startAt, markerAt) + 1; index < endAt; index++) {
    const event = history[index]!
    if (event.seq > last.seq && (event.type === 'tool/call' || event.type === 'tool/result')) return
    if (event.type === 'tool/call') calls.set(event.data.callId, { call: event, index })
    if (event.type !== 'tool/result') continue
    const id = event.data.message.toolCallId
    const pending = calls.get(id)
    if (!pending || !matchesToolResult(pending.call, event)) continue
    calls.delete(id)
    if (pending.index <= markerAt) continue
    const data = toolReceipt(pending.call, event)
    if (!data) continue
    if (data.written === true) {
      wrote = true
      passed = false
      continue
    }
    const check = checkReport(data)
    if (check) passed = check.passed
    if (pending.index > startAt && pending.call.data.turn === end.data.turn && last.seq > event.seq
      && (check?.passed === false || scopedSourceRead(data))) investigated = true
  }
  if (passed || [...calls.values()].some(pending => pending.index > startAt)) return
  if (reminder || wrote || investigated) return { inputVersion, startupWork: true, ...(reminder ? { reminderId: reminder.id } : {}) }
}
