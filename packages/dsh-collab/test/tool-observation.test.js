import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempDisposableSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEncoding } from 'js-tiktoken';
import { ToolEventIndex } from '../src/tool-event-index.js';
import { CollaborationStore } from '../src/store.js';
import { CollaborationManager } from '../src/manager.js';
import { connectSuperagent } from '../src/superagent-integration.js';
import { readToolObservation, historicalObservations, issuedObservationRun } from '../src/tool-observation.js';
import { historyScope } from '../src/superagent-history.js';

const codec = getEncoding('o200k_base');
const ticket = { id: 't', assignments: [{ id: 'a' }] };
const runId = 'super-t-a';
const worker = 'worker-t';
function snapshot(text) {
  const value = JSON.stringify({ sources: [{ id: 'request', text }] });
  return { text: value, version: createHash('sha256').update(value).digest('hex') };
}
function fixture(t) {
  const ownedTicket = structuredClone(ticket);
  const scratch = mkdtempDisposableSync(join(tmpdir(), 'llsa-observation-'));
  const store = new CollaborationStore({ stateDir: scratch.path });
  const manager = new CollaborationManager({ store });
  manager.bindRoot(worker, { runId, ticketId: 't', assignmentId: 'a' });
  manager.bindRoot('master'); manager.bindRoot('other');
  const current = manager.syncNativeInput(runId, snapshot('Inspect the named resources.'));
  let lifecycle;
  const bridge = { compatibility: () => ({ apiVersion: 3 }),
    snapshot: () => ({ masterSessionId: 'master', tickets: [{ ticket: ownedTicket, assignmentId: ownedTicket.assignments.at(-1).id }] }),
    registerLifecycle(hooks) { lifecycle = hooks; return () => {}; } };
  manager.bridge = bridge;
  const integration = connectSuperagent(manager, bridge);
  t.after(async () => { integration.dispose(); await manager.close(); store.close(); scratch.remove(); });
  const session = {}, index = new ToolEventIndex();
  let seq = 0;
  function observe(text, { name = 'inspect_repository', actor = worker, scope, marked = true, overrides = {}, middle } = {}) {
    const callId = 'call-' + ++seq;
    const data = { turn: 1, step: seq, name, callId };
    index.observe(session, { seq, type: 'tool/call', data },
      marked ? scope ?? { runId, inputVersion: current.version } : undefined);
    middle?.();
    const message = { role: 'tool', toolCallId: callId, content: [{ type: 'text', text }], isError: false, ...overrides };
    const end = { seq: ++seq, type: 'tool/result', data: { ...data, message } };
    const resolved = index.resolve(session, end);
    const event = manager.recordToolResult(actor, name, message, callId, resolved);
    const identity = { callId, sessionId: actor, tool: name, resultSeq: seq };
    return { event, identity, ref: lifecycle.workerObservationRef(ticket, current.version, identity)?.ref };
  }
  const read = (ref, options = {}, sessionId = 'master') => {
    const { runId: permitted } = historyScope(manager, sessionId, { ticketId: ticket.id, assignmentId: 'a' });
    return readToolObservation(manager, permitted, sessionId, { ref, start: 0, bytes: 8000, ...options });
  };
  return { store, manager, current, observe, read, lifecycle, scratch, ticket: ownedTicket };
}

