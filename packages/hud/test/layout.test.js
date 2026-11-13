/**
 * Geometry of §4.5 — the two layout tiers — plus the ring seats.
 *
 * This is the only place the stage rule is asserted: both side panels open means
 * the scrim is the message column (rounded, HUD at 90%); either one collapsed
 * means the whole window (square, HUD at 97%).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUD_SCALE, RINGS, STAGE_RADIUS, capsuleBox, hudBox, labelAnchor, ringGeometry, seatAngles, seatPoint, stageFor } from '../src/render.js';
import { STAGE_TRANSITION, STYLES } from '../src/focus.js';

const viewport = { width: 1440, height: 900 };
const column = { left: 264, right: 1120, top: 120, bottom: 760 };

test('both panels open: the scrim is the message column, rounded', () => {
  const stage = stageFor(viewport, column);
  assert.equal(stage.full, false);
  assert.deepEqual(stage, { x: 264, y: 120, w: 856, h: 640, radius: STAGE_RADIUS, full: false });
  const box = hudBox(stage);
  assert.equal(box.size, Math.round(640 * HUD_SCALE.column));
  assert.equal(box.x, 264 + Math.round((856 - box.size) / 2));
  assert.equal(box.y, 120 + Math.round((640 - box.size) / 2));
});

test('the left panel collapsed makes the stage the whole window, square', () => {
  const stage = stageFor(viewport, { ...column, left: 0 });
  assert.equal(stage.full, true);
  assert.deepEqual(stage, { x: 0, y: 0, w: 1440, h: 900, radius: 0, full: true });
  assert.equal(hudBox(stage).size, Math.round(900 * HUD_SCALE.windowed));
});

test('the right panel collapsed makes the stage the whole window, square', () => {
  const stage = stageFor(viewport, { ...column, right: viewport.width });
  assert.equal(stage.full, true);
  assert.equal(stage.radius, 0);
});

test('an unmeasured or degenerate column falls back to the window', () => {
  assert.equal(stageFor(viewport, null).full, true);
  assert.equal(stageFor(viewport, undefined).full, true);
  assert.equal(stageFor(viewport, { left: 600, right: 620, top: 100, bottom: 700 }).full, true, 'too narrow to read');
  assert.equal(stageFor({ width: 0, height: 0 }, column).w, 0);
});

test('the capsule parks inside the message area, clear of the composer', () => {
  const stage = stageFor(viewport, column);
  const box = capsuleBox(stage, { width: 132, height: 34 });
  assert.equal(box.x, 264 + 856 - 132 - 18);
  assert.equal(box.y, 120 + 640 - 34 - 16);
  assert.ok(box.y + box.height <= stage.y + stage.h);
  assert.ok(box.x + box.width <= stage.x + stage.w);
  // Tiny stages clamp instead of pushing the capsule off-screen.
  const tiny = capsuleBox({ x: 10, y: 10, w: 100, h: 40, radius: 0, full: false }, { width: 132, height: 34 });
  assert.equal(tiny.x, 18);
});

test('rings and seats are deterministic', () => {
  const geometry = ringGeometry(560);
  assert.equal(geometry.cx, 280);
  assert.equal(geometry.material, 560 * RINGS.material);
  assert.equal(geometry.agent, 560 * RINGS.agent);
  assert.equal(geometry.k, 1);

  const angles = seatAngles(8);
  assert.equal(angles.length, 8);
  assert.ok(Math.abs(angles[0] - -Math.PI / 2) < 1e-9, 'the first seat is at twelve o’clock');
  for (let index = 1; index < angles.length; index += 1) {
    assert.ok(angles[index] > angles[index - 1], 'seats keep a stable order');
  }
  assert.deepEqual(seatAngles(0), []);

  const point = seatPoint(geometry, -Math.PI / 2, 100);
  assert.ok(Math.abs(point.x - 280) < 1e-9);
  assert.ok(Math.abs(point.y - 180) < 1e-9);

  assert.equal(labelAnchor(0), 'left');
  assert.equal(labelAnchor(Math.PI), 'right');
  assert.equal(labelAnchor(-Math.PI / 2), 'center');
});

test('the focus layer carries the documented transition and blur', () => {
  assert.match(STAGE_TRANSITION, /\.26s/);
  assert.match(STYLES, /\.dsh-hud-scrim/);
  assert.match(STYLES, /blur\(11px\)/);
  assert.match(STYLES, /rgba\(6,9,14,\.45\)/);
  assert.match(STYLES, /\.dsh-hud-capsule/);
});
