import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { test } from 'node:test'
import { localArtifactReceipts, readLocalArtifact, validateArtifactPaths, writeLocalArtifact } from '../src/app/local-artifacts.ts'

function fixture(t) {
  const testDir = mkdtempSync(join(tmpdir(), 'llsa-local-artifacts-'))
  t.after(() => rmSync(testDir, { recursive: true, force: true }))
  const workspace = join(testDir, 'workspace')
  mkdirSync(workspace)
  return { testDir, workspace }
}

test('artifact declarations reject path aliases, directory collisions and Windows devices', () => {
  assert.equal(validateArtifactPaths(['input/catalog.js', '文档/发布说明.md']), true)
  assert.equal(validateArtifactPaths(Array.from({ length: 12 }, (_, i) => `file${i}.txt`)), true)
  for (const paths of [[], Array(1), Array.from({ length: 13 }, (_, i) => `file${i}.txt`), ['File.md', 'file.MD'], ['input', 'Input/catalog.js']]) {
    assert.equal(validateArtifactPaths(paths), false)
  }
  for (const path of ['', '.', '..', '/absolute.txt', 'C:/absolute.txt', 'x\\relative.txt', 'x//file.txt', 'x/../file.txt',
    '.git/config', 'x/.env', 'x/file.', 'x/file ', 'x/file.txt:stream', 'a/CON .txt', 'AUX.txt', 'x/com².md', 'e\u0301.txt']) {
    assert.equal(validateArtifactPaths([path]), false, path)
  }
})