function documentText(label = 'Policy') {
  return (label + ': Original source paragraph with exact identifiers 007 and 009.\n').repeat(12);
}
function documentEnvelope(text, extra = {}) {
  return JSON.stringify({ text, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex'), ...extra });
}

test('issued bare observation handles resolve durably without relaxing caller and current-input checks', t => {
  const f = fixture(t);
  const first = f.observe('{"passed":true,"checks":7}');
  const second = f.observe('{"step":27,"verified":true}');
  assert.equal(issuedObservationRun(f.manager, first.ref), runId);
  const reopened = new CollaborationStore({ stateDir: f.scratch.path });
  try { assert.equal(issuedObservationRun({store:reopened}, first.ref), runId); }
  finally { reopened.close(); }
  const args = { ref:first.ref, start:0, bytes:1024, mode:'page' };
  assert.equal(readToolObservation(f.manager, issuedObservationRun(f.manager, first.ref), 'master', args).text, '{"passed":true,"checks":7}');
  assert.throws(() => readToolObservation(f.manager, runId, 'other', args), /unavailable/);
  f.manager.syncNativeInput(runId, snapshot('Revised constraint'));
  assert.throws(() => readToolObservation(f.manager, runId, 'master', args), /current input/);
  assert.equal(issuedObservationRun(f.manager, `${first.ref}0`), undefined);
  f.store.db.prepare('INSERT INTO tool_observation_refs(ref,event_id) VALUES (?,?)').run(first.ref, second.event.id);
  assert.equal(issuedObservationRun(f.manager, first.ref), undefined);
});

test('historical document recall survives input changes and retry assignments without conferring current verification', t => {
  const f = fixture(t), text = documentText();
  const observation = f.observe(documentEnvelope(text));
  for (let index=0; index<80; index++) {
    f.store.appendEvent({runId,stepId:'dispatch',kind:'model_request',payload:{index}});
  }
  f.manager.syncNativeInput(runId, snapshot('Changed cutoff'));
  assert.throws(() => f.read(observation.ref), /current input/);
  const changed = f.manager.nativeInputs.current(runId).version;
  const hints = historicalObservations(f.manager, f.ticket, changed);
  assert.equal(hints.length, 1);
  assert.equal(hints[0].verificationScope, 'historical_source_not_current_verification');
  assert.equal(hints[0].inputVersion, f.current.version);
  assert.equal(hints[0].text, undefined);
  const opts = { historical: true, ticketId: 't', assignmentId: 'a', jsonPointer: '/text' };
  const read = f.read(observation.ref, opts);
  assert.equal(read.text, text);
  assert.equal(read.historical, true);
  assert.equal(read.observedInputVersion, f.current.version);
  f.ticket.assignments.push({ id: 'retry' });
  f.manager.bindRoot(worker, { runId: 'super-t-retry', ticketId: 't', assignmentId: 'retry' });
  f.manager.syncNativeInput('super-t-retry', snapshot('Retry the current request'));
  assert.throws(() => f.read(observation.ref), /current input/);
  assert.equal(f.read(observation.ref, opts).text, text);
  assert.deepEqual(historicalObservations(f.manager, f.ticket, 'retry-version'), hints);
  for (const bad of [{ ...opts, ticketId: 'another' }, { ...opts, assignmentId: 'retry' },
    { ...opts, historical: 'true' }, { ...opts, historical: false }, { ...opts, jsonPointer: '/sha256' }]) {
    assert.throws(() => f.read(observation.ref, bad), /unavailable/);
  }
  assert.throws(() => f.read(observation.ref, opts, worker), /outside this session/);
  f.manager.bindings.set('child', { id: 'child', parentId: worker, runId });
  assert.throws(() => readToolObservation(f.manager, runId, 'child', { ref: observation.ref, ...opts }), /unavailable/);
  assert.throws(() => f.read(observation.ref.slice(0, -1) + (observation.ref.endsWith('0') ? '1' : '0'), opts), /unavailable/);
});

test('historical hints contain at most two distinct content documents and omit operation reports or invalid provenance', t => {
  const f = fixture(t), text = documentText();
  f.observe(documentEnvelope(documentText('Older')));
  f.observe(documentEnvelope(text));
  f.observe(documentEnvelope(text));
  const current = f.current.version;
  for (const raw of [documentEnvelope(documentText('Test'), { passed: true }),
    documentEnvelope(documentText('Write'), { written: true }), documentEnvelope(documentText('Result'), { result: 'ok' }),
    documentEnvelope(documentText('Bad hash'), { sha256: '0'.repeat(64) }),
    documentEnvelope(documentText('Bad length'), { bytes: 1 }), documentText('Plain text')]) f.observe(raw);
  const wrong = f.observe(documentEnvelope(documentText('Wrong actor')));
  f.store.appendEvent({ runId, stepId: 'forged-actor', kind: 'tool_observation',
    payload: { ...wrong.event.payload, actorId: 'different-worker' } });
  f.manager.syncNativeInput(runId, snapshot('New request'));
  const hints = historicalObservations(f.manager, f.ticket, 'new-version');
  assert.equal(hints.length, 2);
  assert.equal(new Set(hints.map(item => item.sourceSha256)).size, 2);
  assert.ok(hints.every(item => item.inputVersion === current && item.historical && !item.returned && !item.text));
  assert.equal(hints[0].ref, wrong.ref); // The genuine source survives; its forged actor copy does not.
  assert.equal(hints[1].sourceSha256, createHash('sha256').update(text).digest('hex'));
  const forged = f.store.appendEvent({ runId, stepId: 'forged-scope', kind: 'tool_observation',
    payload: { ...wrong.event.payload, toolIdentity: { ...wrong.event.payload.toolIdentity,
      scope: { runId: 'another', inputVersion: current } } } });
  const tag = createHash('sha256').update(JSON.stringify([forged.runId, forged.id])).digest('hex').slice(0,16);
  assert.throws(() => f.read(`obs:${forged.runSeq.toString(36)}-${tag}`, {
    historical: true, ticketId: 't', assignmentId: 'a' }), /unavailable/);
  // Ordinary events do not consume the lookup window. Only the last 64 observation candidates are inspected.
  for (let i = 0; i < 64; i++) f.store.appendEvent({ runId, stepId:'later-' + i, kind:'tool_observation',
    payload:{...wrong.event.payload,actorId:'another-worker'} });
  assert.deepEqual(historicalObservations(f.manager, f.ticket, 'new-version'), []);
  assert.equal(f.read(wrong.ref, { historical: true, ticketId: 't', assignmentId: 'a' }).historical, true);
});

test('authorized worker observations preserve UTF-8 bytes and exact occurrence order across search pages', t => {
  const f = fixture(t);
  const text = Array.from({ length: 120 }, (_, i) =>
    `section ${i} 中文 🙂 The recorded status is ${i % 20 === 0 ? 'check-previous-release' : 'open'}; reviewed batch ${1000 + i}.`).join('\r\n');
  const { ref, identity } = f.observe(text);
  assert.match(ref, /^obs:[a-z0-9]+-[a-f0-9]{16}$/);
  assert.equal(f.lifecycle.workerObservationRef(ticket, f.current.version, { ...identity, resultSeq: 999 }), undefined);
  let restored = '', cursor = 0;
  do {
    const page = f.read(ref, { start: cursor, bytes: 479 }, worker);
    restored += page.text; cursor = page.nextStart;
  } while (cursor !== null);
  assert.equal(restored, text);
  const query = { contains: 'check-previous-release' };
  const first = f.read(ref, query), second = f.read(ref, { ...query, start: first.nextStart });
  assert.deepEqual([...first.matches, ...second.matches].map(line => line.line), [1, 21, 41, 61, 81, 101]);
  for (const line of [...first.matches, ...second.matches]) {
    assert.equal(Buffer.from(text).subarray(line.start, line.start + line.bytes).toString('utf8'), line.text);
  }
  assert.equal(second.more, false);
  const measure = value => codec.encode(JSON.stringify(value)).length;
  const fullTokens = measure({ text });
  const sliceTokens = measure({ ref, ...query }) + measure(first) + measure({ ref, ...query, start: first.nextStart }) + measure(second);
  assert.ok(sliceTokens < fullTokens);
  t.diagnostic(`Archived text vs two scoped search calls and replies: ${fullTokens} vs ${sliceTokens} o200k_base tokens. Local estimate, no provider usage.`);
  assert.throws(() => f.read(ref, {}, 'other'), /outside this session/);
  f.manager.bindings.set('sibling', { id: 'sibling', parentId: worker, runId });
  assert.throws(() => f.read(ref, {}, 'sibling'), /unavailable/);
  assert.throws(() => readToolObservation(f.manager, 'run-other', 'other', { ref }), /unavailable/);
  f.manager.syncNativeInput(runId, snapshot('Changed work order'));
  assert.equal(f.lifecycle.workerObservationRef(ticket, f.current.version, identity), undefined);
  assert.throws(() => f.read(ref), /current input/);
});

test('missing provenance, errors, hidden or mixed blocks and observations spanning an input change never become review refs', t => {
  const f = fixture(t);
  for (const options of [{ marked: false }, { scope: { runId: 'another', inputVersion: f.current.version } },
    { name: 'collab_consult_web' }, { name: 'orchestrator_read' }, { overrides: { isError: true } },
    { overrides: { content: [{ type: 'reasoning', text: 'private' }, { type: 'text', text: 'public' }] } },
    { middle: () => f.manager.syncNativeInput(runId, snapshot('New input')) }]) {
    const entry = f.observe('exact stdout', options);
    assert.ok(entry.event.payload.artifactRef);
    assert.equal(entry.ref, undefined);
    assert.equal(entry.event.payload.observedInputVersion, undefined);
  }
});

test('a forged short reference or changed archived bytes fail the normal integrity checks', t => {
  const f = fixture(t);
  const { ref, event } = f.observe('Original tool text');
  const forged = ref.slice(0, -1) + (ref.endsWith('0') ? '1' : '0');
  assert.throws(() => f.read(forged), /unavailable/);
  const meta = f.store.getArtifact(event.payload.artifactRef);
  writeFileSync(join(f.scratch.path, 'artifacts', meta.sha256), 'Changed');
  assert.throws(() => f.read(ref), { code: 'ARTIFACT_INTEGRITY' });
});

test('JSON Pointer selects exact multiline text without changing the archived JSON or inventing values', t => {
  const f = fixture(t);
  const document = 'RETAIN 007 中文\r\nother\nRETAIN 002 end';
  const raw = JSON.stringify({ files: [{ 'a/b~c': document }, { size: 20 }] });
  const { ref } = f.observe(raw);
  const jsonPointer = '/files/0/a~1b~0c';
  assert.equal(f.read(ref).text, raw);
  const result = f.read(ref, { jsonPointer, contains: 'RETAIN' });
  assert.equal(result.jsonPointer, jsonPointer);
  assert.deepEqual(result.matches.map(line => line.text), ['RETAIN 007 中文', 'RETAIN 002 end']);
  const first = f.read(ref, { jsonPointer, bytes: 13 });
  assert.equal(first.text + f.read(ref, { jsonPointer, start: first.nextStart }).text, document);
  for (const invalid of ['files', '/files/0/a~2b', '/files/01', '/files/length', '/unknown', '/files/1/size', '/constructor']) {
    assert.throws(() => f.read(ref, { jsonPointer: invalid }), /JSON Pointer/);
  }
});
