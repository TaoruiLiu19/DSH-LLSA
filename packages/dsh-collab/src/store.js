// @ts-check
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, readFileSync, existsSync, lstatSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { summarizeCosts } from './cost.js';

const digest = (data) => createHash('sha256').update(data).digest('hex');
const now = () => new Date().toISOString();
/** @param {string} code @param {string} message @returns {never} */
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
/** @param {unknown} value @param {string} name @returns {string} */
function required(value, name) {
  if (typeof value !== 'string' || !value.length || value.length > 512 || /[\u0000-\u001f]/u.test(value)) fail('INVALID_ARGUMENT', `${name} must be a nonempty identifier`);
  return value;
}
function integer(value, name, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) fail('INVALID_ARGUMENT', `${name} must be a safe integer >= ${min}`);
  return value;
}
function json(value) {
  const seen = new Set();
  function check(v, depth) {
    if (depth > 64) fail('INVALID_JSON', 'JSON nesting exceeds 64');
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number' && Number.isFinite(v)) return;
    if (typeof v !== 'object' || seen.has(v)) fail('INVALID_JSON', 'Only finite acyclic JSON values are supported');
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) fail('INVALID_JSON', 'Only plain JSON objects are supported');
    seen.add(v);
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) check(v[i], depth + 1); }
    else { for (const k of Object.keys(v)) check(v[k], depth + 1); }
    seen.delete(v);
  }
  check(value, 0);
  return JSON.stringify(value);
}
function equal(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((key, i) => key === kb[i] && equal(a[key], b[key]));
}
const parse = (row) => row ? JSON.parse(row.data) : null;

