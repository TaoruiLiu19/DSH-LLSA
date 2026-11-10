/** Correlates durable tool results with earlier call events in the same Session.
 * A missing/ambiguous name stays unknown, never a guessed generic tool name.
 */
const natural = value => Number.isSafeInteger(value) && value >= 0;
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const unknown = (callId, reason) => ({ name: null, callId: callId ?? null, source: 'unknown', reason });

export class ToolEventIndex {
  #sessions = new WeakMap();

  #state(session) {
    if (!session || typeof session !== 'object') return null;
    let state = this.#sessions.get(session);
    if (!state) { state = { calls: new Map(), hydrated: false }; this.#sessions.set(session, state); }
    return state;
  }

  /** Feed the same session/event pair received by the runtime event listener. */
  observe(session, event) {
    if (event?.type !== 'tool/call' || !natural(event.seq)) return;
    const { callId, name, turn, step } = event.data ?? {};
    if (!nonempty(callId) || !nonempty(name)) return;
    const state = this.#state(session);
    if (!state) return;
    let calls = state.calls.get(callId);
    if (!calls) { calls = new Map(); state.calls.set(callId, calls); }
    // Replaying an immutable event is idempotent; a conflicting replay is unknown.
    const previous = calls.get(event.seq);
    calls.set(event.seq, { seq: event.seq, name, turn, step,
      conflict: !!previous && (previous.conflict || previous.name !== name || previous.turn !== turn || previous.step !== step) });
  }

  /** Can prime from persisted events without relying on a live Session reader. */
  prime(session, events) {
    if (!Array.isArray(events)) return;
    for (const event of events) this.observe(session, event);
  }

  resolve(session, resultEvent) {
    if (resultEvent?.type !== 'tool/result') return unknown(null, 'NOT_TOOL_RESULT');
    const data = resultEvent.data ?? {};
    const callId = data.message?.toolCallId ?? data.toolCallId ?? data.callId;
    if (!nonempty(callId)) return unknown(null, 'MISSING_CALL_ID');
    if ([data.callId, data.toolCallId, data.message?.toolCallId].some(id => id !== undefined && id !== callId)) {
      return unknown(callId, 'CALL_ID_CONFLICT');
    }
    if (!natural(resultEvent.seq)) return unknown(callId, 'MISSING_SEQUENCE');
    const state = this.#state(session);
    if (!state) return unknown(callId, 'MISSING_SESSION');

    // Recovery after plugin/session activation: only call metadata enters the index.
    // Snapshot recovery is lazy; hosts with persisted readers can use prime() instead.
    let historyUnavailable = false;
    if (!state.hydrated) {
      try { this.prime(session, session.snapshotEvents?.()); state.hydrated = true; }
      catch { historyUnavailable = true; }
    }
    const candidates = [...(state.calls.get(callId)?.values() ?? [])].filter(call => call.seq < resultEvent.seq
      && (!natural(data.turn) || !natural(call.turn) || data.turn === call.turn)
      && (!natural(data.step) || !natural(call.step) || data.step === call.step));
    if (!candidates.length) return unknown(callId, historyUnavailable ? 'HISTORY_UNAVAILABLE' : 'NO_EARLIER_MATCHING_CALL');
    if (candidates.some(call => call.conflict) || new Set(candidates.map(call => call.name)).size !== 1) {
      return unknown(callId, 'AMBIGUOUS_CALL');
    }
    const call = candidates.reduce((latest, current) => current.seq > latest.seq ? current : latest);
    return { name: call.name, callId, source: 'session_tool_call', callSeq: call.seq, reason: null };
  }
}
