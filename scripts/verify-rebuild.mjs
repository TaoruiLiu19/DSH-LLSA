/** Fail if the same sources/lockfiles produce different distribution bytes. */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const checksum = new URL('../artifacts/SHA256SUMS', import.meta.url);
const before = readFileSync(checksum, 'utf8');
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run through npm run verify:rebuild');
const result = spawnSync(process.execPath, [npm, 'run', 'pack:release'], {
  cwd: root, stdio: 'inherit', windowsHide: true,
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error('Rebuild failed');
if (readFileSync(checksum, 'utf8') !== before) throw new Error('Release is not byte-for-byte reproducible');
console.log('PASS: all four release archives reproduced byte-for-byte');
