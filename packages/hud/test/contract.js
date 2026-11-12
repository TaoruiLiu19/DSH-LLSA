/**
 * Contract fixture access.
 *
 * The authoritative fixtures live in `contracts/fixtures/` next to this package
 * (the orchestrator owns them). A packaged copy without that directory skips the
 * replay instead of inventing expectations.
 */
import { existsSync, readFileSync } from 'node:fs';

const CONTRACTS = new URL('../../../contracts/', import.meta.url);

/** True when the repository's contracts directory is present. */
export const hasContracts = existsSync(new URL('hud-v1.schema.json', CONTRACTS));

/** Read one contract file as JSON. */
export function contractJson(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, CONTRACTS), 'utf8'));
}

/** The five replay fixtures, in a stable order. */
export const FIXTURE_NAMES = Object.freeze([
  'hud-normal',
  'hud-invalidated',
  'hud-restarted',
  'hud-stalled',
  'hud-attention',
]);

/** Load the replay fixtures, or an empty list when contracts are unavailable. */
export function loadFixtures() {
  if (!hasContracts) return [];
  return FIXTURE_NAMES.map(name => contractJson(`fixtures/${name}.json`));
}

/**
 * Rebase each frame's absolute `now` onto a local clock starting at zero, so the
 * model's fade maths behaves exactly as it does on `performance.now()`.
 *
 * @returns an array of `{ frame, clock }`.
 */
export function timeline(fixture) {
  const base = Date.parse(fixture.frames[0].now);
  return fixture.frames.map(frame => ({ frame, clock: Date.parse(frame.now) - base }));
}
