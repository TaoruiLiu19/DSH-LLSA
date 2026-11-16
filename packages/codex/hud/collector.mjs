import { mkdirSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canStartRun, hookEvent, newRun, observe, snapshot } from './state.mjs';

const RUN_LIMIT = 32;
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    activity TEXT NOT NULL,
    state TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS actors (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS actors_run ON actors(run_id);`;

function databasePath(home) {
  return join(home ?? (process.env.CODEX_LEANLINK_HOME || join(homedir(), '.leanlink-codex')), 'hud', 'activity.sqlite');
}

/** Store a hook observation atomically so concurrent agent processes cannot overwrite one another. */
export function recordHook(input, { home, now = new Date() } = {}) {
  const event = hookEvent(input);
  if (!event) return false;
  const path = databasePath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path, { timeout: 2400, enableForeignKeyConstraints: true });
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec(SCHEMA);
    const owner = db.prepare('SELECT run_id FROM actors WHERE id = ?');
    const recordedRun = owner.get(event.session)?.run_id;
    // A session seen again after retention eviction gets a fresh HUD cursor namespace.
    const runId = recordedRun ?? randomUUID();
    const childRun = event.child ? owner.get(event.child)?.run_id : undefined;
    if ((!recordedRun && !canStartRun(event)) || (childRun && childRun !== runId)) {
      db.exec('COMMIT');
      return false;
    }
    const row = db.prepare('SELECT activity, state FROM runs WHERE id = ?').get(runId);
    const run = row ? JSON.parse(row.state) : newRun();
    const previousSeq = run.seq;
    const timestamp = now.toISOString();
    const at = row?.activity > timestamp ? row.activity : timestamp;
    const registered = observe(run, event, at);
    if (run.seq !== previousSeq) {
      db.prepare(`INSERT INTO runs(id, label, activity, state) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET activity = excluded.activity, state = excluded.state`)
        .run(runId, `Codex ${run.agents[0].id.slice(-8)}`, at, JSON.stringify(run));
      const index = db.prepare('INSERT INTO actors(id, run_id) VALUES (?, ?)');
      for (const id of registered) index.run(id, runId);
      if (!row) db.prepare('DELETE FROM runs WHERE id IN (SELECT id FROM runs ORDER BY activity DESC, id DESC LIMIT -1 OFFSET ?)').run(RUN_LIMIT);
    }
    db.exec('COMMIT');
    return run.seq !== previousSeq;
  } finally {
    // SQLite rolls back an uncommitted transaction if an interrupted or failed hook closes the handle.
    db.close();
  }
}

function readDatabase(home, fallback, read) {
  const path = databasePath(home);
  try { statSync(path); }
  catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
  const db = new DatabaseSync(path, { readOnly: true, timeout: 500 });
  try {
    if (!db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'runs'").get()) return fallback;
    return read(db);
  } finally { db.close(); }
}

export async function listRuns({ home } = {}) {
  return readDatabase(home, [], db => db.prepare('SELECT id, label, activity FROM runs ORDER BY activity DESC, id DESC').all()
    .map(({ id, label, activity }) => ({ runId: id, label, lastActivityAt: activity })));
}

export async function getSnapshot(runId, { home, now = new Date() } = {}) {
  if (typeof runId !== 'string') return null;
  return readDatabase(home, null, db => {
    const row = db.prepare('SELECT state FROM runs WHERE id = ?').get(runId);
    return row ? snapshot(JSON.parse(row.state), now) : null;
  });
}
