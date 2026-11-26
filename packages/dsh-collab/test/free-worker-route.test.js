import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshBackend } from '../src/dsh-adapter.js';
import { LOCAL_CHILD_PROVIDER } from '../src/local-child-model.js';
import { connectSuperagent } from '../src/superagent-integration.js';

const route = { provider: LOCAL_CHILD_PROVIDER, model: 'local-fixture' };
function backendFixture(configured = true) {
  let selection = { ...route };
  const agent = { options: { ...route }, model: { current: () => selection } };
  const ctx = { agents: new Map([['worker', agent], ['master', agent], ['child', agent]]),
    llm: { registerAdapter() {} } };
  const backend = createDshBackend(ctx, {}, configured ? {
    localChildModel: { baseURL: 'http://127.0.0.1:48825/v1', model: route.model },
  } : {});
  return { backend, agent, ctx, select(value) { selection = value; } };
}

test('free native routing uses live exact selection and actual request pair, never stale options', () => {
  const f = backendFixture();
  assert.equal(f.backend.isLiveFreeRoute('worker'), true);
  assert.equal(f.backend.isLiveFreeRoute('worker', route.provider, route.model), true);
  for (const [provider, model] of [['official', route.model], [route.provider, 'other'],
    [route.provider, undefined], [undefined, route.model], [null, null]]) {
    assert.equal(f.backend.isLiveFreeRoute('worker', provider, model), false);
  }
  for (const selection of [null, {}, { provider: route.provider }, { ...route, provider: 'official' },
    { ...route, model: 'other' }, Promise.resolve(route)]) {
    f.select(selection);
    assert.equal(f.backend.isLiveFreeRoute('worker'), false);
    assert.equal(f.backend.isLiveFreeRoute('worker', route.provider, route.model), false);
  }
  f.select(route);
  assert.equal(f.backend.isLiveFreeRoute('worker'), true);
  f.agent.model.current = () => { throw new Error('unresolved'); };
  assert.equal(f.backend.isLiveFreeRoute('worker'), false);
  delete f.agent.model;
  assert.equal(f.backend.isLiveFreeRoute('worker'), false);
  assert.equal(f.backend.isLiveFreeRoute('missing'), false);
  assert.equal(backendFixture(false).backend.isLiveFreeRoute('worker'), false);
});

function integrationFixture(configured = true, supportsRoute = true) {
  const f = backendFixture(configured);
  const ticket = { id: 'ticket', assignments: [{ id: 'assignment' }] };
  const snapshot = { masterSessionId: 'master', tickets: [
    { ticket, workerSessionId: 'worker', assignmentId: 'assignment' },
  ] };
  let verifier, releases = 0, lifecycleReleases = 0;
  const bridge = {
    compatibility: () => ({ apiVersion: 3 }), snapshot: () => snapshot,
    registerLifecycle: () => () => { lifecycleReleases++; },
    ...(supportsRoute ? { registerFreeWorkerRoute(callback) {
      verifier = callback;
      return () => { verifier = undefined; releases++; };
    } } : {}),
  };
  const manager = { backend: f.backend, store: { getRun: () => undefined }, toolPolicies: new Map(),
    binding: () => undefined, bindRoot() {},
    setToolPolicy(id, tools) { this.toolPolicies.set(id, tools); } };
  const integration = connectSuperagent(manager, bridge);
  return { ...f, ticket, snapshot, bridge, integration, manager,
    verify: (...args) => verifier?.(...args),
    registered: () => Boolean(verifier), releases: () => [releases, lifecycleReleases] };
}

test('bridge route registration admits only live native workers and unregisters on disposal', () => {
  const f = integrationFixture();
  assert.equal(f.registered(), true);
  assert.equal(f.verify('worker'), true);
  assert.equal(f.verify('worker', route.provider, route.model), true);
  assert.equal(f.verify('master'), false);
  assert.equal(f.verify('child'), false);
  assert.equal(f.verify('worker', 'official', route.model), false);
  f.select({ ...route, provider: 'official' });
  assert.equal(f.verify('worker', route.provider, route.model), false);
  f.select(route);
  f.ticket.ended = true;
  assert.equal(f.verify('worker'), false);
  delete f.ticket.ended;
  f.ticket.assignments.push({ id: 'replacement' });
  assert.equal(f.verify('worker'), false);
  f.snapshot.tickets[0].assignmentId = 'replacement';
  assert.equal(f.verify('worker'), true);
  f.snapshot.masterSessionId = 'worker';
  assert.equal(f.verify('worker'), false);
  f.snapshot.masterSessionId = 'master';
  f.bridge.snapshot = () => { throw new Error('bridge unavailable'); };
  assert.equal(f.verify('worker'), false);
  f.integration.dispose();
  assert.deepEqual(f.releases(), [1, 1]);
  assert.equal(f.registered(), false);
  assert.equal(f.manager.toolPolicies.has('master'), false);
});

test('unconfigured routes and older bridges do not register automatic native routing', () => {
  for (const [configured, supported] of [[false, true], [true, false]]) {
    const f = integrationFixture(configured, supported);
    assert.equal(f.registered(), false);
    f.integration.dispose();
    assert.deepEqual(f.releases(), [0, 1]);
  }
});
