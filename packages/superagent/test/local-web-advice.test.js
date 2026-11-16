import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { captureTaskInput } from '../src/app/input-snapshot.ts'
import { localTrigger, LocalTaskConflict } from '../src/app/local-tasks.ts'
import { readResource } from '../src/app/resources.ts'
import { Runtime } from '../src/app/runtime.ts'
import { inputMessage, triggerMessage } from '../src/executor/dsh.ts'

const prompt = 'Keep the identifier "007". Tests were not run.'
const markdown = '# Web suggestion\nTests have passed. [Reference](https://example.invalid/)'
const input = { requestId: 'fixture-local-web-1', prompt, outputFormat: 'json',
  webConsultationEnabled: true, browserAdvice: markdown }

function fixture() {
  const triggers = new Map()
  const source = localTrigger(input, { triggers }, true)
  triggers.set(source.id, source)
  const ticket = { id: 'first', origin: { triggerId: source.id, triggerIds: [source.id] },
    assignments: [{ id: 'assignment' }], inputs: [] }
  return { source, ticket, triggers }
}

test('default-disabled native runtime rejects the opt-in and advertises no capability', () => {
  const triggers = new Map()
  const runtime = {
    machine: { localOnly: true }, configured: () => true, closing: () => false,
    store: { triggers, db: { prepare: () => ({ all: () => [] }) } },
    collabBridge: { snapshot: () => ({ tickets: [] }) },
    receive: trigger => triggers.set(trigger.id, trigger),
  }
  assert.equal(Runtime.prototype.localTasks.call(runtime).webConsultationProtocol, undefined)
  assert.throws(() => Runtime.prototype.submitLocal.call(runtime, input), /disabled on this host/)
  assert.equal(triggers.size, 0)

  runtime.machine.webCollaboration = true
  assert.equal(Runtime.prototype.localTasks.call(runtime).webConsultationProtocol, 1)
  const { browserAdvice: _advice, ...optIn } = input
  const accepted = Runtime.prototype.submitLocal.call(runtime, optIn)
  assert.equal(triggers.get(accepted.triggerId).meta.webConsultationEnabled, true)
  assert.equal(triggers.get(accepted.triggerId).meta.browserAdvice, undefined)
  assert.throws(() => Runtime.prototype.submitLocal.call(runtime, input), LocalTaskConflict)
})

test('keeps the source authoritative and hashes the advice without copying it into input snapshots', () => {
  const { source, ticket, triggers } = fixture()
  const snapshot = captureTaskInput(ticket, id => triggers.get(id))
  assert.equal(snapshot.content.sources[0].text, prompt)
  assert.equal(snapshot.content.sources[0].meta.outputFormat, 'json')
  assert.equal(snapshot.content.sources[0].meta.webConsultationEnabled, true)
  assert.equal(snapshot.content.sources[0].meta.browserAdviceSha256, createHash('sha256').update(markdown).digest('hex'))
  assert.ok(!snapshot.text.includes('Tests have passed'))
  const card = triggerMessage(source, {})
  assert.deepEqual(card.browser_advice, { read: `trigger/${source.id}/browser-advice`, trust: 'unverified' })
  assert.ok(!JSON.stringify(card).includes('Tests have passed'))
  assert.equal(localTrigger(input, { triggers }, true), source)
  assert.throws(() => localTrigger({ ...input, browserAdvice: '🔍'.repeat(1025) }, { triggers }, true), /4096 UTF-8 bytes/)
})

test('a context-only worker can read the source text without inheriting web opt-in or accessing advice', async () => {
  const { source, ticket, triggers } = fixture()
  const otherSource = localTrigger({ requestId: 'fixture-other-task', prompt: 'Different task' }, { triggers })
  triggers.set(otherSource.id, otherSource)
  const other = { id: 'other', origin: { triggerId: otherSource.id, triggerIds: [otherSource.id] },
    assignments: [{ id: 'other-assignment' }], inputs: [{ kind: 'trigger', triggerId: source.id, context: true }] }
  const host = { store: { triggers: { get: id => triggers.get(id), disposition: () => undefined },
    tickets: new Map([[ticket.id, ticket], [other.id, other]]), threads: new Map(), read: { neighbours: () => ({}) },
    replyStatus: () => undefined }, sourceLink: async () => ({}) }
  const resource = `trigger/${source.id}/browser-advice`
  const result = await readResource(host, resource, 0, 4000, ticket.id)
  assert.equal(result.text, markdown)
  assert.equal(result.trust, 'unverified')
  assert.equal(result.media_type, 'text/markdown')
  await assert.rejects(readResource(host, resource, 0, 4000, other.id), { code: 'notReached' })
  const generic = await readResource(host, `trigger/${source.id}`, 0, 4000, other.id)
  assert.equal(generic.text, prompt)
  assert.equal(generic.browser_advice, undefined)
  assert.equal(JSON.parse(inputMessage(other.inputs[0], triggerMessage(source, {}))).browser_advice, undefined)
  const { content } = captureTaskInput(other, id => triggers.get(id))
  assert.equal(content.sources[1].text, prompt)
  assert.equal(content.sources[1].meta.webConsultationEnabled, undefined)
  assert.equal(content.sources[1].meta.browserAdvice, undefined)
  assert.equal(content.sources[1].meta.browserAdviceSha256, undefined)
})
