import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readReleaseInfo } from '../release-info.mjs';
import { compareArtifacts } from '../compare-artifacts.mjs';

test('changing the root version updates kit filename and tag together', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'llsa-version-'));
  const path = join(dir, 'package.json');
  for (const version of ['1.7.3', '2.0.0-rc.2']) {
    await writeFile(path, JSON.stringify({ version }));
    const release = await readReleaseInfo(path);
    assert.equal(release.version, version);
    assert.equal(release.kitFilename, `dsh-llsa-${version}.tgz`);
    assert.equal(release.plannedTag, `v${version}`);
  }
  await writeFile(path, JSON.stringify({ version: '../bad' }));
  await assert.rejects(readReleaseInfo(path), /valid release version/);
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'llsa-platform-'));
  const first = join(dir, 'ubuntu'), second = join(dir, 'windows');
  await mkdir(first); await mkdir(second);
  return { first, second };
}
async function artifact(dir, text, name = 'example.tgz', newline = '\n') {
  await writeFile(join(dir, name), text);
  const hash = createHash('sha256').update(text).digest('hex');
  await writeFile(join(dir, 'SHA256SUMS'), `${hash}  ${name}${newline}`);
}
test('platform comparison accepts identical archives with different manifest line endings', async () => {
  const { first, second } = await fixture();
  await artifact(first, 'same'); await artifact(second, 'same', 'example.tgz', '\r\n');
  await compareArtifacts(first, second);
});
test('platform comparison rejects different archive contents or filenames', async () => {
  const { first, second } = await fixture();
  await artifact(first, 'one'); await artifact(second, 'two');
  await assert.rejects(compareArtifacts(first, second), /archives differ/);
  await artifact(second, 'one', 'another.tgz');
  await assert.rejects(compareArtifacts(first, second), /archives differ/);
});
test('matching checksum claims cannot conceal tampered or missing archives', async () => {
  const { first, second } = await fixture();
  await artifact(first, 'same'); await artifact(second, 'same');
  await writeFile(join(second, 'example.tgz'), 'tampered');
  await assert.rejects(compareArtifacts(first, second), /checksum mismatch/);
  await writeFile(join(second, 'SHA256SUMS'), '');
  await assert.rejects(compareArtifacts(first, second), /Invalid checksum manifest/);
});
