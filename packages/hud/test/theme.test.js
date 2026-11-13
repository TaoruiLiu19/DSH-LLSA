/**
 * The field follows the host's own surface (§11 of the v0.4 spec).
 *
 * The shell may follow the OS, a profile setting or a per-session override, so
 * the palette is chosen from the *painted* background rather than from a theme
 * API — and a dark field on a light window must not be reachable by accident.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THEMES, colorOf, paletteOf } from '../src/materials.js';
import { luminanceOf, measureTheme, themeNameFor } from '../src/focus.js';

test('a bright surface picks the light palette, a dark one keeps the dark palette', () => {
  assert.equal(themeNameFor(1), 'light');
  assert.equal(themeNameFor(0.53), 'light');
  assert.equal(themeNameFor(0.5), 'dark', 'the threshold itself is dark');
  assert.equal(themeNameFor(0.02), 'dark');
  assert.equal(themeNameFor(Number.NaN), 'dark');
  assert.equal(themeNameFor(undefined), 'dark');
});

test('luminance reads computed colours and treats transparent as unknown', () => {
  assert.equal(luminanceOf('rgba(0, 0, 0, 0)'), null);
  assert.equal(luminanceOf('transparent'), null);
  assert.equal(luminanceOf(''), null);
  assert.equal(luminanceOf(undefined), null);
  assert.ok(Math.abs(luminanceOf('rgb(255, 255, 255)') - 1) < 1e-6);
  assert.ok(luminanceOf('rgb(11, 13, 18)') < 0.01);
  // A pale grey surface is still "light".
  assert.ok(luminanceOf('rgb(248, 249, 252)') > 0.5);
});

test('the light palette is genuinely light: dark ink, deeper accents, weaker glow', () => {
  const mean = css => {
    const parts = css.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/).slice(1, 4).map(Number);
    return (parts[0] + parts[1] + parts[2]) / 3;
  };
  assert.ok(mean(THEMES.light.ink) < 80, 'light ink must be dark');
  assert.ok(mean(THEMES.dark.ink) > 180, 'dark ink must be light');
  assert.ok(THEMES.light.glowScale < THEMES.dark.glowScale, 'a glow smears on white');
  assert.ok(THEMES.light.lineScale > THEMES.dark.lineScale, 'a thin line needs more alpha on white');
  assert.notEqual(colorOf('running', 'light'), colorOf('running', 'dark'));
  assert.equal(colorOf('nonsense', 'light'), THEMES.light.colors.idle);
  assert.equal(colorOf('running'), '#4c9aff', 'the default stays the dark palette');
  assert.ok(paletteOf('nope') === THEMES.dark, 'an unknown theme degrades to dark');
});

test('without a document the theme is dark, never a throw', () => {
  assert.equal(measureTheme(null), 'dark');
  assert.equal(measureTheme(undefined), 'dark');
});
