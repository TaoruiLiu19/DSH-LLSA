/**
 * Stage measurement against a fake shell.
 *
 * The real failure this pins: slot hosts render as `display: contents`, so their
 * own box is 0×0. A resolver that measures the host itself finds nothing, falls
 * back to "whole window", and the scrim blurs the side panels too. The resolver
 * must walk up to the first ancestor that paints, and read the composer's top
 * edge so the composer stays sharp.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureStage } from '../src/focus.js';

/** A minimal element: a box, a display, a parent. */
function element(box, options = {}) {
  const node = {
    display: options.display ?? 'block',
    parentElement: options.parent ?? null,
    getBoundingClientRect: () => (box === null ? { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } : box),
  };
  node.ownerDocument = { defaultView: { getComputedStyle: target => ({ display: target.display }) } };
  return node;
}

function box(left, top, right, bottom) {
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

/** Build `root > column > [flowWrap > flowHost, composerWrap > composerHost]`. */
function shell() {
  const column = element(box(260, 60, 1060, 840), { display: 'flex' });
  const flowWrap = element(box(260, 120, 1060, 780), { parent: column });
  const flowHost = element(null, { parent: flowWrap, display: 'contents' });
  const composerWrap = element(box(260, 780, 1060, 840), { parent: column });
  const composerHost = element(null, { parent: composerWrap, display: 'contents' });
  const sessionHost = element(null, { parent: column, display: 'contents' });
  const slots = new Map([
    ['conversation.session', sessionHost],
    ['conversation.chat.flow', flowHost],
    ['conversation.composer.bar', composerHost],
  ]);
  const doc = {
    defaultView: { innerWidth: 1400, innerHeight: 900 },
    querySelector(selector) {
      const match = /data-slot="([^"]+)"/.exec(selector);
      if (match === null) return null;
      return slots.get(match[1]) ?? null;
    },
  };
  return doc;
}

test('both panels open: the stage is the message column, not the window', () => {
  const stage = measureStage(shell());
  assert.equal(stage.full, false, 'the scrim must not cover the side panels');
  assert.deepEqual(stage, { x: 260, y: 120, w: 800, h: 660, radius: 14, full: false });
});

test('the composer edge caps the stage, so the composer stays sharp', () => {
  const stage = measureStage(shell());
  assert.equal(stage.y + stage.h, 780, 'bottom stops at the composer’s top');
});

test('an older host that only exposes conversation.view still measures', () => {
  const doc = shell();
  const column = element(box(0, 60, 1400, 840), { display: 'flex' });
  const host = element(null, { parent: column, display: 'contents' });
  const slots = new Map([['conversation.view', host]]);
  doc.querySelector = selector => {
    const match = /data-slot="([^"]+)"/.exec(selector);
    return match === null ? null : slots.get(match[1]) ?? null;
  };
  const stage = measureStage(doc);
  assert.equal(stage.full, true, 'a column flush with both edges means a collapsed panel');
  assert.equal(stage.w, 1400);
});

test('nothing measurable falls back to the whole window', () => {
  const doc = {
    defaultView: { innerWidth: 1400, innerHeight: 900 },
    querySelector: () => null,
  };
  const stage = measureStage(doc);
  assert.deepEqual(stage, { x: 0, y: 0, w: 1400, h: 900, radius: 0, full: true });
});

test('a host with no document still answers a valid stage', () => {
  const stage = measureStage(null);
  assert.equal(stage.full, true);
  assert.equal(Number.isFinite(stage.w), true);
});
