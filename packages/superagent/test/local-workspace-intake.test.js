import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { installLocalSource, LocalTaskSchema, stageLocalWorkspaceFiles } from '../src/app/local-tasks.ts'
import { writeLocalArtifact } from '../src/app/local-artifacts.ts'
import { Runtime } from '../src/app/runtime.ts'
import { Store } from '../src/app/store.ts'

const sourceText = '\uFEFFsource 雨\r\n' + '界'.repeat(8000)
const task = {
  requestId: 'file-intake-001', prompt: 'Adapt the existing file using the uploaded source.',
  directRoute: true, artifactFiles: ['index.html'], artifactInputs: ['input/catalog.txt'],
  workspaceFiles: [{ path: 'index.html', text: '<p>Editable starter.</p>' }, { path: 'input/catalog.txt', text: sourceText }],
}

function fixture(t, accepted = true) {
  const root = mkdtempSync(join(tmpdir(), 'llsa-workspace-intake-'))
  const directory = join(root, 'workspace')
  const file = join(root, 'orchestrator.sqlite')
  mkdirSync(directory)
  let store = new Store(file)
  installLocalSource(store)
  const row = id => store.db.prepare('SELECT content, ticket_id FROM local_workspace_staging WHERE trigger_id = ?').get(id)
  const launches = []
  const host = {
    get store() { return store },
    machine: { localOnly: true }, configured: () => true, closing: () => false,
    engine: { receive(trigger) { store.triggers.save(trigger); return accepted ? 'stored' : 'filtered' } },
    passes: { request() { launches.push(store.db.prepare('SELECT count(content) AS pending FROM local_workspace_staging').get().pending) } },
  }
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }) })
  return { directory, root, launches, row, get store() { return store },
    submit: input => Runtime.prototype.submitLocal.call(host, input),
    restart() { store.close(); store = new Store(file); installLocalSource(store) },
  }
}

test('user uploads survive a queued restart and keep the request identity after the bytes are staged', t => {
  const f = fixture(t)
  const { triggerId, reused } = f.submit(task)
  assert.equal(reused, false)
  assert.deepEqual(f.launches, [1])
  assert.equal(existsSync(join(f.directory, 'index.html')), false)
  const before = f.store.triggers.get(triggerId)
  assert.doesNotMatch(JSON.stringify(before), /Editable starter|source 雨/)
  assert.deepEqual(before.meta.workspaceManifest.map(({ path, bytes }) => [path, bytes]),
    task.workspaceFiles.map(({ path, text }) => [path, Buffer.byteLength(text)]))
  f.restart()
  const trigger = f.store.triggers.get(triggerId)
  stageLocalWorkspaceFiles(f.store, trigger, 'ticket1', f.directory)
  assert.deepEqual(readFileSync(join(f.directory, 'input', 'catalog.txt')), Buffer.from(sourceText))
  assert.equal(readFileSync(join(f.directory, 'index.html'), 'utf8'), '<p>Editable starter.</p>')
  assert.deepEqual({ ...f.row(triggerId) }, { content: null, ticket_id: 'ticket1' })
  assert.deepEqual(f.submit({ ...task, workspaceFiles: [...task.workspaceFiles].reverse() }), { triggerId, reused: true })
  assert.deepEqual(f.launches, [1])
  assert.throws(() => f.submit({ ...task, workspaceFiles: [{ ...task.workspaceFiles[0], text: 'different' }, task.workspaceFiles[1]] }),
    /requestId reused with different content/)
  writeLocalArtifact(f.directory, 'index.html', '<p>Worker changes.</p>')
  stageLocalWorkspaceFiles(f.store, trigger, 'ticket1', f.directory)
  assert.equal(readFileSync(join(f.directory, 'index.html'), 'utf8'), '<p>Worker changes.</p>')
  assert.throws(() => stageLocalWorkspaceFiles(f.store, trigger, 'different-ticket', f.directory), /unavailable/)
})

test('a partial stage only resumes in the bound ticket and preserves existing conflicting bytes', t => {
  const f = fixture(t)
  const { triggerId } = f.submit(task)
  const trigger = f.store.triggers.get(triggerId)
  const blockedPath = join(f.directory, 'input', 'catalog.txt')
  writeLocalArtifact(f.directory, 'input/catalog.txt', 'existing user file')
  assert.throws(() => stageLocalWorkspaceFiles(f.store, trigger, 'ticket1', f.directory), /conflicts/)
  assert.ok(f.row(triggerId).content)
  assert.equal(readFileSync(join(f.directory, 'index.html'), 'utf8'), '<p>Editable starter.</p>')
  assert.equal(readFileSync(blockedPath, 'utf8'), 'existing user file')
  assert.throws(() => stageLocalWorkspaceFiles(f.store, trigger, 'different-ticket', f.directory), /unavailable/)
  f.restart()
  rmSync(blockedPath)
  stageLocalWorkspaceFiles(f.store, trigger, 'ticket1', f.directory)
  assert.deepEqual(readFileSync(blockedPath), Buffer.from(sourceText))
  assert.equal(f.row(triggerId).content, null)
})

test('policy-refused file tasks roll back the source trigger and the staging queue together', t => {
  const f = fixture(t, false)
  assert.throws(() => f.submit(task), /refused by source policy/)
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM trigger').get().count, 0)
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM local_workspace_staging').get().count, 0)
  assert.deepEqual(f.launches, [])
})

test('workspace uploads accept only declared bounded UTF-8 paths with no collisions', () => {
  assert.equal(LocalTaskSchema.safeParse(task).success, true)
  for (const file of [
    { path: '../index.html', text: '' }, { path: 'INDEX.HTML', text: '' }, { path: 'not-declared.txt', text: '' },
    { path: 'index.html', text: '\0' }, { path: 'index.html', text: '\uD800' },
    { path: 'index.html', text: '界'.repeat(61_441) },
  ]) assert.equal(LocalTaskSchema.safeParse({ ...task, workspaceFiles: [file] }).success, false)
  assert.equal(LocalTaskSchema.safeParse({ ...task, workspaceFiles: [task.workspaceFiles[0], task.workspaceFiles[0]] }).success, false)
  assert.equal(LocalTaskSchema.safeParse({ ...task, outputFormat: 'json' }).success, false)
  assert.equal(LocalTaskSchema.safeParse({ ...task, artifactFiles: undefined }).success, false)
  for (const [count, size] of [[4, 140 * 1024], [13, 1]]) {
    const files = Array.from({ length: count }, (_, index) => ({ path: `file-${index}.txt`, text: 'x'.repeat(size) }))
    assert.equal(LocalTaskSchema.safeParse({ ...task, artifactFiles: ['out.txt'],
      artifactInputs: files.slice(0, 12).map(({ path }) => path), workspaceFiles: files }).success, false)
  }
})
