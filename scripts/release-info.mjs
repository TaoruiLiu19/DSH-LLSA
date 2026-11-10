import { readFile } from 'node:fs/promises';

/** The root manifest is the only source of the combined distribution version. */
export async function readReleaseInfo(url = new URL('../package.json', import.meta.url)) {
  const manifest = JSON.parse(await readFile(url, 'utf8'));
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(manifest.version)) {
    throw new Error('Root package.json must contain a valid release version');
  }
  return { manifest, version: manifest.version, kitFilename: `dsh-llsa-${manifest.version}.tgz`, plannedTag: `v${manifest.version}` };
}