test('nested UTF-8 reads and atomic replacements return exact receipts', t => {
  const { workspace } = fixture(t)
  const path = 'input/catalog.js'
  assert.deepEqual(readLocalArtifact(workspace, path), { path, exists: false })
  assert.deepEqual(localArtifactReceipts(workspace, []), [])
  assert.deepEqual(localArtifactReceipts(workspace, [path]), [])
  const content = 'a'.repeat(7999) + '😀tail'
  const expected = { path, bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') }
  assert.deepEqual(writeLocalArtifact(workspace, path, content), expected)
  assert.deepEqual(readLocalArtifact(workspace, path), { ...expected, exists: true, content: 'a'.repeat(7999), next_offset: 7999 })
  assert.deepEqual(readLocalArtifact(workspace, path, 7999), { ...expected, exists: true, content: '😀tail', next_offset: null })
  assert.throws(() => readLocalArtifact(workspace, path, 8000), /Offset splits/)
  assert.deepEqual(localArtifactReceipts(workspace, [path, 'missing.txt']), [expected])
  const replacement = writeLocalArtifact(workspace, path, '更新')
  assert.deepEqual(localArtifactReceipts(workspace, [path]), [replacement])
  assert.notEqual(replacement.sha256, expected.sha256)
  assert.deepEqual(readdirSync(join(workspace, 'input')), ['catalog.js'])
})

test('oversize and non-text inputs fail before changing the original artifact', t => {
  const { workspace } = fixture(t)
  const path = 'app.txt'
  writeLocalArtifact(workspace, path, 'before')
  for (const text of ['界'.repeat(7000), '\0', '\uD800']) assert.throws(() => writeLocalArtifact(workspace, path, text), /20 KiB|UTF-8/)
  assert.equal(readFileSync(join(workspace, path), 'utf-8'), 'before')
  assert.throws(() => readLocalArtifact(workspace, path, -1), /offset/)

  writeFileSync(join(workspace, 'large.csv'), Buffer.alloc(180 * 1024 + 1, 97))
  assert.throws(() => readLocalArtifact(workspace, 'large.csv'), /180 KiB/)
  assert.throws(() => localArtifactReceipts(workspace, ['large.csv']), /180 KiB/)
  assert.throws(() => writeLocalArtifact(workspace, 'large.csv', 'smaller'), /180 KiB/)
  writeFileSync(join(workspace, 'binary.dat'), Buffer.from([0xFF, 0xFE]))
  assert.throws(() => readLocalArtifact(workspace, 'binary.dat'), /UTF-8/)
  assert.equal(localArtifactReceipts(workspace, ['binary.dat'])[0]?.bytes, 2)
})

test('append and exact splices are bounded and commit the whole batch or nothing', t => {
  const { workspace } = fixture(t)
  const path = 'notes.txt'
  writeLocalArtifact(workspace, path, { content: 'section A\n', mode: 'append' })
  assert.deepEqual(readLocalArtifact(workspace, path).content, 'section A\n')
  writeLocalArtifact(workspace, path, { content: 'section B', mode: 'splice', anchor: 'section A' })
  writeLocalArtifact(workspace, path, { splices: [{ anchor: 'section B', content: 'section C' }, { anchor: 'section C', content: 'section D' }] })
  assert.equal(readFileSync(join(workspace, path), 'utf-8'), 'section D\n')
  for (const edit of [
    { splices: [{ anchor: 'section D', content: 'unused' }, { anchor: 'missing', content: 'unused' }] },
    { splices: Array(7).fill({ anchor: 'section D', content: '' }) },
    { splices: [{ anchor: 'section D', content: 'a'.repeat(15000) }, { anchor: 'a', content: '界'.repeat(3000) }] },
    { splices: [], content: 'mixed' },
    { content: 'invalid', anchor: 'D' },
    { mode: null, content: 'invalid' },
  ]) assert.throws(() => writeLocalArtifact(workspace, path, edit), /exact|20 KiB|edit mode/)
  assert.equal(readLocalArtifact(workspace, path).content, 'section D\n')
  assert.deepEqual(readdirSync(workspace), [path])

  writeLocalArtifact(workspace, path, 'aaa')
  assert.throws(() => writeLocalArtifact(workspace, path, { content: 'b', mode: 'splice', anchor: 'aa' }), /exactly one/)
  assert.equal(readFileSync(join(workspace, path), 'utf-8'), 'aaa')
  writeFileSync(join(workspace, path), Buffer.alloc(180 * 1024, 97))
  assert.throws(() => writeLocalArtifact(workspace, path, { content: 'z', mode: 'append' }), /180 KiB/)
  assert.equal(localArtifactReceipts(workspace, [path])[0]?.bytes, 180 * 1024)
})

test('junctions, symbolic links, hard links and nonfiles are rejected', t => {
  const { testDir, workspace } = fixture(t)
  const sibling = join(testDir, 'sibling')
  mkdirSync(sibling)
  const original = join(sibling, 'original.txt')
  writeFileSync(original, 'outside')
  symlinkSync(sibling, join(workspace, 'jump'), 'junction')
  linkSync(original, join(workspace, 'hard.txt'))
  for (const path of ['jump/original.txt', 'jump/missing/deep.txt', 'hard.txt', '../sibling/original.txt']) {
    assert.throws(() => readLocalArtifact(workspace, path), /link|relative/)
    assert.throws(() => writeLocalArtifact(workspace, path, 'changed'), /link|relative/)
  }
  if (process.platform !== 'win32') {
    symlinkSync(join(sibling, 'missing.txt'), join(workspace, 'dangling.txt'), 'file')
    assert.throws(() => readLocalArtifact(workspace, 'dangling.txt'), /link/)
    assert.throws(() => writeLocalArtifact(workspace, 'dangling.txt', 'changed'), /link/)
  }
  mkdirSync(join(workspace, 'folder'))
  assert.throws(() => localArtifactReceipts(workspace, ['folder']), /regular/)
  assert.throws(() => readLocalArtifact(join(workspace, 'jump'), 'original.txt'), /real directory/)
  assert.throws(() => readLocalArtifact(join(workspace, 'jump') + sep, 'original.txt'), /real directory/)
  assert.deepEqual(readdirSync(sibling), ['original.txt'])
  assert.equal(readFileSync(original, 'utf-8'), 'outside')
})
