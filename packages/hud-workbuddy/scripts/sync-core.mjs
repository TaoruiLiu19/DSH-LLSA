/**
 * Copy the host-independent HUD core into this plugin and fingerprint it.
 *
 * `core/` is a generated directory. Edit the source in ../hud/src, never here.
 * --check verifies the copy without writing, for tests and CI.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = resolve(ROOT, '../hud');
const TARGET = join(ROOT, 'core');

/** source path -> generated name. Both sources share one flat directory. */
const FILES = Object.freeze({
  'src/model.js': 'model.js',
  'src/materials.js': 'materials.js',
  'src/labels.js': 'labels.js',
  'src/render.js': 'render.js',
  'data/tool-aliases-v1.json': 'tool-aliases-v1.json',
});

const checkOnly = process.argv.includes('--check');
const fingerprint = text => createHash('sha256').update(text).digest('hex').slice(0, 16);

const payloads = new Map();
for (const [from, to] of Object.entries(FILES)) {
  const path = join(SOURCE, from);
  try {
    payloads.set(to, readFileSync(path, 'utf8'));
  } catch (error) {
    console.error(`sync-core: cannot read source ${path}: ${error.message}`);
    process.exit(1);
  }
}

const manifestLines = Object.entries(FILES).map(([from, to]) => `  ${to} <- ../hud/${from}  ${fingerprint(payloads.get(to))}`);
const manifest = {
  generated: true,
  source: '../hud',
  files: Object.fromEntries([...payloads].map(([name, text]) => [name, `sha256:${fingerprint(text)}`])),
};

if (checkOnly) {
  let bad = 0;
  for (const [name, expected] of Object.entries(manifest.files)) {
    let actual = null;
    try {
      actual = `sha256:${fingerprint(readFileSync(join(TARGET, name), 'utf8'))}`;
    } catch {
      actual = 'missing';
    }
    if (actual !== expected) {
      console.error(`sync-core: ${name} is ${actual}, expected ${expected}. Run npm run sync.`);
      bad += 1;
    }
  }
  try {
    const onDisk = JSON.parse(readFileSync(join(TARGET, '.manifest.json'), 'utf8'));
    if (onDisk.generated !== true) throw new Error('not generated');
  } catch (error) {
    console.error(`sync-core: manifest invalid (${error.message}). Run npm run sync.`);
    bad += 1;
  }
  if (bad > 0) process.exit(1);
  console.log('sync-core: core is in sync');
  process.exit(0);
}

mkdirSync(TARGET, { recursive: true });
for (const [name, text] of payloads) writeFileSync(join(TARGET, name), text, 'utf8');
writeFileSync(join(TARGET, '.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`sync-core: wrote ${payloads.size} files to core/`);
for (const line of manifestLines) console.log(line);
