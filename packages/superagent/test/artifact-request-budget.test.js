import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { localArtifactRequestOptions } from '../src/app/runtime.ts'

const directory = resolve('ticket-files')
const stateDir = resolve('orchestrator-state')
const config = Object.freeze({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' })

function fixture() {
  const ticket = { assignments: [{ id: 'current', state: 'running' }] }
  const worker = { id: 'worker-local', session: { id: 'worker-local', header: { cwd: directory } } }
  const host = { masterId: 'worker-master', machine: { localOnly: true, stateDir },
    store: { tickets: { get: id => id === 'local' ? ticket : undefined } },
    collabBridge: { localArtifactWorkspace: id => id === 'local' ? { directory } : undefined } }
  return { worker, ticket, host }
}

test('a live native workspace worker sets the provider output ceiling without changing model or effort', () => {
  const { worker, host } = fixture()
  assert.deepEqual(localArtifactRequestOptions(host, worker, config), { ...config, maxTokens: 8192 })
  assert.deepEqual(localArtifactRequestOptions(host, worker, { ...config, maxTokens: 256000 }), { ...config, maxTokens: 8192 })
  const lower = { ...config, maxTokens: 1024 }
  assert.strictEqual(localArtifactRequestOptions(host, worker, lower), lower)
})

test('other sessions, stale assignments, and other workspaces keep their request controls', () => {
  const { worker, ticket, host } = fixture()
  assert.strictEqual(localArtifactRequestOptions({ ...host, masterId: worker.id }, worker, config), config)
  assert.strictEqual(localArtifactRequestOptions(host, { ...worker, id: 'chat' }, config), config)
  assert.strictEqual(localArtifactRequestOptions(host, { ...worker, session: { ...worker.session, id: 'unmatched' } }, config), config)
  assert.strictEqual(localArtifactRequestOptions(host, { ...worker, session: { ...worker.session, header: { cwd: resolve('another') } } }, config), config)
  ticket.assignments.push({ id: 'next', state: 'pending' })
  assert.strictEqual(localArtifactRequestOptions(host, worker, config), config)
  ticket.assignments.pop()
  host.collabBridge.localArtifactWorkspace = () => undefined
  assert.strictEqual(localArtifactRequestOptions(host, worker, config), config)
})

test('only the dedicated local coordinator receives the coordinator output ceiling', () => {
  const { host } = fixture()
  const coordinator = { id: host.masterId, session: { id: host.masterId, header: { cwd: stateDir } } }
  const large = { ...config, maxTokens: 256000 }
  const lower = { ...config, maxTokens: 2048 }
  assert.deepEqual(localArtifactRequestOptions(host, coordinator, config), { ...config, maxTokens: 16384 })
  assert.deepEqual(localArtifactRequestOptions(host, coordinator, large), { ...large, maxTokens: 16384 })
  assert.strictEqual(localArtifactRequestOptions(host, coordinator, lower), lower)
  assert.strictEqual(localArtifactRequestOptions(host, { ...coordinator, session: { ...coordinator.session, id: 'chat' } }, large), large)
  assert.strictEqual(localArtifactRequestOptions({ ...host, machine: { ...host.machine, localOnly: false } }, coordinator, large), large)
})
