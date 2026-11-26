import { createHash } from 'node:crypto';
import { readTaskEvidence } from './evidence-page.js';

// The entire original tool message stays in the archive. A short reference addresses just
// one successful public text block, never tool arguments, internal metadata, or attachments.
export function publicToolText(message, callId) {
  const blocks = message?.content;
  if (message?.role !== 'tool' || message.toolCallId !== callId || message.isError !== false ||
      !Array.isArray(blocks) || blocks.length !== 1 || blocks[0]?.type !== 'text') return;
  const text = blocks[0].text;
  if (typeof text === 'string' && text.length && text.isWellFormed()) return text;
}

export function eligibleObservation(tool, result, callId, identity, binding, version) {
  return !binding.parentId && typeof version === 'string' && typeof tool === 'string' &&
    !/^(?:collab_|orchestrator_|ask_user_question$)/u.test(tool) &&
    identity?.source === 'session_tool_call' && identity.name === tool && identity.callId === callId &&
    Number.isSafeInteger(identity.callSeq) && Number.isSafeInteger(identity.resultSeq) && identity.resultSeq > identity.callSeq &&
    identity.scope?.runId === binding.runId && identity.scope.inputVersion === version &&
    publicToolText(result, callId) !== undefined;
}

function handle(event) {
  const tag = createHash('sha256').update(JSON.stringify([event.runId, event.id])).digest('hex').slice(0, 16);
  return `obs:${event.runSeq.toString(36)}-${tag}`;
}

// Issued handles locate an event. The usual caller, assignment and input-version checks still authorize the read.
export function issuedObservationRun(manager, ref) {
  if (!/^obs:[1-9a-z][0-9a-z]{0,10}-[0-9a-f]{16}$/u.test(ref)) return;
  const rows = manager.store.db.prepare(`SELECT events.run_id FROM tool_observation_refs refs
    JOIN events ON events.id=refs.event_id WHERE refs.ref=? LIMIT 2`).all(ref);
  if (rows.length === 1 && typeof rows[0].run_id === 'string') return rows[0].run_id;
}

// Only content-addressed document envelopes qualify for automatic historical recall.
// Operation reports and arbitrary prose remain in history but are not source-document hints.
function sourceDocument(text) {
  let value;
  try { value = JSON.parse(text); } catch { return; }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['text', 'bytes', 'sha256', 'title', 'label', 'mediaType', 'url'].includes(key)) ||
      typeof value.text !== 'string' || !value.text.isWellFormed() || !Number.isSafeInteger(value.bytes) ||
      value.bytes < 512 || value.bytes > 64000 || Buffer.byteLength(value.text) !== value.bytes ||
      typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256) ||
      createHash('sha256').update(value.text).digest('hex') !== value.sha256) return;
  return { text: value.text, bytes: value.bytes, sha256: value.sha256 };
}

function historicalSource(manager, run, event, budget = undefined) {
  if (!event || event.kind !== 'tool_observation' || event.attemptId !== 'root' ||
      event.payload.provenance !== 'host_tool_result' || event.payload.actorId !== run.rootSessionId ||
      typeof event.payload.observedInputVersion !== 'string' ||
      event.payload.toolIdentity?.source !== 'session_tool_call' ||
      event.payload.toolIdentity?.name !== event.payload.toolName ||
      event.payload.toolIdentity?.callId !== event.payload.toolCallId ||
      !Number.isSafeInteger(event.payload.toolIdentity?.callSeq) ||
      !Number.isSafeInteger(event.payload.toolIdentity?.resultSeq) ||
      event.payload.toolIdentity.resultSeq <= event.payload.toolIdentity.callSeq ||
      event.payload.toolIdentity?.scope?.runId !== run.id ||
      event.payload.toolIdentity?.scope?.inputVersion !== event.payload.observedInputVersion) return;
  const meta = manager.store.getArtifact(event.payload.artifactRef);
  if (meta.bytes > 66000) return;
  if (budget) {
    if (meta.bytes > budget.bytes) return;
    budget.bytes -= meta.bytes;
  }
  const message = JSON.parse(manager.store.readArtifact(meta.id).toString('utf8'));
  const text = publicToolText(message, event.payload.toolCallId);
  return text === undefined ? undefined : sourceDocument(text);
}

/** Bounded, ticket-owned source index. It says what was read, never that it is still applicable. */
export function historicalObservations(manager, ticket, inputVersion) {
  const current = ticket.assignments.at(-1);
  if (!current || typeof inputVersion !== 'string') return [];
  const result = [], seen = new Set(), budget = { bytes: 256000 };
  for (const assignment of ticket.assignments.slice(-16).reverse()) {
    const run = manager.store.getRun(`super-${ticket.id}-${assignment.id}`);
    if (!run || run.ticketId !== ticket.id || run.assignmentId !== assignment.id ||
        run.rootSessionId !== `worker-${ticket.id}`) continue;
    // Use the partial observation index so model/dispatch activity cannot push a prior document out of view.
    const rows = manager.store.db.prepare(`SELECT data FROM events WHERE run_id=?
      AND json_extract(data,'$.kind')='tool_observation' ORDER BY run_seq DESC LIMIT 64`).all(run.id);
    for (const row of rows) {
      const event = JSON.parse(String(row.data));
      if (assignment.id === current.id && event.payload.observedInputVersion === inputVersion) continue;
      let source;
      try { source = historicalSource(manager, run, event, budget); } catch { continue; }
      if (!source || seen.has(source.sha256)) continue;
      seen.add(source.sha256);
      result.push({ ref: handle(event), ticketId: ticket.id, assignmentId: assignment.id,
        inputVersion: event.payload.observedInputVersion, tool: event.payload.toolName,
        sourceSha256: source.sha256, bytes: source.bytes, historical: true, jsonPointer: '/text',
        verificationScope: 'historical_source_not_current_verification' });
      if (result.length === 2) return result;
    }
  }
  return result;
}

