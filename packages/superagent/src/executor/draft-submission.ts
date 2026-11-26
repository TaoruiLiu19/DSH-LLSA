import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Ticket } from '../core/index.ts'

export interface DraftSubmission { inputVersion: string; reminderId?: string; verifiedWork?: true; startupWork?: true }

type ToolCall = Extract<SessionEvent, { type: 'tool/call' }>
type ToolResult = Extract<SessionEvent, { type: 'tool/result' }>

/** Only parse structured output from a real call and its corresponding host result. */
function resultObject(call: ToolCall, result: ToolResult): Record<string, unknown> | undefined {
  if (result.seq <= call.seq || result.data.turn !== call.data.turn || result.data.step !== call.data.step) return
  const message = result.data.message
  if (message.role !== 'tool' || message.isError !== false || message.toolCallId !== call.data.callId || message.content.length !== 1) return
  const block = message.content[0]
  if (block?.type !== 'text' || block.text.length > 16_384) return
  try {
    const value: unknown = JSON.parse(block.text)
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch { return }
}

/** An edit receipt must precede the latest tool operation, which must report explicit check outcomes. */
function editCheckOutcome(turn: readonly SessionEvent[]): boolean | undefined {
  const lastCall = turn.findLast(event => event.type === 'tool/call')
  const lastResult = turn.findLast(event => event.type === 'tool/result')
  if (!lastCall || !lastResult) return
  const checked = resultObject(lastCall, lastResult)
  if (typeof checked?.passed !== 'boolean' || !Array.isArray(checked.checks) || !checked.checks.length || !checked.checks.every((check: unknown) =>
    check !== null && typeof check === 'object' && 'id' in check && typeof check.id === 'string' && check.id.length > 0
    && 'passed' in check && typeof check.passed === 'boolean')) return
  if (checked.passed !== checked.checks.every(check => check.passed)) return
  const precedingCalls = new Map<string, ToolCall>()
  for (const event of turn) {
    if (event === lastCall) return
    if (event.type === 'tool/call') precedingCalls.set(event.data.callId, event)
    else if (event.type === 'tool/result') {
      const call = precedingCalls.get(event.data.message.toolCallId)
      if (call && resultObject(call, event)?.written === true) return checked.passed
    }
  }
}

function jsonDraft(text: string): boolean {
  if (!text.startsWith('{') && !text.startsWith('[')) return false
  try { JSON.parse(text); return true } catch { return false }
}

function currentInputMarker(history: readonly SessionEvent[]) {
  return history.findLast(event => {
    if (event.type !== 'user/message') return false
    const source: { kind: string; form?: string } = event.data.source
    return source.kind === 'dsh-collab' && source.form === 'input-reference'
  })
}

/** A declared artifact task requires an explicit tool report. One quiet turn can request a native reminder. */
export function artifactQuietDraft(history: readonly SessionEvent[], ticket: Ticket, assignmentId: string,
  receipt: (id: string) => string): DraftSubmission | undefined {
  const start = history.findLastIndex(event => event.type === 'turn/start')
  if (start < 0) return
  const turn = history.slice(start + 1)
  const ended = turn.findLast(event => event.type === 'turn/end')
  if (ended?.data.reason.kind !== 'completed' || turn.some(event => event.type === 'user/message' && event.data.source.kind === 'user')) return
  const mark = currentInputMarker(history)
  const prefix = `native-input:super-${ticket.id}-${assignmentId}:`
  if (mark?.type !== 'user/message' || !mark.data.id.startsWith(prefix)) return
  const inputVersion = mark.data.id.slice(prefix.length)
  if (!/^[a-f0-9]{64}$/u.test(inputVersion)) return
  const consumed = new Set<string>(turn.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'dsh-superagent' ? [event.data.id] : []))
  const reminder = ticket.inputs.findLast(input => input.kind === 'note' && input.submissionFor?.startupWork &&
    input.submissionFor.assignmentId === assignmentId && input.submissionFor.inputVersion === inputVersion && consumed.has(receipt(input.id)))
  return { inputVersion, startupWork: true, ...(reminder ? { reminderId: reminder.id } : {}) }
}

/** Find a current edit check for the next already-planned worker step. */
export function checkedEditTurn(history: readonly SessionEvent[]): { turnSeq: number; inputVersion: string; passed: boolean } | undefined {
  const start = history.findLastIndex(event => event.type === 'turn/start' || event.type === 'turn/end')
  const boundary = history[start]
  if (boundary?.type !== 'turn/start') return
  const mark = currentInputMarker(history)
  if (mark?.type !== 'user/message') return
  const inputVersion = /^native-input:[^:]+:([a-f0-9]{64})$/.exec(mark.data.id)?.[1]
  if (!inputVersion) return
  const turn = history.slice(start + 1).filter(event => event.seq > mark.seq)
  if (turn.some(event => event.type === 'user/message' && event.data.source.kind === 'user')) return
  const passed = editCheckOutcome(turn)
  if (passed !== undefined) return { turnSeq: boundary.seq, inputVersion, passed }
}

/** Observe a native worker turn. Its assistant text establishes eligibility for a reminder, never a report or answer. */
export function draftSubmission(history: readonly SessionEvent[], ticket: Ticket, assignmentId: string, receipt: (id: string) => string): DraftSubmission | undefined {
  const start = history.findLastIndex(event => event.type === 'turn/start')
  if (start < 0) return
  const turn = history.slice(start + 1)
  const ended = turn.findLast(event => event.type === 'turn/end')
  if (ended?.data.reason.kind !== 'completed') return
  const messages = turn.filter(event => event.type === 'user/message')
  if (messages.some(event => event.data.source.kind === 'user')) return
  const consumed = new Set<string>(messages.filter(event => event.data.source.kind === 'dsh-superagent').map(event => event.data.id))
  const reminder = ticket.inputs.findLast(input => input.kind === 'note' && input.submissionFor?.assignmentId === assignmentId
    && !input.submissionFor.startupWork && consumed.has(receipt(input.id)))
  if (reminder?.kind === 'note' && reminder.submissionFor) return { inputVersion: reminder.submissionFor.inputVersion,
    reminderId: reminder.id, ...(reminder.submissionFor.verifiedWork ? { verifiedWork: true } : {}) }
  if (!consumed.has(receipt(`assignment:${ticket.id}`)) && !consumed.has(receipt(`assignment:${ticket.id}:${assignmentId}`))
    && !ticket.inputs.some(input => input.kind === 'trigger' && !input.context && consumed.has(receipt(input.id)))) return
  const last = turn.findLast(event => event.type === 'assistant/message')
  const blocks = last?.data.message.content
  if (!blocks || blocks.some(block => block.type === 'tool-call')) return
  const draft = blocks.filter(block => block.type === 'text').map(block => block.text).join('').trim()
  if (!draft) return
  const verifiedWork = !jsonDraft(draft)
  const mark = currentInputMarker(history)
  const inputVersion = mark?.type === 'user/message' && /^native-input:[^:]+:([a-f0-9]{64})$/.exec(mark.data.id)?.[1]
  if (verifiedWork && (!mark || editCheckOutcome(turn.filter(event => event.seq > mark.seq)) !== true)) return
  return inputVersion ? { inputVersion, ...(verifiedWork ? { verifiedWork: true } : {}) } : undefined
}
