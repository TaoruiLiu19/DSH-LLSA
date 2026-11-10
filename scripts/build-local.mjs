/** Bundles share the root Harness dependency tree; package dev installs are not runtime hosts. */
import { rolldown } from 'rolldown';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
for (const [input, output] of [
  ['packages/dsh-collab/src/index.js', 'collab.js'],
  ['packages/superagent/src/index.ts', 'superagent.js'],
  ['packages/launcher/src/start.ts', 'start.js'],
]) {
  const bundle = await rolldown({ input: resolve(root, input), external: id => !id.startsWith('.') && !id.startsWith('/') && !/^[A-Za-z]:/.test(id) });
  await bundle.write({ file: resolve(root, 'dist', output), format: 'esm', sourcemap: false, minify: false });
  await bundle.close();
}
