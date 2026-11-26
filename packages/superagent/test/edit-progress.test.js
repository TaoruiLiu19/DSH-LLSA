import assert from 'node:assert/strict'
import { test } from 'node:test'
import { editProgressHint, unfinishedEditDraft } from '../src/executor/edit-progress.ts'

const version = 'a'.repeat(64)
const otherVersion = 'b'.repeat(64)
const start = { type: 'turn/start', data: { turn: 1 } }
const end = { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }
const marker = (inputVersion = version, source = { kind: 'dsh-collab', form: 'input-reference' }) =>
  ({ type: 'user/message', data: { id: `native-input:ticket:${inputVersion}`, source } })
const history = (...events) => events.flat().map((event, index) => ({ ...event, seq: index + 1 }))
const result = (id, name, value, { args = '{}', turn = 1, step = Number(id), isError = false, wrongStep = false } = {}) => [
  { type: 'tool/call', data: { turn, step, callId: id, name, arguments: args } },
  { type: 'tool/result', data: { turn, step: wrongStep ? step + 1 : step, message: {
    role: 'tool', toolCallId: id, isError, content: [{ type: 'text', text: JSON.stringify(value) }],
  } } },
]
const fail = { passed: false, checks: [
  { id: 'retains-order', passed: false, points: 10, diagnostic: 'First run at 09:00' },
  { id: 'preserves-state', passed: true, points: 15 },
] }
const pass = { passed: true, checks: [{ id: 'retains-order', passed: true }, { id: 'preserves-state', passed: true }] }
const read = { path: 'src/example.js', start: 3, lines: '3 const a = 1\n4 const b = 2', next: 5 }
const check = (id, value = fail, options) => result(id, 'project_check', value, options)
const readResult = (id, value = read, options) => result(id, 'project_read', value, options)

test('hints on repeated equivalent failed checks even when diagnostic text and check order change', () => {
  const later = { ...fail, checks: [...fail.checks].reverse().map(row => ({ ...row, diagnostic: 'Different diagnostic' })) }
  assert.deepEqual(editProgressHint(history(start, marker(), check('1'), readResult('2'), check('3', later))),
    { turnSeq: 1, inputVersion: version, kind: 'RepeatedCheck' })
})

test('hints on repeated source and span only when the same content or an explicit compact receipt supports it', () => {
  const compact = { path: read.path, start: 3, end: 4, unchanged: true, status: 'repeated_read' }
  const expected = { turnSeq: 1, inputVersion: version, kind: 'RepeatedRead' }
  assert.deepEqual(editProgressHint(history(start, marker(), readResult('1'), readResult('2', { ...read, next: 7 }))), expected)
  assert.deepEqual(editProgressHint(history(start, marker(), readResult('1'), readResult('2', compact))), expected)
  for (const changed of [{ ...read, path: 'other.js' }, { ...read, start: 4 }, { ...read, lines: '3 const a = 2\n4 const b = 2' },
    { ...compact, end: 5 }, { ...compact, unchanged: false }, { ...compact, status: 'ok' }]) {
    assert.equal(editProgressHint(history(start, marker(), readResult('1'), readResult('2', changed))), undefined)
  }
  assert.equal(editProgressHint(history(start, marker(), readResult('1', compact), readResult('2', compact))), undefined)
})

test('requires a real paired receipt and the same test invocation and outcome', () => {
  const good = check('1')
  assert.equal(editProgressHint(history(start, marker(), good, check('2', fail, { wrongStep: true }))), undefined)
  assert.equal(editProgressHint(history(start, marker(), good, check('2', fail, { isError: true }))), undefined)
  assert.equal(editProgressHint(history(start, marker(), good, check('2', fail, { args: '{"scope":"other"}' }))), undefined)
  assert.equal(editProgressHint(history(start, marker(), good, result('2', 'another_check', fail))), undefined)
  assert.equal(editProgressHint(history(start, marker(), good, check('2', { passed: false, checks: [...fail.checks, fail.checks[0]] }))), undefined)
  assert.equal(editProgressHint(history(start, marker(), good, check('2', { passed: true, checks: fail.checks }))), undefined)
  assert.equal(editProgressHint(history(start, marker(), good, check('2', { passed: true, checks: [{ id: 'retains-order', passed: true }] }), check('3'))), undefined)
  assert.equal(editProgressHint(history(start, marker(), good, check('2'), result('3', 'future_call', {})[0])), undefined)
  assert.equal(editProgressHint(history(start, marker(), good, good[1])), undefined)
})

