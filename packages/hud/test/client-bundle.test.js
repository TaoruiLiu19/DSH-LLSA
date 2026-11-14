/**
 * The committed browser artifact must be exactly what the sources produce.
 *
 * A stale `client.js` would ship code nobody tests, so the check is a byte
 * comparison against a fresh build — not a spot check.
 */
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAliasTable, buildBundle } from '../scripts/build-client.mjs';

const clientPath = new URL('../client.js', import.meta.url);
const aliasesPath = new URL('../data/tool-aliases-v1.json', import.meta.url);
const client = readFileSync(clientPath, 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('client.js is up to date with src/', () => {
  assert.equal(client, buildBundle(), 'run `npm run build` in packages/hud');
});

test('the published alias table is up to date with src/', async () => {
  assert.equal(readFileSync(aliasesPath, 'utf8'), await buildAliasTable());
});

test('the artifact is a classic module-loader factory, not an ES module', () => {
  assert.match(client, /^\/\/ @dsh-llsa\/hud — browser half\. GENERATED/m);
  assert.match(client, /window\.__ModuleLoader__\.load\(\{/);
  assert.match(client, new RegExp(`id: ${JSON.stringify(packageJson.name)}`));
  assert.match(client, /factory\(require\)/);
  assert.match(client, /const React = require\('react'\)/);
  assert.ok(!/^\s*import\s/m.test(client), 'no top-level import statement may survive');
  assert.ok(!/^\s*export\s/m.test(client), 'no top-level export statement may survive');
});

test('the bundle registers both seats and exports the plugin shape', () => {
  assert.match(client, /'shell\.overlay'/);
  assert.match(client, /'conversation\.input\.dock'/);
  assert.match(client, /inject: \['slots'\]/);
  assert.match(client, /applyClient\(ctx, React\)/);
  // The factory body must compile; it is never executed here.
  assert.doesNotThrow(() => new Function(client));
});

test('the manifest wires the patch, the client half and the display resources', () => {
  assert.equal(packageJson.name, '@dsh-llsa/hud');
  assert.equal(packageJson.version, '0.4.4');
  assert.equal(packageJson.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(packageJson.dsh.client.platform, 'web');
  assert.equal(packageJson.exports['.'], './src/index.js');
  assert.equal(packageJson.exports['./client'], './client.js');
  assert.ok(packageJson.exports['./locale/*.json'] !== undefined);
  assert.ok(packageJson.exports['./icon'] !== undefined);
  for (const entry of ['src', 'client.js', 'data', 'cordis.patch.yml', 'icon.svg', 'locale/*.json']) {
    assert.ok(packageJson.files.includes(entry), `files must ship ${entry}`);
  }
  // §3: no dependency on the orchestrator, and no dependencies at all.
  const forbidden = ['dsh-collab', '@dsh-llsa/collab', 'superagent', 'launcher'];
  const declared = Object.keys({ ...packageJson.dependencies, ...packageJson.peerDependencies });
  for (const name of forbidden) {
    assert.ok(!declared.some(entry => entry.includes(name)), `must not depend on ${name}`);
  }
  assert.equal(packageJson.dependencies, undefined);
});

test('the bundle stays small enough to load on every page', () => {
  assert.ok(client.length < 200_000, `client.js is ${client.length} bytes`);
});
