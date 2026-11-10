/** The distribution must install independently of this repository's node_modules. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { x as extract } from 'tar';
import { smoke } from './smoke.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run npm run verify:kit');
const destination = await mkdtemp(join(tmpdir(), 'dsh-llsa-install-'));
await extract({ cwd: destination, file: join(root, 'artifacts/dsh-llsa-0.4.1.tgz'), strict: true });
const kit = join(destination, 'package');
function run(command, args) {
  const result = spawnSync(command, args, { cwd: kit, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Failed: ${args.join(' ')}`);
}
const manifest = JSON.parse(await readFile(join(kit, 'package.json'), 'utf8'));
assert.equal(Object.keys(manifest.dependencies).filter(name => name.startsWith('@dsh-llsa/')).length, 3);
run(process.execPath, [npm, 'ci', '--no-audit', '--no-fund']);
run(process.execPath, [join(root, 'scripts/check-versions.mjs'), kit]);
run(process.execPath, [npm, 'ls', '@deepseek-ai/cordis', '@deepseek-ai/schemastery', '--depth=0']);
await smoke(kit, 'node_modules/@dsh-llsa/launcher/lib/start.js');
console.log('PASS: clean kit install and startup');
