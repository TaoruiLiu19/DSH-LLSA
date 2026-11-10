/** Verify the files behind each manifest before comparing the two platform builds. */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

async function verifiedSums(directory) {
  const entries = new Map();
  const text = await readFile(join(directory, 'SHA256SUMS'), 'utf8');
  for (const line of text.trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9_.+-]+\.tgz)$/.exec(line);
    if (!match || entries.has(match[2])) throw new Error(`Invalid checksum manifest: ${directory}`);
    const [, expected, filename] = match;
    const actual = createHash('sha256').update(await readFile(join(directory, filename))).digest('hex');
    if (actual !== expected) throw new Error(`Archive checksum mismatch: ${filename}`);
    entries.set(filename, expected);
  }
  return [...entries].sort(([a], [b]) => a.localeCompare(b, 'en'));
}

export async function compareArtifacts(first, second) {
  const [left, right] = await Promise.all([verifiedSums(first), verifiedSums(second)]);
  if (JSON.stringify(left) !== JSON.stringify(right)) throw new Error('Ubuntu and Windows release archives differ');
  console.log(`PASS: ${left.length} archives are byte-identical across Ubuntu and Windows`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw new Error('Usage: node scripts/compare-artifacts.mjs <ubuntu-dir> <windows-dir>');
  await compareArtifacts(process.argv[2], process.argv[3]);
}
