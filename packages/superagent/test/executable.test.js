import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'
import { executable } from '../src/deployment.ts'

function files(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-llsa-executable-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const first = join(directory, 'first')
  const second = join(directory, 'second')
  mkdirSync(first)
  mkdirSync(second)
  return { first, second, write(dir, name) {
    const file = join(dir, name)
    writeFileSync(file, 'fixture, never executed')
    chmodSync(file, 0o755)
    return file
  } }
}

test('resolves absolute files and PATH entries while excluding worker shims', t => {
  const { first, second, write } = files(t)
  const shim = write(first, 'fixture-command')
  const host = write(second, 'fixture-command')
  const path = [first, second].join(delimiter)
  assert.equal(executable('fixture-command', path), shim)
  assert.equal(executable('fixture-command', path, first), host)
  assert.equal(executable(host, ''), host)
  assert.throws(() => executable('missing-command', path), /not an executable file/)
})

test('rejects relative path components with either directory separator', () => {
  for (const name of ['bin/command', 'bin\\command']) {
    assert.throws(() => executable(name, ''), /command name or an absolute path/)
  }
})

test('Windows resolves extensionless commands using PATHEXT in PATH order', { skip: process.platform !== 'win32' }, t => {
  const { first, second, write } = files(t)
  const previous = process.env.PATHEXT
  process.env.PATHEXT = '.CMD;.EXE'
  t.after(() => { if (previous === undefined) delete process.env.PATHEXT; else process.env.PATHEXT = previous })
  const firstExe = write(first, 'fixture.exe')
  const secondCmd = write(second, 'fixture.cmd')
  assert.equal(executable('fixture', [first, second].join(delimiter)), firstExe)
  assert.equal(executable('fixture', [first, second].join(delimiter), first), secondCmd)
  const firstCmd = write(first, 'fixture.cmd')
  assert.equal(executable('fixture', first), firstCmd)
  assert.equal(executable('fixture.exe', first), firstExe)
  assert.equal(executable(join(first, 'fixture'), ''), firstCmd)
  assert.equal(executable('fixture', `"${first}"`), firstCmd)
})
