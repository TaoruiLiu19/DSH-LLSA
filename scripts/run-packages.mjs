import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const command = process.argv[2];
if (!['ci', 'typecheck', 'test', 'build'].includes(command)) throw new Error('Unknown package operation');
if (!process.env.npm_execpath) throw new Error('Run through npm: npm ci / npm run build');
for (const name of ['dsh-collab', 'superagent', 'launcher']) {
  // Collab is JavaScript, so validate its checked boundaries before root bundling.
  const operation = command === 'build' && name === 'dsh-collab' ? 'typecheck' : command;
  const args = operation === 'ci' ? ['ci', '--no-audit', '--no-fund'] : ['run', operation];
  const result = spawnSync(process.execPath, [process.env.npm_execpath, '--prefix', `packages/${name}`, ...args], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
