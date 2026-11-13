/**
 * The Host half's contract: one read-only route, resilient answers, and no
 * behaviour change when the profile has no web carrier.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PING_ROUTE, ROUTE, apply } from '../src/index.js';

function fakeHost(options = {}) {
  const handlers = new Map();
  const routes = new Map();
  const disposers = [];
  const subagents = options.subagents ?? {
    listChildren: async () => options.children ?? [],
  };
  const ctx = {
    on(name, listener) {
      handlers.set(name, listener);
      return () => handlers.delete(name);
    },
    effect(factory) {
      const dispose = factory();
      disposers.push(dispose);
      return () => {};
    },
    get(name) {
      if (name === 'webServer') {
        if (options.noWebServer === true) return undefined;
        return {
          register(route) {
            if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`);
            routes.set(route.path, route.resource);
            return () => routes.delete(route.path);
          },
        };
      }
      if (name === 'subagents') return subagents;
      return undefined;
    },
  };
  return { ctx, handlers, routes, disposers };
}

async function call(host, path) {
  const resource = host.routes.get(ROUTE) ?? host.routes.get(PING_ROUTE);
  assert.ok(resource !== undefined, 'route registered');
  const response = await resource(new Request(`http://127.0.0.1${path}`));
  return { status: response.status, body: await response.json(), headers: response.headers };
}

test('the route answers a snapshot plus the meta the contract cannot carry', async () => {
  const host = fakeHost();
  apply(host.ctx, {});
  assert.ok(host.routes.has(ROUTE));
  assert.ok(host.routes.has(PING_ROUTE));

  const ping = await call(host, PING_ROUTE);
  assert.equal(ping.body.ok, true);
  assert.equal(ping.body.version, 1);

  const empty = await call(host, `${ROUTE}?session=s1`);
  assert.equal(empty.status, 200);
  assert.equal(empty.body.ok, true);
  assert.equal(empty.body.snapshot.v, 1);
  assert.equal(empty.body.snapshot.aliasVersion, 1);
  assert.equal(empty.body.meta.sessionId, 's1');
  assert.equal(empty.body.meta.source, 'core');
  assert.equal(empty.body.meta.focusMode, true, 'focus mode defaults on');
  assert.equal(empty.body.meta, empty.body.meta);
  assert.equal(empty.headers.get('cache-control'), 'no-store');
  // The snapshot itself must stay inside the frozen schema: no extra keys.
  assert.deepEqual(Object.keys(empty.body.snapshot).sort(), ['agents', 'aliasVersion', 'events', 'eventsFromSeq', 'now', 'seq', 'stalledAfterMs', 'v']);
});

test('the focus-mode setting rides in meta and defaults on', async () => {
  const on = fakeHost();
  apply(on.ctx, {});
  const enabled = await call(on, `${ROUTE}?session=s1`);
  assert.equal(enabled.body.meta.focusMode, true);
  const pingOn = await call(on, PING_ROUTE);
  assert.equal(pingOn.body.focusMode, true);

  const off = fakeHost();
  apply(off.ctx, { focusMode: false });
  const disabled = await call(off, `${ROUTE}?session=s1`);
  assert.equal(disabled.body.meta.focusMode, false, 'an explicit false reaches the client');
  const pingOff = await call(off, PING_ROUTE);
  assert.equal(pingOff.body.focusMode, false);
  // Turning the field off must not change the wire format.
  assert.equal(disabled.body.snapshot.v, 1);
  assert.deepEqual(Object.keys(disabled.body.snapshot).sort(), Object.keys(enabled.body.snapshot).sort());
});

test('the focus-mode setting never accepts a truthy non-boolean', async () => {
  const host = fakeHost();
  apply(host.ctx, { focusMode: 'false' });
  const answer = await call(host, `${ROUTE}?session=s1`);
  assert.equal(answer.body.meta.focusMode, true, 'only an explicit false disables the field');
});

test('the route reflects live session events', async () => {
  const host = fakeHost();
  apply(host.ctx, {});
  const onEvent = host.handlers.get('session/event');
  const onStatus = host.handlers.get('agent/status');
  assert.ok(onEvent !== undefined);
  assert.ok(onStatus !== undefined);

  onEvent({ id: 's1' }, { type: 'turn/start', seq: 1, time: Date.parse('2026-11-12T03:20:00Z'), data: { turn: 1 } });
  onStatus({ agent: { id: 's1' }, status: 'running' });
  onEvent({ id: 's1' }, { type: 'tool/call', seq: 2, time: Date.parse('2026-11-12T03:20:01Z'), data: { callId: 'c1', name: 'read' } });

  const answer = await call(host, `${ROUTE}?session=s1`);
  assert.equal(answer.body.snapshot.agents[0].state, 'running');
  assert.equal(answer.body.snapshot.events.at(-1).tool, 'read');
  assert.equal(answer.body.meta.taskText, '');
});

test('a missing session is a clear 400, not an empty success', async () => {
  const host = fakeHost();
  apply(host.ctx, {});
  const answer = await call(host, ROUTE);
  assert.equal(answer.status, 400);
  assert.equal(answer.body.ok, false);
  assert.equal(answer.body.error, 'session-required');
});

test('children come from the subagent registry when it exists', async () => {
  const host = fakeHost({ children: [{ id: 'c-1', label: '核对' }] });
  apply(host.ctx, {});
  const answer = await call(host, `${ROUTE}?session=s1`);
  const children = answer.body.snapshot.agents.filter(agent => agent.id === 'c-1');
  assert.equal(children.length, 1);
  assert.equal(children[0].label, '核对');
  assert.equal(children[0].parentId, 's1');
});

test('a throwing registry still answers', async () => {
  const host = fakeHost({ subagents: { listChildren: async () => { throw new Error('nope'); } } });
  apply(host.ctx, {});
  const answer = await call(host, `${ROUTE}?session=s1`);
  assert.equal(answer.body.ok, true);
  assert.equal(answer.body.snapshot.agents.length, 1);
});

test('an unreachable orchestrator falls back to core events', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('offline');
  };
  try {
    const host = fakeHost();
    apply(host.ctx, { hudEndpoint: 'http://127.0.0.1:1/collab/api/runs/{session}/hud' });
    const answer = await call(host, `${ROUTE}?session=s1`);
    assert.equal(answer.body.meta.source, 'core');
  } finally {
    globalThis.fetch = original;
  }
});

test('without a web carrier the plugin activates and registers nothing', () => {
  const host = fakeHost({ noWebServer: true });
  assert.doesNotThrow(() => apply(host.ctx, {}));
  assert.equal(host.routes.size, 0);
  assert.ok(host.handlers.has('session/event'), 'the collector stays live for a later carrier');
});

test('routes are attached when the web carrier starts after the plugin', async () => {
  // An app restart can activate this row before `webServer` exists. Asking once
  // would leave the page with no route for the whole session — that is the
  // "HUD 未连接" that never cleared. Registration must wait for the service.
  const routes = new Map();
  const disposers = [];
  let server;
  const ctx = {
    on: () => () => {},
    effect(factory) {
      disposers.push(factory());
      return () => {};
    },
    get(name) {
      return name === 'webServer' ? server : undefined;
    },
  };
  apply(ctx, {});
  assert.equal(routes.size, 0, 'no carrier yet');

  server = {
    register(route) {
      routes.set(route.path, route.resource);
      return () => routes.delete(route.path);
    },
  };
  await new Promise(resolve => setTimeout(resolve, 260));
  assert.ok(routes.has(ROUTE), 'the snapshot route appears once the carrier is up');
  assert.ok(routes.has(PING_ROUTE));

  for (const dispose of disposers) {
    if (typeof dispose === 'function') dispose();
  }
  assert.equal(routes.size, 0, 'disposal removes both routes');
});

test('a disposed session is forgotten', async () => {
  const host = fakeHost();
  apply(host.ctx, {});
  host.handlers.get('session/event')({ id: 's1' }, { type: 'turn/start', seq: 1, time: Date.parse('2026-11-12T03:20:00Z'), data: { turn: 1 } });
  host.handlers.get('session/disposed')({ id: 's1' });
  const answer = await call(host, `${ROUTE}?session=s1`);
  assert.equal(answer.body.snapshot.events.length, 0);
});
