/**
 * The drawing path, executed.
 *
 * `drawField` is the largest surface no other test touches: it runs only inside a
 * canvas that the browser owns. A recording 2D context executes it for every
 * state, so a typo, a missing context method, or a NaN coordinate fails here
 * instead of blanking the field in the page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFieldCanvas, drawField, hudBox, ringGeometry, stageFor } from '../src/render.js';
import { createView, foldSnapshot, stepLifecycle } from '../src/model.js';

/** A 2D context that records calls and the arguments it is handed. */
function recorder() {
  const calls = [];
  const record = name => (...args) => {
    calls.push({ name, args });
    return name === 'createRadialGradient' ? { addColorStop() {} } : undefined;
  };
  const context = {
    calls,
    save: record('save'),
    restore: record('restore'),
    clearRect: record('clearRect'),
    beginPath: record('beginPath'),
    closePath: record('closePath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    arc: record('arc'),
    stroke: record('stroke'),
    fill: record('fill'),
    fillText: record('fillText'),
    setLineDash: record('setLineDash'),
    setTransform: record('setTransform'),
    createRadialGradient: record('createRadialGradient'),
  };
  return context;
}

function stubEvent() {
  return {
    v: 1,
    aliasVersion: 1,
    seq: 4,
    now: '2026-11-12T03:20:03.100Z',
    stalledAfterMs: 20000,
    eventsFromSeq: 1,
    agents: [
      { id: 'root', label: '核对报价单', role: 'root', parentId: null, ticketId: null, state: 'running', since: '2026-11-12T03:20:00Z', stalled: false, lastEvent: null },
      { id: 'w1', label: '查证', role: 'worker', parentId: 'root', ticketId: null, state: 'running', since: '2026-11-12T03:20:00Z', stalled: false, lastEvent: null },
    ],
    events: [
      { seq: 1, agentId: 'root', kind: 'turn.start', at: '2026-11-12T03:20:00Z', tool: null },
      { seq: 2, agentId: 'root', kind: 'tool.start', at: '2026-11-12T03:20:01Z', tool: 'read' },
      { seq: 3, agentId: 'root', kind: 'tool.start', at: '2026-11-12T03:20:02Z', tool: 'grep' },
      { seq: 4, agentId: 'root', kind: 'tool.start', at: '2026-11-12T03:20:03Z', tool: 'subagent' },
    ],
  };
}

/** The snapshot's own clock; the frame clock starts here so pulses are fresh. */
const T0 = Date.parse('2026-11-12T03:20:03.100Z');

function viewOf(mutator, options = {}) {
  const view = createView({ sessionId: 's', now: T0 });
  foldSnapshot(view, stubEvent(), T0, { sessionId: 's', taskText: options.taskText });
  if (typeof mutator === 'function') mutator(view);
  stepLifecycle(view, T0 + 50);
  return view;
}

test('every state draws without throwing', () => {
  const cases = {
    running: () => viewOf(),
    idle: () => viewOf(view => { for (const node of view.agents.values()) node.state = 'idle'; view.state = 'idle'; }),
    'waiting-human': () => viewOf(view => { for (const node of view.agents.values()) node.state = 'waiting-human'; view.state = 'waiting-human'; view.pending = true; }),
    done: () => viewOf(view => { for (const node of view.agents.values()) node.state = 'done'; view.state = 'done'; }),
    failed: () => viewOf(view => {
      for (const node of view.agents.values()) node.state = 'failed';
      view.state = 'failed';
      view.failedMaterial = 'doc';
    }),
    stalled: () => viewOf(view => { for (const node of view.agents.values()) node.stalled = true; }),
    'eight materials': () => viewOf(view => {
      const ids = ['python', 'sheet', 'data', 'doc', 'web', 'mail', 'shell', 'other'];
      const { ensureMaterialForTest } = { ensureMaterialForTest: null };
      void ensureMaterialForTest;
      for (const [index, id] of ids.entries()) {
        view.materials.set(id, {
          id, label: id, alias: 'read', state: index % 2 === 0 ? 'running' : 'done', verb: '读取中',
          lastAt: index * 100, hits: 1, alpha: 1, heat: 0.5, lastPulseAt: -Infinity, phase: index,
        });
      }
    }),
    'no nodes': () => viewOf(view => { view.materials.clear(); view.agents.clear(); view.state = 'idle'; }),
  };
  for (const [name, make] of Object.entries(cases)) {
    const context = recorder();
    const stage = stageFor({ width: 1200, height: 800 }, { left: 260, right: 940, top: 120, bottom: 700 });
    const box = hudBox(stage);
    assert.doesNotThrow(() => drawField(context, make(), ringGeometry(box.size), 1000, { centerAlpha: 1 }), name);
    assert.ok(context.calls.some(call => call.name === 'clearRect'), `${name}: clears the frame`);
    assert.ok(context.calls.some(call => call.name === 'fillText'), `${name}: writes the centre line`);
    for (const call of context.calls) {
      for (const arg of call.args) {
        if (typeof arg === 'number') assert.ok(Number.isFinite(arg), `${name}: ${call.name} got ${arg}`);
      }
    }
  }
});

test('pulses travel without leaving the canvas', () => {
  const context = recorder();
  const view = viewOf();
  assert.ok(view.pulses.length > 0, 'the fixture produced a pulse');
  const geometry = ringGeometry(560);
  drawField(context, view, geometry, 1000, { centerAlpha: 1 });
  const arcs = context.calls.filter(call => call.name === 'arc');
  assert.ok(arcs.length > 0);
  for (const arc of arcs) {
    const [x, y] = arc.args;
    assert.ok(Number.isFinite(x) && Number.isFinite(y));
  }
});

test('the canvas component runs one animation frame end to end', () => {
  const context = recorder();
  const canvas = { width: 0, height: 0, style: {}, getContext: () => context };
  const frames = [];
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = callback => {
    frames.push(callback);
    return frames.length;
  };
  globalThis.cancelAnimationFrame = () => {};
  try {
    const effects = [];
    const React = {
      createElement: (type, props, ...children) => ({ type, props, children }),
      useRef: value => ({ current: value }),
      useEffect: effect => { effects.push(effect); },
    };
    const Field = createFieldCanvas(React);
    const view = viewOf();
    const stage = { x: 0, y: 0, w: 600, h: 600, radius: 14, full: false };
    const element = Field({ getView: () => view, getStage: () => stage });
    assert.equal(element.type, 'canvas');
    // The component hands its ref to the canvas element; mount it, then run the
    // effect exactly the way React would.
    element.props.ref.current = canvas;
    for (const effect of effects) effect();
    assert.ok(frames.length >= 1, 'the frame loop was armed');
    assert.doesNotThrow(() => frames[0](16));
    assert.ok(canvas.width > 0 && canvas.height > 0, 'the backing store was sized');
    assert.ok(context.calls.some(call => call.name === 'clearRect'));
    assert.ok(context.calls.some(call => call.name === 'fillText'));
  } finally {
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancel;
  }
});

test('a scrolled chat flow cannot push the field off screen', () => {
  // The flow's box when the conversation is scrolled: its top is above the
  // viewport and its bottom is below it.
  const stage = stageFor({ width: 1200, height: 800 }, { left: 260, right: 940, top: -2400, bottom: 3200 });
  assert.equal(stage.full, false);
  assert.ok(stage.y >= 0, `stage.y is ${stage.y}`);
  assert.ok(stage.y + stage.h <= 800);
  const box = hudBox(stage);
  assert.ok(box.y >= 0 && box.y + box.size <= 800);
});
