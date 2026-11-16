import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$';
export const REF_PATTERN = '^ll1:[A-Za-z0-9_-]{22}$';
export const MAX_TEXT_BYTES = 1_048_576;
export const MAX_PAGE_BYTES = 16_384;

export class ToolError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function packet(row) {
  const result = { seq: row.seq, kind: row.kind, inputVersion: row.input_version, ref: row.ref ?? row.target_ref };
  if (row.step !== null) result.step = row.step;
  if (row.byte_count !== null) result.bytes = row.byte_count;
  if (row.decision !== null) result.decision = row.decision;
  return result;
}

export class Archive {
  constructor(home, workspacePin) {
    if (workspacePin !== undefined && !new RegExp(ID_PATTERN).test(workspacePin)) {
      throw new Error('CODEX_LEANLINK_WORKSPACE must be a valid workspace ID');
    }
    this.workspacePin = workspacePin;
    const directory = join(home, 'archive');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, 'leanlink.sqlite'));
    this.db.exec('PRAGMA busy_timeout = 8000; PRAGMA foreign_keys = ON;');
    this.transaction(() => this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        workspace TEXT NOT NULL,
        run TEXT NOT NULL,
        input_version INTEGER NOT NULL,
        last_seq INTEGER NOT NULL,
        PRIMARY KEY (workspace, run)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS entries (
        workspace TEXT NOT NULL,
        run TEXT NOT NULL,
        seq INTEGER NOT NULL,
        op_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('input', 'checkpoint', 'result', 'review')),
        input_version INTEGER NOT NULL,
        ref TEXT UNIQUE,
        step TEXT,
        byte_count INTEGER,
        body BLOB,
        digest TEXT,
        summary TEXT,
        target_ref TEXT REFERENCES entries(ref),
        decision TEXT,
        reason TEXT,
        PRIMARY KEY (workspace, run, seq),
        UNIQUE (workspace, run, op_id),
        UNIQUE (target_ref),
        FOREIGN KEY (workspace, run) REFERENCES runs(workspace, run)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS entries_step ON entries(workspace, run, step, seq);
    `));
  }

  close() { this.db.close(); }

  transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  scope(workspace) {
    if (this.workspacePin !== undefined && workspace !== this.workspacePin) {
      throw new ToolError('SCOPE_MISMATCH', 'This server is pinned to a different workspace');
    }
  }

  run(workspace, run) {
    return this.db.prepare('SELECT input_version, last_seq FROM runs WHERE workspace = ? AND run = ?').get(workspace, run);
  }

  scopedRef(workspace, run, ref) {
    const row = this.db.prepare('SELECT * FROM entries WHERE workspace = ? AND run = ? AND ref = ?').get(workspace, run, ref);
    if (!row) throw new ToolError('NOT_FOUND', 'Reference was not found in this workspace and run');
    return row;
  }

  write(tool, args, create) {
    const {workspace, run, opId} = args;
    this.scope(workspace);
    // The tool validator emits properties in schema order and normalizes defaults.
    const fingerprint = sha256(JSON.stringify([tool, args]));
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM entries WHERE workspace = ? AND run = ? AND op_id = ?').get(workspace, run, opId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new ToolError('OP_CONFLICT', 'This opId already names a different write');
        return packet(previous);
      }
      const current = this.run(workspace, run);
      const entry = create(current);
      const seq = (current?.last_seq ?? 0) + 1;
      const { kind, inputVersion, ref = null, step = null, body = null, summary = null,
        targetRef = null, decision = null, reason = null } = entry;
      const byteCount = body?.length ?? null;
      this.db.prepare(`INSERT INTO runs VALUES (?, ?, ?, ?)
        ON CONFLICT(workspace, run) DO UPDATE SET input_version = excluded.input_version, last_seq = excluded.last_seq`)
        .run(workspace, run, inputVersion, seq);
      this.db.prepare(`INSERT INTO entries (workspace, run, seq, op_id, fingerprint, kind, input_version,
        ref, step, byte_count, body, digest, summary, target_ref, decision, reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(workspace, run, seq, opId, fingerprint, kind, inputVersion, ref, step, byteCount,
          body, body === null ? null : sha256(body), summary, targetRef, decision, reason);
      return packet({ seq, kind, input_version: inputVersion, ref, step, byte_count: byteCount, target_ref: targetRef, decision });
    });
  }

  submit(args) {
    return this.write('submit', args, current => {
      const inputVersion = current?.input_version ?? 0;
      if (args.expectedVersion !== inputVersion) {
        throw new ToolError('VERSION_CONFLICT', 'Supply the current input version before replacing input', { inputVersion });
      }
      return { kind: 'input', inputVersion: inputVersion + 1, ref: `ll1:${randomBytes(16).toString('base64url')}`,
        body: Buffer.from(args.text) };
    });
  }

  checkpoint(args) {
    return this.write('checkpoint', args, current => {
      if (!current) throw new ToolError('NOT_FOUND', 'Submit this run before saving a step');
      if (args.inputVersion !== current.input_version) {
        throw new ToolError('STALE_INPUT', 'Use the current input version for new work', { inputVersion: current.input_version });
      }
      return { kind: args.kind, inputVersion: args.inputVersion, ref: `ll1:${randomBytes(16).toString('base64url')}`,
        step: args.step, body: Buffer.from(args.text), summary: args.summary ?? null };
    });
  }

  review(args) {
    return this.write('review', args, current => {
      const target = this.scopedRef(args.workspace, args.run, args.ref);
      if (target.kind !== 'result') throw new ToolError('INVALID_TARGET', 'Only saved results can be reviewed');
      if (target.input_version !== current.input_version) {
        throw new ToolError('STALE_INPUT', 'This result belongs to an older input version', { inputVersion: current.input_version });
      }
      if (this.db.prepare('SELECT 1 FROM entries WHERE target_ref = ?').get(args.ref)) {
        throw new ToolError('ALREADY_REVIEWED', 'This result already has a recorded decision; submit another result for a new review');
      }
      return { kind: 'review', inputVersion: target.input_version, step: target.step,
        targetRef: args.ref, decision: args.decision, reason: args.reason };
    });
  }

  lookup({ workspace, run, step, afterSeq, throughSeq, limit }) {
    this.scope(workspace);
    const current = this.run(workspace, run);
    if (!current) throw new ToolError('NOT_FOUND', 'This workspace and run have no saved input');
    const cutoff = throughSeq ?? current.last_seq;
    if (afterSeq > cutoff || cutoff > current.last_seq) throw new ToolError('INVALID_CURSOR', 'Use sequence positions from this run');
    const bound = this.db.prepare(`SELECT input_version FROM entries WHERE workspace = ? AND run = ? AND seq <= ?
      ORDER BY seq DESC LIMIT 1`).get(workspace, run, cutoff);
    const found = step === undefined
      ? this.db.prepare(`SELECT seq, kind, input_version, ref, target_ref, step, byte_count, summary, decision, reason
          FROM entries WHERE workspace = ? AND run = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?`)
        .all(workspace, run, afterSeq, cutoff, limit + 1)
      : this.db.prepare(`SELECT seq, kind, input_version, ref, target_ref, step, byte_count, summary, decision, reason
          FROM entries WHERE workspace = ? AND run = ? AND step = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?`)
        .all(workspace, run, step, afterSeq, cutoff, limit + 1);
    const page = found.slice(0, limit);
    return { inputVersion: bound?.input_version ?? 0, throughSeq: cutoff,
      entries: page.map(row => ({ ...packet(row), ...(row.summary === null ? {} : { summary: row.summary }),
        ...(row.reason === null ? {} : { reason: row.reason }) })),
      nextAfterSeq: found.length > limit ? page.at(-1).seq : null };
  }

  read({ workspace, run, ref, start, bytes }) {
    this.scope(workspace);
    const row = this.scopedRef(workspace, run, ref);
    const data = Buffer.from(row.body);
    const continuationByte = index => (data[index] & 0xc0) === 0x80;
    if (start > data.length || continuationByte(start)) {
      throw new ToolError('INVALID_CURSOR', 'Use the returned nextStart or another UTF-8 character boundary');
    }
    let end = Math.min(start + bytes, data.length);
    while (end < data.length && continuationByte(end)) end++;
    return { ref, inputVersion: row.input_version, start, bytes: end - start, totalBytes: data.length,
      nextStart: end === data.length ? null : end, sha256: row.digest, text: data.toString('utf8', start, end) };
  }
}
