/** The distribution must install independently of this repository's node_modules. */
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { x as extract } from 'tar';
import { smoke } from './smoke.mjs';
import { readReleaseInfo } from './release-info.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const release = await readReleaseInfo();
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run npm run verify:kit');
const destination = await mkdtemp(join(tmpdir(), 'dsh-llsa-install-'));
await extract({ cwd: destination, file: join(root, 'artifacts', release.kitFilename), strict: true });
const kit = join(destination, 'package');
function run(command, args) {
  const result = spawnSync(command, args, { cwd: kit, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Failed: ${args.join(' ')}`);
}
const manifest = JSON.parse(await readFile(join(kit, 'package.json'), 'utf8'));
assert.equal(manifest.version, release.version, 'Archive name and contained kit version must agree');
assert.equal(Object.keys(manifest.dependencies).filter(name => name.startsWith('@dsh-llsa/')).length, 3);
const sample = join(kit, 'examples/csv-workflow/workflow.csv');
assert.ok((await stat(sample)).isFile(), 'Missing synthetic CSV example');
run(process.execPath, [npm, 'ci', '--no-audit', '--no-fund']);
const engine = join(kit, 'node_modules/@dsh-llsa/collab/lib/csv-engine/run_workflow.py');
assert.ok((await stat(engine)).isFile(), 'Missing installed CSV engine');
const csvStage = await mkdtemp(join(destination, 'csv-smoke-'));
await copyFile(sample, join(csvStage, 'input.csv'));
const csvRun = spawnSync(process.env.DSH_LLSA_CSV_PYTHON || 'python', ['-E', '-S', '-B', engine], {
  cwd: csvStage,
  input: JSON.stringify({ steps: [{ op: 'group_count', column: '地区' }] }),
  encoding: 'utf8',
  windowsHide: true,
  timeout: 20_000,
  maxBuffer: 64 * 1024,
});
if (csvRun.error) throw csvRun.error;
assert.equal(csvRun.status, 0, 'Installed CSV engine failed its sample workflow');
const csvResult = JSON.parse(csvRun.stdout);
assert.equal(csvResult.model_calls, 0);
assert.equal(csvResult.status, 'completed');
assert.match(csvResult.output_ref, /^csv-output\/[a-f0-9]{64}\.csv$/u);
const sampleSummary = await readFile(join(csvStage, csvResult.output_ref), 'utf8');
assert.equal(sampleSummary.replaceAll('\r\n', '\n'), '地区,count\n北区,14\n南区,14\n');
run(process.execPath, [join(root, 'scripts/check-versions.mjs'), kit]);
run(process.execPath, [npm, 'ls', '@deepseek-ai/cordis', '@deepseek-ai/schemastery', '--depth=0']);
await smoke(kit, 'node_modules/@dsh-llsa/launcher/lib/start.js');
await smoke(kit, 'node_modules/@dsh-llsa/launcher/lib/start.js', { csvWorkspace: 'examples/csv-workflow' });
console.log('PASS: clean install kit and startup with built-in CSV disabled and configured');