function selectText(text, pointer) {
  if (pointer === undefined) return text;
  if (typeof pointer !== 'string' || (pointer && !pointer.startsWith('/')) || /~(?![01])/u.test(pointer)) {
    throw new Error('Invalid JSON Pointer.');
  }
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('Observation is not a JSON document. Omit jsonPointer to read the original.'); }
  for (const key of pointer.split('/').slice(1)) {
    const field = key.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!value || typeof value !== 'object' || (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/u.test(field)) ||
        !Object.hasOwn(value, field)) throw new Error('JSON Pointer does not identify a field in this observation.');
    value = value[field];
  }
  if (typeof value !== 'string' || !value.isWellFormed()) throw new Error('JSON Pointer must identify a UTF-8 text value.');
  return value;
}

/** Only the recorded root worker of the current assignment and the exact call/result pair qualify. */
export function workerObservationRef(manager, ticket, inputVersion, { callId, tool, sessionId, resultSeq }) {
  const assignment = ticket.assignments.at(-1);
  if (!assignment || !callId || !tool || typeof inputVersion !== 'string' || !Number.isSafeInteger(resultSeq)) return;
  const runId = `super-${ticket.id}-${assignment.id}`;
  if (manager.store.getRun(runId)?.rootSessionId !== sessionId || manager.nativeInputs.current(runId)?.version !== inputVersion) return;
  const { events } = manager.store.inspectStep(runId, `tool-${callId}`, { attemptId: 'root' });
  const matched = events.filter(event => event.kind === 'tool_observation' && event.payload.provenance === 'host_tool_result' &&
    event.payload.observedInputVersion === inputVersion && event.payload.actorId === sessionId &&
    event.payload.toolCallId === callId && event.payload.toolName === tool && event.payload.toolIdentity?.resultSeq === resultSeq);
  if (matched.length === 1) {
    const event = matched[0], ref = handle(event);
    manager.store.db.prepare('INSERT OR IGNORE INTO tool_observation_refs(ref,event_id) VALUES (?,?)').run(ref,event.id);
    return { ref };
  }
}

export function readToolObservation(manager, runId, sessionId, args) {
  const unavailable = () => { throw new Error('Observation is unavailable for this session and current input.'); };
  if (args.historical !== undefined && args.historical !== true) return unavailable();
  const match = /^obs:([1-9a-z][0-9a-z]{0,10})-([0-9a-f]{16})$/u.exec(args.ref);
  const seq = match && Number.parseInt(match[1], 36);
  if (!Number.isSafeInteger(seq) || seq < 1) return unavailable();
  const binding = manager.binding(sessionId);
  const run = manager.store.getRun(runId);
  if (!run || !binding || binding.parentId) return unavailable();
  const bridge = manager.bridge?.snapshot(run.ticketId);
  const master = bridge?.masterSessionId === sessionId;
  const historical = args.historical === true;
  if (historical && (!master || args.ticketId !== run.ticketId || args.assignmentId !== run.assignmentId ||
      !bridge.tickets.some(row => row.ticket.id === run.ticketId &&
        row.ticket.assignments.some(assignment => assignment.id === run.assignmentId)) ||
      run.rootSessionId !== `worker-${run.ticketId}`)) return unavailable();
  if (!historical && (master ? !bridge.tickets.some(row => row.ticket.id === run.ticketId && row.assignmentId === run.assignmentId)
    : binding.runId !== runId || run.rootSessionId !== sessionId)) return unavailable();
  const [event] = manager.store.listEvents(runId, { afterSeq: seq - 1, asOfSeq: seq, limit: 1 });
  const version = historical ? undefined : manager.nativeInputs.current(runId)?.version;
  if ((!historical && !version) || !event || handle(event) !== args.ref || event.kind !== 'tool_observation' || event.attemptId !== 'root' ||
      event.payload.provenance !== 'host_tool_result' || (!historical && event.payload.observedInputVersion !== version) ||
      event.payload.actorId !== run.rootSessionId) return unavailable();
  if (historical) {
    if (args.jsonPointer !== undefined && args.jsonPointer !== '/text') return unavailable();
    const source = historicalSource(manager, run, event);
    if (!source) return unavailable();
    const bytes = Buffer.from(source.text);
    const reader = { readArtifact: (_run, _ref, range = {}) => ({ data: bytes.subarray(range.start, range.end),
      totalBytes: bytes.length, mediaType: 'text/plain; charset=utf-8' }) };
    return { ...readTaskEvidence(reader, runId, { label: event.payload.toolName, bytes: bytes.length }, args, sessionId),
      historical: true, jsonPointer: '/text', observedInputVersion: event.payload.observedInputVersion,
      sourceAssignmentId: run.assignmentId, sourceSha256: source.sha256,
      verificationScope: 'historical_source_not_current_verification' };
  }
  const { data } = manager.readArtifact(runId, event.payload.artifactRef, {}, sessionId);
  const text = publicToolText(JSON.parse(data.toString('utf8')), event.payload.toolCallId);
  if (text === undefined) return unavailable();
  const bytes = Buffer.from(selectText(text, args.jsonPointer));
  const source = { readArtifact: (_run, _ref, range = {}) => ({ data: bytes.subarray(range.start, range.end),
    totalBytes: bytes.length, mediaType: 'text/plain; charset=utf-8' }) };
  const result = readTaskEvidence(source, runId, { label: event.payload.toolName, bytes: bytes.length }, args, sessionId);
  return args.jsonPointer === undefined ? result : { ...result, jsonPointer: args.jsonPointer };
}