test('keeps the latest trusted version and open turn separate from older work and direct user changes', () => {
  const expected = { turnSeq: 5, inputVersion: otherVersion, kind: 'RepeatedCheck' }
  assert.equal(editProgressHint(history(marker(), start, check('1'), end, start, check('2'))), undefined)
  assert.equal(editProgressHint(history(start, marker(), check('1'), marker(otherVersion), check('2'))), undefined)
  assert.equal(editProgressHint(history(start, marker(), check('1'), check('2'), end)), undefined)
  assert.equal(editProgressHint(history(start, marker(version, { kind: 'user' }), check('1'), check('2'))), undefined)
  assert.equal(editProgressHint(history(start, marker(), check('1'), check('2'), marker('bad-version'))), undefined)
  assert.equal(editProgressHint(history(start, marker(), check('1'), check('2'), { type: 'user/message', data: { source: { kind: 'user' } } })), undefined)
  assert.deepEqual(editProgressHint(history(marker(), start, result('1', 'patch', { written: true }), start,
    marker(otherVersion), check('2'), check('3'))), expected)
})

test('a genuine write in the current input version leaves guidance to the post-write workflow', () => {
  const written = result('4', 'project_patch', { written: true })
  assert.equal(editProgressHint(history(start, marker(), check('1'), written, check('2'))), undefined)
  assert.equal(editProgressHint(history(marker(), start, written, end, start, readResult('1'), readResult('2'))), undefined)
  assert.deepEqual(editProgressHint(history(start, marker(), check('1'), result('4', 'project_patch', { written: true }, { isError: true }), check('2'))),
    { turnSeq: 1, inputVersion: version, kind: 'RepeatedCheck' })
})

const canonicalReceipt = id => 'received:' + id
const delivered = (id, source = 'dsh-superagent') => ({ type: 'user/message', data: { id: canonicalReceipt(id), source: { kind: source } } })
const say = (...content) => ({ type: 'assistant/message', data: { turn: 1, step: 4, message: { content } } })
const plain = { type: 'text', text: 'I will now implement the change.' }
const ticket = { id: 'ticket', inputs: [] }
const startup = (events, work = ticket) => unfinishedEditDraft(events, work, 'applied', canonicalReceipt)
const assignment = delivered('assignment:ticket')
const readTurn = (...events) => history(start, assignment, marker(), ...events, say(plain), end)

test('a completed prose draft following a scoped source read or failed check requests one startup recovery', () => {
  const expected = { inputVersion: version, startupWork: true }
  assert.deepEqual(startup(readTurn(readResult('1'))), expected)
  assert.deepEqual(startup(readTurn(check('1'))), expected)
  assert.deepEqual(startup(history(marker(), start, delivered('trigger:initial'), readResult('1'), say(plain), end),
    { ...ticket, inputs: [{ id: 'trigger:initial', kind: 'trigger' }] }), expected)
  assert.equal(startup(history(marker(), start, delivered('trigger:initial'), readResult('1'), say(plain), end),
    { ...ticket, inputs: [{ id: 'trigger:initial', kind: 'trigger', context: true }] }), undefined)
})

