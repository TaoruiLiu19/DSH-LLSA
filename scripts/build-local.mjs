/** Bundles share the root Harness dependency tree; package dev installs are not runtime hosts. */
import { rolldown } from 'rolldown';
import { mkdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const assetsPath = resolve(root, 'packages/dsh-collab/src/text-assets.js');
const assets = await import(pathToFileURL(assetsPath).href);
const inlineAssets = {
  name: 'inline-collab-assets',
  load(id) {
    if (resolve(id) !== assetsPath) return null;
    return Object.entries(assets).map(([name, value]) => `export const ${name} = ${JSON.stringify(value)};`).join('\n');
  },
};
for (const [input, output] of [
  ['packages/dsh-collab/src/index.js', 'collab.js'],
  ['packages/superagent/src/index.ts', 'superagent.js'],
  ['packages/launcher/src/start.ts', 'start.js'],
]) {
  const bundle = await rolldown({ input: resolve(root, input), plugins: [inlineAssets], external: id => !id.startsWith('.') && !id.startsWith('/') && !/^[A-Za-z]:/.test(id) });
  await bundle.write({ file: resolve(root, 'dist', output), format: 'esm', sourcemap: false, minify: false });
  await bundle.close();
}
const csvDist = resolve(root, 'dist/csv-engine');
await mkdir(csvDist, { recursive: true });
for (const name of ['csv_core.py', 'csv_pipeline.py', 'run_workflow.py']) {
  await copyFile(resolve(root, 'packages/dsh-collab/csv-engine', name), resolve(csvDist, name));
}
