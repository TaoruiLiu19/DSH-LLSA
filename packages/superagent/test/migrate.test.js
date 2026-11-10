import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { SCHEMA_VERSION, Store } from '../src/app/store.ts'

function database(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-llsa-migration-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return join(directory, 'state.sqlite')
}

// Construct the old layout independently of Store's current schema.
function seedLegacy(path, settings = {}) {
  const db = new DatabaseSync(path)
  try {
    db.exec(`
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE outbox (id TEXT PRIMARY KEY, value TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
    const set = db.prepare('INSERT INTO kv VALUES (?, ?)')
    set.run('schema', '10')
    set.run('settings', JSON.stringify(settings))
    const ticket = {
      id: 'ticket-fixture', title: 'Summarize supplied text', decisionId: 'decision-fixture', state: 'open',
      assignments: [], inputs: [], undelivered: [], channels: [], summary: '', createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      mandate: { strength: 'explicit', policyVersion: 'fixture', basis: { direct: true, chatId: 'fixture-chat' },
        actor: { source: 'local', id: 'fixture-user' }, scope: 'Supplied text only' },
      meta: { sourceTriggerId: 'trigger-fixture', workspace: '/fixture/task', name: 'task', assignment: 'Read the supplied text.' },
    }
    db.prepare('INSERT INTO ticket VALUES (?, ?)').run(ticket.id, JSON.stringify(ticket))
    db.prepare('INSERT INTO outbox VALUES (?, ?, ?)').run('reply-fixture', JSON.stringify({
      id: 'reply-fixture', channel: { source: 'local', thread: 'fixture-thread', address: {} },
      text: 'Fixture reply', kind: 'reply', attempts: 2, error: 'offline', nextAttemptAt: 1,
    }), 0)
  } finally { db.close() }
}

test('migrates schema 10 data, pending replies, generated columns and indexes to schema 11', t => {
  const path = database(t)
  seedLegacy(path)
  const store = new Store(path)
  try {
    assert.equal(store.get('schema'), SCHEMA_VERSION)
    const ticket = store.tickets.get('ticket-fixture')
    assert.equal(ticket.meta, undefined)
    assert.deepEqual(ticket.origin, { triggerId: 'trigger-fixture', triggerIds: ['trigger-fixture'] })
    assert.equal(ticket.execution.directory, '/fixture/task')
    assert.equal(ticket.execution.assignment, 'Read the supplied text.')
    assert.equal(store.replyStatus('reply-fixture'), 'pending')
    assert.equal(store.db.prepare('SELECT attempts FROM effect WHERE kind = ? AND key = ?').get('reply', 'reply-fixture').attempts, 2)
    const columns = store.db.prepare("SELECT name, hidden FROM pragma_table_xinfo('ticket')").all()
    for (const name of ['open', 'active']) assert.ok(columns.some(row => row.name === name && row.hidden === 2))
    const indexes = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(row => row.name)
    for (const name of ['ticket_open', 'ticket_active', 'thread_active', 'thread_subscribed', 'outbox_pending', 'effect_due', 'trigger_thread_at']) {
      assert.ok(indexes.includes(name), `missing index ${name}`)
    }
    assert.ok(!store.db.prepare("SELECT name FROM pragma_table_xinfo('outbox')").all().some(row => row.name === 'sent'))
  } finally { store.close() }
})

test('reopening a migrated database preserves data and does not duplicate effects', t => {
  const path = database(t)
  seedLegacy(path)
  const first = new Store(path)
  const ticket = first.tickets.get('ticket-fixture')
  const effects = first.db.prepare('SELECT * FROM effect ORDER BY kind, key').all()
  first.close()
  const reopened = new Store(path)
  try {
    assert.deepEqual(reopened.tickets.get('ticket-fixture'), ticket)
    assert.deepEqual(reopened.db.prepare('SELECT * FROM effect ORDER BY kind, key').all(), effects)
    assert.equal(reopened.get('schema'), SCHEMA_VERSION)
  } finally { reopened.close() }
})

test('failed migration rolls back schema, data and table changes', t => {
  const path = database(t)
  seedLegacy(path, { executor: { maxWorkers: 'invalid' } })
  assert.throws(() => new Store(path), /unchanged at schema 10.*migration to schema 11 failed/)
  const db = new DatabaseSync(path)
  try {
    assert.equal(db.prepare("SELECT value FROM kv WHERE key = 'schema'").get().value, '10')
    assert.ok(JSON.parse(db.prepare('SELECT value FROM ticket').get().value).meta)
    assert.ok(db.prepare("SELECT name FROM pragma_table_xinfo('outbox')").all().some(row => row.name === 'sent'))
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'effect'").get(), undefined)
  } finally { db.close() }
})

test('rejects unsupported older and newer database versions without changing their schema', t => {
  const path = database(t)
  seedLegacy(path)
  for (const version of [9, SCHEMA_VERSION + 1]) {
    const db = new DatabaseSync(path)
    db.prepare("UPDATE kv SET value = ? WHERE key = 'schema'").run(String(version))
    db.close()
    assert.throws(() => new Store(path), version === 9 ? /predates schema 10/ : /Unsupported orchestrator database version/)
    const check = new DatabaseSync(path)
    try { assert.equal(check.prepare("SELECT value FROM kv WHERE key = 'schema'").get().value, String(version)) }
    finally { check.close() }
  }
})
