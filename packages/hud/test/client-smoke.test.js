/**
 * End-to-end smoke test of the committed browser artifact.
 *
 * The bundle is evaluated the way the module loader does it — a classic script
 * that calls `window.__ModuleLoader__.load` — with a stub React and a stub
 * client context. That catches the failures a syntax check cannot: a broken
 * factory, a missing export, a slot registered under the wrong name, or an
 * `apply` that throws before the first render.
 */
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const bundle = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

/** Just enough React for module scope and `apply` (no component is rendered). */
function stubReact() {
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: Symbol('Fragment'),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useRef: value => ({ current: value }),
    useCallback: callback => callback,
    useMemo: factory => factory(),
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  };
  return React;
}

function loadBundle() {
  const calls = [];
  const window = { __ModuleLoader__: { load: registration => calls.push(registration) } };
  // The bundle is a classic script: evaluating it only registers the factory.
  new Function('window', bundle)(window);
  assert.equal(calls.length, 1, 'exactly one loader registration');
  return calls[0];
}

function fakeContext() {
  const slots = [];
  const injected = [];
  const ctx = {
    slots: {
      inject(key, callback) {
        injected.push(key);
        callback();
        return () => {};
      },
      register(options, component) {
        slots.push({ options, component });
        return () => {};
      },
    },
    get: () => undefined,
    on: () => () => {},
    effect: factory => {
      factory();
      return () => {};
    },
  };
  return { ctx, slots, injected };
}

test('the bundle registers the plugin shape the loader expects', () => {
  const registration = loadBundle();
  assert.equal(registration.id, '@dsh-llsa/hud');
  assert.equal(typeof registration.factory, 'function');
  assert.ok(Array.isArray(registration.inject) === false, 'inject lives on the plugin, not the factory');
});

test('apply registers both seats without throwing', () => {
  const registration = loadBundle();
  const React = stubReact();
  const api = registration.factory(spec => {
    if (spec === 'react') return React;
    throw new Error(`unexpected module request: ${spec}`);
  });
  assert.deepEqual(api.inject, ['slots']);
  assert.equal(typeof api.apply, 'function');

  const { ctx, slots, injected } = fakeContext();
  assert.doesNotThrow(() => api.apply(ctx));
  assert.deepEqual(injected, ['shell.overlay', 'conversation.input.dock']);
  assert.deepEqual(slots.map(entry => entry.options.id), ['hud:focus', 'hud:session']);
  assert.deepEqual(slots.map(entry => entry.options.name), ['shell.overlay', 'conversation.input.dock']);
  for (const entry of slots) assert.equal(typeof entry.component, 'function');
});

test('the overlay renders only its stylesheet on an idle field', () => {
  const registration = loadBundle();
  const React = stubReact();
  const api = registration.factory(spec => {
    if (spec === 'react') return React;
    throw new Error(`unexpected module request: ${spec}`);
  });
  const { ctx, slots } = fakeContext();
  api.apply(ctx);
  const Overlay = slots[0].component;
  const element = Overlay({});
  assert.equal(element.type, React.Fragment, 'the stylesheet must stay mounted for the capsule');
  const visible = element.children.filter(child => child !== null && child !== undefined);
  assert.equal(visible.length, 1, 'nothing but the stylesheet');
  assert.equal(visible[0].type, 'style');
  assert.match(String(visible[0].children.join('')), /\.dsh-hud-capsule/);
});