/** Synchronous host-side persistence. Does not grant authority or execute agent content. */
export class CollaborationStore {
  /** @param {{stateDir: string}} options */
  constructor({ stateDir }) {
    required(stateDir, 'stateDir');
    mkdirSync(resolve(stateDir), { recursive: true });
    this.stateDir = realpathSync(resolve(stateDir));
    const blobs = join(this.stateDir, 'artifacts');
    mkdirSync(blobs, { recursive: true });
    if (lstatSync(blobs).isSymbolicLink()) fail('UNSAFE_PATH', 'Artifact directory must not be a symlink');
    this.artifactDir = realpathSync(blobs);
    this.#inside(this.artifactDir);
    const dbPath = join(this.stateDir, 'collaboration.sqlite');
    if (existsSync(dbPath) && lstatSync(dbPath).isSymbolicLink()) fail('UNSAFE_PATH', 'Database must not be a symlink');
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    const version = Number(this.db.prepare('PRAGMA user_version').get().user_version);
    if (version > 1) { this.db.close(); fail('SCHEMA_VERSION', 'Database schema is newer than this plugin'); }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), run_seq INTEGER NOT NULL, step_id TEXT NOT NULL, attempt_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(run_id,run_seq));
      CREATE INDEX IF NOT EXISTS event_step ON events(run_id,step_id,run_seq);
      CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'events are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'events are immutable'); END;
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, sha256 TEXT UNIQUE NOT NULL, bytes INTEGER NOT NULL, media_type TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS protocols(id TEXT NOT NULL, version TEXT NOT NULL, data TEXT NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(id,version));
      CREATE TRIGGER IF NOT EXISTS protocols_no_update BEFORE UPDATE ON protocols BEGIN SELECT RAISE(ABORT,'protocol versions are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS protocols_no_delete BEFORE DELETE ON protocols BEGIN SELECT RAISE(ABORT,'protocol versions are immutable'); END;
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), logical_id TEXT NOT NULL, recipient TEXT NOT NULL, revision INTEGER NOT NULL, event_id TEXT NOT NULL REFERENCES events(id), status TEXT NOT NULL, transport_attempt INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL, UNIQUE(logical_id,recipient,revision));
      CREATE INDEX IF NOT EXISTS messages_pending ON messages(status,run_id);
      CREATE TABLE IF NOT EXISTS delivery_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL REFERENCES messages(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_calls(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), provider TEXT NOT NULL, account TEXT NOT NULL, provider_request_id TEXT, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS usage_provider_id ON usage_calls(provider,account,provider_request_id) WHERE provider_request_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS work_items(id TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL, PRIMARY KEY(run_id,id));
      CREATE TABLE IF NOT EXISTS agents(id TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL, PRIMARY KEY(run_id,id));
      CREATE TABLE IF NOT EXISTS source_receipts(source_id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), cursor TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_cursors(source TEXT PRIMARY KEY, cursor TEXT NOT NULL);
      PRAGMA user_version=1;
    `);
    this.closed = false;
  }

  #inside(path) {
    const rel = relative(this.stateDir, path);
    if (rel.startsWith('..') || isAbsolute(rel)) fail('UNSAFE_PATH', 'Path leaves state directory');
  }
  #tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  #run(id) { if (!this.getRun(id)) fail('RUN_NOT_FOUND', `Unknown run: ${id}`); }
  close() { if (!this.closed) { this.db.close(); this.closed = true; } }
  /** @param {import('./types.js').RunInput} input */
  createRun(input) {
    const id = required(input.id ?? input.runId ?? randomUUID(), 'run.id');
    const data = { ...input, id, ticketId: required(input.ticketId, 'ticketId'), assignmentId: required(input.assignmentId, 'assignmentId'), createdAt: input.createdAt ?? now() };
    const existing = this.getRun(id);
    if (existing) {
      if (existing.ticketId !== data.ticketId || existing.assignmentId !== data.assignmentId) fail('ID_CONFLICT', 'Run id already bound to another assignment');
      return existing;
    }
    this.db.prepare('INSERT INTO runs(id,data) VALUES (?,?)').run(id, json(data)); return data;
  }
  /** @param {string} id */
  getRun(id) { return parse(this.db.prepare('SELECT data FROM runs WHERE id=?').get(required(id, 'runId'))); }
  listRuns() { return this.db.prepare('SELECT data FROM runs ORDER BY rowid').all().map(parse); }
  #event(id) { return parse(this.db.prepare('SELECT data FROM events WHERE id=?').get(id)); }
  /** @param {string} id */
  getEvent(id) { return this.#event(required(id, 'eventId')); }
  /** @param {string} runId @param {string} kind */
  eventsByKind(runId, kind) {
    this.#run(runId);
    return this.db.prepare("SELECT data FROM events WHERE run_id=? AND json_extract(data,'$.kind')=? ORDER BY run_seq").all(runId, kind).map(parse);
  }
  #append(input) {
    const runId = required(input.runId, 'runId'); this.#run(runId);
    const id = required(input.id ?? input.eventId ?? randomUUID(), 'eventId');
    if (this.#event(id)) fail('DUPLICATE_EVENT', `Event ${id} already exists`);
    const parents = input.parents ?? [];
    if (!Array.isArray(parents) || new Set(parents).size !== parents.length) fail('INVALID_PARENTS', 'Parents must be a unique list');
    for (const parent of parents) {
      const event = this.#event(required(parent, 'parent'));
      if (!event || event.runId !== runId) fail('INVALID_PARENT', 'Parent must be an existing event in this run');
    }
    const runSeq = Number(this.db.prepare('SELECT COALESCE(MAX(run_seq),0)+1 AS n FROM events WHERE run_id=?').get(runId).n);
    const event = { ...input, id, eventId: id, runId, runSeq, stepId: required(input.stepId, 'stepId'), attemptId: required(input.attemptId ?? 'attempt-1', 'attemptId'), kind: required(input.kind, 'kind'), payload: input.payload ?? null, parents, inputRefs: input.inputRefs ?? [], createdAt: input.createdAt ?? now(), committedAt: now() };
    this.db.prepare('INSERT INTO events(id,run_id,run_seq,step_id,attempt_id,data) VALUES (?,?,?,?,?,?)').run(id, runId, runSeq, event.stepId, event.attemptId, json(event));
    return event;
  }
  /** @param {import('./types.js').EventInput} input */
  appendEvent(input) { return this.#tx(() => this.#append(input)); }
  /** @param {import('./types.js').RunInput} run @param {import('./types.js').EventInput[]} events */
  createRunWithEvents(run, events) {
    // A local calculation and its idempotency receipt become visible together.
    return this.#tx(() => {
      if (this.getRun(run.id)) fail('ID_CONFLICT', 'Local run already exists');
      this.createRun(run);
      return events.map(event => this.#append({ ...event, runId: run.id }));
    });
  }
  /** @param {string} runId @param {import('./types.js').EventQuery} [options] */
  listEvents(runId, { asOfSeq, afterSeq = 0, limit = 1000 } = {}) {
    this.#run(runId); integer(afterSeq, 'afterSeq'); integer(limit, 'limit', 1);
    if (limit > 10000) fail('INVALID_ARGUMENT', 'Page limit exceeds 10000');
    const highWater = this.highWater(runId);
    const cap = asOfSeq === undefined ? highWater : integer(asOfSeq, 'asOfSeq');
    return this.db.prepare('SELECT data FROM events WHERE run_id=? AND run_seq>? AND run_seq<=? ORDER BY run_seq LIMIT ?').all(runId, afterSeq, cap, limit).map(parse);
  }
  /** @param {string} runId @returns {number} */
  highWater(runId) { this.#run(runId); return Number(this.db.prepare('SELECT COALESCE(MAX(run_seq),0) AS n FROM events WHERE run_id=?').get(runId).n); }
  /** @param {string} runId @param {string} stepId @param {import('./types.js').StepQuery} [options] */
  inspectStep(runId, stepId, { attemptId, asOfSeq, eventId } = {}) {
    this.#run(runId); required(stepId, 'stepId');
    const highWater = this.highWater(runId);
    const cap = asOfSeq === undefined ? highWater : Math.min(integer(asOfSeq, 'asOfSeq'), highWater);
    const rows = this.db.prepare('SELECT data FROM events WHERE run_id=? AND step_id=? AND run_seq<=? ORDER BY run_seq').all(runId, stepId, cap).map(parse);
    if (eventId) {
      const event = rows.find(e => e.id === eventId && (!attemptId || e.attemptId === attemptId));
      if (!event) return { status: 'not_found', runId, stepId, asOfSeq: cap, events: [] };
      return { status: 'ok', runId, stepId, attemptId: event.attemptId, asOfSeq: event.runSeq, event, events: rows.filter(e => e.attemptId === event.attemptId && e.runSeq <= event.runSeq), view: 'event_snapshot' };
    }
    const attempts = [...new Set(rows.map(e => e.attemptId))];
    if (!attemptId && attempts.length > 1) return { status: 'ambiguous', runId, stepId, asOfSeq: cap, attempts, events: [] };
    const selected = rows.filter(e => !attemptId || e.attemptId === attemptId);
    return { status: selected.length ? 'ok' : 'not_found', runId, stepId, attemptId: attemptId ?? attempts[0] ?? null, asOfSeq: cap, event: selected.at(-1) ?? null, events: selected, view: 'state_as_of' };
  }

  /** @param {Buffer|string|import('./types.js').JsonValue} data @param {{mediaType?: string}} [options] @returns {import('./types.js').ArtifactMetadata} */
  putArtifact(data, { mediaType = 'application/octet-stream' } = {}) {
    const bytes = Buffer.isBuffer(data) ? data : typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(json(data), 'utf8');
    required(mediaType, 'mediaType');
    const hash = digest(bytes), id = `sha256:${hash}`, path = join(this.artifactDir, hash);
    if (existsSync(path)) {
      if (lstatSync(path).isSymbolicLink() || digest(readFileSync(path)) !== hash) fail('ARTIFACT_INTEGRITY', 'Existing artifact is not the expected bytes');
    } else {
      const temporary = join(this.artifactDir, `.tmp-${randomUUID()}`);
      const fd = openSync(temporary, 'wx');
      try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      try { renameSync(temporary, path); } catch (error) { if (existsSync(temporary)) unlinkSync(temporary); throw error; }
    }
    this.db.prepare('INSERT OR IGNORE INTO artifacts(id,sha256,bytes,media_type,created_at) VALUES (?,?,?,?,?)').run(id, hash, bytes.length, mediaType, now());
    return this.getArtifact(id);
  }
  /** @param {string|{id: string}} ref @returns {import('./types.js').ArtifactMetadata} */
  getArtifact(ref) {
    const id = typeof ref === 'string' ? ref : ref?.id;
    if (typeof id !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(id)) fail('INVALID_ARTIFACT_REF', 'Artifact ref must be a content digest');
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id=?').get(id);
    if (!row) fail('ARTIFACT_NOT_FOUND', 'Artifact is not registered');
    return { id: String(row.id), sha256: String(row.sha256), bytes: Number(row.bytes), mediaType: String(row.media_type), createdAt: String(row.created_at) };
  }
  /** @param {string|{id: string}} ref @param {import('./types.js').ArtifactRange} [options] @returns {Buffer} */
  readArtifact(ref, { start = 0, end } = {}) {
    const info = this.getArtifact(ref), path = join(this.artifactDir, info.sha256);
    if (!existsSync(path)) fail('ARTIFACT_MISSING', 'Artifact file is missing');
    if (lstatSync(path).isSymbolicLink()) fail('UNSAFE_PATH', 'Artifact cannot be a symlink');
    this.#inside(realpathSync(path));
    const bytes = readFileSync(path);
    if (bytes.length !== info.bytes || digest(bytes) !== info.sha256) fail('ARTIFACT_INTEGRITY', 'Artifact checksum or length mismatch');
    integer(start, 'start'); if (end !== undefined) integer(end, 'end');
    if (start > bytes.length || (end !== undefined && (end < start || end > bytes.length))) fail('INVALID_RANGE', 'Byte range is outside artifact');
    return bytes.subarray(start, end);
  }
  registerProtocol(input) {
    const id = required(input.id ?? input.protocolId ?? 'core', 'protocolId');
    const version = String(input.version ?? ''); required(version, 'version');
    const data = { ...input, id, version }; const encoded = json(data);
    const old = this.loadProtocol(id, version);
    if (old) { if (!equal(old, data)) fail('IMMUTABLE_PROTOCOL', 'Protocol version cannot be changed'); return old; }
    this.db.prepare('INSERT INTO protocols(id,version,data,sha256) VALUES (?,?,?,?)').run(id, version, encoded, digest(encoded)); return data;
  }
  loadProtocol(id, version) { return parse(this.db.prepare('SELECT data FROM protocols WHERE id=? AND version=?').get(required(id, 'protocolId'), String(version))); }
  listProtocols() { return this.db.prepare('SELECT data FROM protocols ORDER BY id,version').all().map(parse); }

  #enqueue(input) {
    const runId = required(input.runId, 'runId'); this.#run(runId);
    const eventId = required(input.eventId, 'eventId'); const event = this.#event(eventId);
    if (!event || event.runId !== runId) fail('INVALID_EVENT', 'Message event must belong to this run');
    const logicalMessageId = required(input.logicalMessageId ?? input.id ?? randomUUID(), 'logicalMessageId');
    const recipient = required(input.recipient, 'recipient'), revision = integer(input.deliveryRevision ?? 1, 'deliveryRevision', 1);
    const data = { ...input, id: input.id ?? `${logicalMessageId}:${revision}:${digest(recipient).slice(0,12)}`, runId, eventId, logicalMessageId, recipient, deliveryRevision: revision, sender: required(input.sender, 'sender'), projection: input.projection ?? null };
    required(data.id, 'messageId'); json(data);
    const existing = this.db.prepare('SELECT * FROM messages WHERE logical_id=? AND recipient=? AND revision=?').get(logicalMessageId, recipient, revision);
    if (existing) { if (!equal(JSON.parse(String(existing.data)), data)) fail('ID_CONFLICT', 'Retry changed message content'); return this.#messageRow(existing); }
    const earlier = this.db.prepare('SELECT * FROM messages WHERE logical_id=? AND recipient=? ORDER BY revision DESC LIMIT 1').get(logicalMessageId, recipient);
    if (earlier) {
      const before = JSON.parse(String(earlier.data));
      if (earlier.run_id !== runId || earlier.event_id !== eventId || before.sender !== data.sender) fail('ID_CONFLICT', 'Logical message cannot be rebound');
      if (revision !== Number(earlier.revision) + 1 || earlier.status !== 'rejected') fail('INVALID_REVISION', 'Only a rejected delivery can be replaced with the next encoding revision');
    } else if (revision !== 1) fail('INVALID_REVISION', 'First delivery revision must be one');
    this.db.prepare('INSERT INTO messages(id,run_id,logical_id,recipient,revision,event_id,status,data) VALUES (?,?,?,?,?,?,?,?)').run(data.id, runId, logicalMessageId, recipient, revision, eventId, 'queued', json(data));
    return { ...data, status: 'queued', transportAttempt: 0 };
  }
  #messageRow(row) { return row ? { ...JSON.parse(row.data), status: row.status, transportAttempt: row.transport_attempt } : null; }
  enqueueMessage(input) { return this.#tx(() => this.#enqueue(input)); }
  commitMessage({ event, message }) { return this.#tx(() => { const saved = this.#append(event); return { event: saved, message: this.#enqueue({ ...message, runId: saved.runId, eventId: saved.id }) }; }); }
  getMessage(id) { return this.#messageRow(this.db.prepare('SELECT * FROM messages WHERE id=?').get(id)); }
  listOutbox(options = {}) {
    if (typeof options === 'string') options = { runId: options };
    const { runId, states = ['queued', 'unknown'], limit = 1000 } = options;
    integer(limit, 'limit', 1); if (limit > 10000) fail('INVALID_ARGUMENT', 'Limit exceeds 10000');
    const wanted = new Set(states);
    return this.db.prepare(`SELECT * FROM messages ${runId ? 'WHERE run_id=?' : ''} ORDER BY rowid`).all(...(runId ? [runId] : [])).filter(row => wanted.has(row.status)).slice(0, limit).map(row => this.#messageRow(row));
  }
  /** @param {string} id @param {string} status @param {{incrementAttempt?: boolean, [key: string]: unknown}} [details] */
  markDelivery(id, status, details = {}) {
    const allowed = ['queued','inbox_persisted','included_in_request','rejected','cancelled','unknown'];
    if (!allowed.includes(status)) fail('INVALID_STATE', `Invalid delivery state: ${status}`);
    return this.#tx(() => {
      const row = this.db.prepare('SELECT * FROM messages WHERE id=?').get(id);
      if (!row) fail('MESSAGE_NOT_FOUND', 'Unknown message');
      const terminal = ['included_in_request','rejected','cancelled'];
      if (terminal.includes(String(row.status)) && row.status !== status) fail('INVALID_TRANSITION', 'Terminal delivery cannot be rewritten');
      if (status === 'included_in_request' && this.db.prepare("SELECT id FROM messages WHERE logical_id=? AND recipient=? AND status='included_in_request' AND id<>?").get(row.logical_id,row.recipient,id)) fail('ALREADY_INCLUDED', 'Logical message already entered a model request');
      const transportAttempt = Number(row.transport_attempt) + (details.incrementAttempt ? 1 : 0);
      this.db.prepare('UPDATE messages SET status=?,transport_attempt=? WHERE id=?').run(status,transportAttempt,id);
      this.db.prepare('INSERT INTO delivery_events(message_id,data) VALUES (?,?)').run(id,json({ ...details, id:randomUUID(), messageId:id, previousStatus:row.status,status,transportAttempt,at:now() }));
      return this.getMessage(id);
    });
  }
  listDeliveryEvents(id) { return this.db.prepare('SELECT data FROM delivery_events WHERE message_id=? ORDER BY seq').all(id).map(parse); }

  recordRequest(input) {
    this.#run(required(input.runId, 'runId')); const id = required(input.id ?? input.callId, 'callId');
    const data = { ...input, id, callId:id, createdAt: input.createdAt ?? now(), observableScope: input.observableScope ?? 'host-visible-only' };
    const old = parse(this.db.prepare('SELECT data FROM requests WHERE id=?').get(id));
    if (old) { if (!equal({ ...old, createdAt:null }, { ...data, createdAt:null })) fail('IMMUTABLE_REQUEST', 'Request snapshot cannot change'); return old; }
    this.db.prepare('INSERT INTO requests(id,run_id,data) VALUES (?,?,?)').run(id,input.runId,json(data)); return data;
  }
  listRequests(runId) { this.#run(runId); return this.db.prepare('SELECT data FROM requests WHERE run_id=? ORDER BY rowid').all(runId).map(parse); }
  recordUsage(input) {
    this.#run(required(input.runId, 'runId')); const id = required(input.callId ?? input.id, 'callId');
    const counts = ['inputTokens','outputTokens','cachedInputTokens','cacheWriteTokens','uncachedInputTokens'];
    const old = parse(this.db.prepare('SELECT data FROM usage_calls WHERE id=?').get(id));
    const data = { ...input, id, callId:id, provider:input.provider ?? old?.provider ?? 'unknown',account:input.account ?? old?.account ?? 'default',providerRequestId:input.providerRequestId ?? old?.providerRequestId ?? null };
    for (const key of counts) { data[key] = input[key] ?? null; if (data[key] !== null) integer(data[key], key); }
    if (data.inputTokens !== null && data.cachedInputTokens !== null && data.cachedInputTokens > data.inputTokens) fail('INVALID_USAGE', 'Cached input cannot exceed total input');
    if (input.cost !== undefined && input.cost !== null && (typeof input.cost !== 'number' || !Number.isFinite(input.cost) || input.cost < 0)) fail('INVALID_USAGE','Cost must be nonnegative');
    data.cost = input.cost ?? null; data.currency = input.currency ?? old?.currency ?? 'unspecified';
    if (old) {
      for (const key of ['runId','provider','account',...counts,'cost','providerRequestId']) {
        if (old[key] != null && data[key] !== null && !equal(old[key],data[key])) fail('USAGE_CONFLICT', `Recorded usage differs: ${key}`);
        if (data[key] == null && old[key] != null) data[key] = old[key];
      }
      if(old.cost !== null && data.currency !== old.currency) fail('USAGE_CONFLICT','Recorded cost currency cannot change');
    }
    if (data.providerRequestId) {
      const duplicate = parse(this.db.prepare('SELECT data FROM usage_calls WHERE provider=? AND account=? AND provider_request_id=? AND id<>?').get(data.provider,data.account,data.providerRequestId,id));
      if (duplicate) {
        if (duplicate.runId !== data.runId || counts.some(key => duplicate[key] != null && data[key] != null && duplicate[key] !== data[key]) || (duplicate.cost != null && data.cost != null && duplicate.cost !== data.cost)) fail('USAGE_CONFLICT', 'Provider request id conflicts with another call');
        return this.recordUsage({ ...data, id:duplicate.id,callId:duplicate.id });
      }
    }
    this.db.prepare('INSERT INTO usage_calls(id,run_id,provider,account,provider_request_id,data) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET provider_request_id=excluded.provider_request_id,data=excluded.data').run(id,data.runId,data.provider,data.account,data.providerRequestId,json(data)); return data;
  }
  /** Read-only derived view: a price estimate never overwrites account charges. */
  costSummary(runId, price) {
    return summarizeCosts(this.usageSummary(runId).usage, price);
  }
  usageSummary(runId) {
    this.#run(runId); const calls = this.db.prepare('SELECT data FROM usage_calls WHERE run_id=? ORDER BY rowid').all(runId).map(parse);
    const keys = ['inputTokens','outputTokens','cachedInputTokens','cacheWriteTokens','uncachedInputTokens'];
    const sums = Object.fromEntries(keys.map(key => [key,calls.reduce((sum,call)=>sum+(call[key]??0),0)]));
    const costByCurrency = {};
    for (const call of calls) if (call.cost !== null) costByCurrency[call.currency] = (costByCurrency[call.currency]??0)+call.cost;
    return { runId, calls:calls.length, ...sums,totalTokens:sums.inputTokens+sums.outputTokens,unknownCalls:calls.filter(c=>c.inputTokens===null||c.outputTokens===null).length,unknownCostCalls:calls.filter(c=>c.cost===null).length,missingFields:Object.fromEntries(keys.map(k=>[k,calls.filter(c=>c[k]===null).length])),costByCurrency,complete:calls.every(c=>c.inputTokens!==null&&c.outputTokens!==null),usage:calls };
  }
  #saveProjection(table,input,key) {
    this.#run(required(input.runId, 'runId')); const id=required(input.id??input[key],key); const data={...input,id};
    this.db.prepare(`INSERT INTO ${table}(id,run_id,data) VALUES (?,?,?) ON CONFLICT(run_id,id) DO UPDATE SET data=excluded.data`).run(id,input.runId,json(data)); return data;
  }
  saveWorkItem(input) { return this.#saveProjection('work_items',input,'workItemId'); }
  getWorkItems(runId) { this.#run(runId); return this.db.prepare('SELECT data FROM work_items WHERE run_id=? ORDER BY rowid').all(runId).map(parse); }
  saveAgent(input) { return this.#saveProjection('agents',input,'agentId'); }
  getAgents(runId) { this.#run(runId); return this.db.prepare('SELECT data FROM agents WHERE run_id=? ORDER BY rowid').all(runId).map(parse); }
  importSourceEvent({ source, sourceEventId, cursor, event }) {
    required(source,'source'); required(sourceEventId,'sourceEventId'); required(String(cursor),'cursor');
    const receiptId = json([source,sourceEventId]);
    return this.#tx(() => {
      const old=this.db.prepare('SELECT event_id FROM source_receipts WHERE source_id=?').get(receiptId);
      if(old) return { duplicate:true,event:this.#event(old.event_id) };
      const saved=this.#append(event);
      this.db.prepare('INSERT INTO source_receipts(source_id,event_id,cursor) VALUES (?,?,?)').run(receiptId,saved.id,String(cursor));
      this.db.prepare('INSERT INTO source_cursors(source,cursor) VALUES (?,?) ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor').run(source,String(cursor));
      return { duplicate:false,event:saved };
    });
  }
  sourceCursor(source) { return this.db.prepare('SELECT cursor FROM source_cursors WHERE source=?').get(source)?.cursor ?? null; }
}