test('startup recovery requires observed investigation and terminal prose with no pending tool', () => {
  assert.equal(startup(readTurn()), undefined)
  assert.equal(startup(readTurn(result('1', 'project_list', { path: 'src/example.js', symbols: [] }))), undefined)
  assert.deepEqual(startup(readTurn(readResult('1', { path: 'src/example.js', found: false, status: 'source_search_miss' }))),
    { inputVersion: version, startupWork: true })
  assert.equal(startup(readTurn(readResult('1', { path: '../example.js', found: false, status: 'source_search_miss' }))), undefined)
  for (const path of ['../example.js', '/outside/example.js', 'C:\\example.js', 'https://example.org/example.js']) {
    assert.equal(startup(readTurn(readResult('1', { ...read, path }))), undefined)
  }
  assert.equal(startup(readTurn(readResult('1', read, { isError: true }))), undefined)
  assert.equal(startup(readTurn(readResult('1', read, { wrongStep: true }))), undefined)
  assert.equal(startup(readTurn(readResult('1', read, { turn: 2 }))), undefined)
  assert.equal(startup(history(start, assignment, marker(), readResult('1'), say(plain))), undefined)
  assert.equal(startup(history(start, assignment, marker(), readResult('1'), say(plain, { type: 'tool-call' }), end)), undefined)
  assert.equal(startup(history(start, assignment, marker(), readResult('1'), result('2', 'next_tool', {})[0], say(plain), end)), undefined)
  assert.equal(startup(history(start, assignment, marker(), readResult('1'), say({ type: 'text', text: '{"plan":"coming"}' }), end)), undefined)
})

test('startup recovery does not override direct user input or different task scope', () => {
  assert.equal(startup(readTurn(readResult('1'), delivered('manual', 'user'))), undefined)
  assert.equal(startup(history(start, assignment, marker(), readResult('1'), say(plain), end, delivered('manual', 'user'))), undefined)
  assert.equal(startup(readTurn(readResult('1'), marker(otherVersion))), undefined)
  assert.equal(startup(history(start, delivered('assignment:other'), marker(), readResult('1'), say(plain), end)), undefined)
  assert.deepEqual(startup(readTurn(readResult('1'), result('2', 'project_edit', { written: true }, { isError: true }))),
    { inputVersion: version, startupWork: true })
})

test('a current workspace edit without a later valid pass remains eligible for startup recovery', () => {
  const write = result('2', 'project_edit', { written: true })
  const expected = { inputVersion: version, startupWork: true }
  assert.deepEqual(startup(readTurn(write)), expected)
  assert.deepEqual(startup(readTurn(write, check('3'))), expected)
  assert.deepEqual(startup(readTurn(write, check('3', { passed: true, checks: fail.checks }))), expected)
  assert.deepEqual(startup(readTurn(write, check('3', pass, { isError: true }))), expected)
  assert.deepEqual(startup(readTurn(check('1', pass), write)), expected)
  assert.deepEqual(startup(readTurn(write, check('3', pass), result('4', 'project_edit', { written: true }))), expected)
  assert.equal(startup(readTurn(result('2', 'project_edit', { written: true }, { isError: true }))), undefined)
})

test('a valid passing check on the latest current edit ends startup recovery, including after later reads', () => {
  const write = result('2', 'project_edit', { written: true })
  assert.equal(startup(readTurn(write, check('3', pass), readResult('4'))), undefined)
  assert.equal(startup(history(marker(), start, write, check('3', pass), end, start, assignment, readResult('4'), say(plain), end)), undefined)
  assert.deepEqual(startup(history(marker(), start, write, check('3', pass), end, start, assignment, marker(otherVersion), readResult('4'), say(plain), end)),
    { inputVersion: otherVersion, startupWork: true })
})

test('a consumed startup reminder is recognizable only for its bound assignment and input version', () => {
  const memo = { id: 'note-1', kind: 'note', submissionFor: { assignmentId: 'applied', inputVersion: version, startupWork: true } }
  const scoped = { ...ticket, inputs: [memo] }
  const events = history(marker(), start, delivered(memo.id), say(plain), end)
  const expected = { inputVersion: version, startupWork: true, reminderId: memo.id }
  assert.deepEqual(startup(events, scoped), expected)
  assert.equal(startup(history(marker(otherVersion), start, delivered(memo.id), say(plain), end), scoped), undefined)
  assert.equal(unfinishedEditDraft(events, scoped, 'old-assignment', canonicalReceipt), undefined)
  const write = result('1', 'project_edit', { written: true })
  assert.deepEqual(startup(history(marker(), start, delivered(memo.id), write, say(plain), end), scoped), expected)
  assert.equal(startup(history(marker(), start, delivered(memo.id), write, check('2', pass), say(plain), end), scoped), undefined)
})
