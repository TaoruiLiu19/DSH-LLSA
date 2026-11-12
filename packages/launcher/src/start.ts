/** Launch the local-content application; credentials stay in Harness settings. */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function parsePort(value = '3095'): number {
  if (!/^\d+$/.test(value)) throw new Error('端口必须是 1024–65535 的整数。');
  const port = Number(value);
  if (port < 1024 || port > 65535) throw new Error('端口必须是 1024–65535 的整数。');
  return port;
}

export function makePatch(state: string, collab: string, superagent: string, moneyPolicyFile = '') {
  return [{ insert: [
    { id: 'llsa', name: collab, config: { stateDir: join(state, 'collab'), bridgeProjection: true,
      explicitEvidenceRefs: true, encodingEvidenceFile: '', moneyPolicyFile, maxRunTokens: 300000, maxOutputTokens: 1536 } },
    { id: 'llsa-worker', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'dsh-superagent-worker', plugins: [] } },
    { id: 'llsa-router', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'dsh-superagent-router', plugins: [] } },
    { id: 'llsa-superagent', name: superagent, config: { stateDir: join(state, 'superagent'), localOnly: true, requireCollaboration: true } },
  ] }];
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.includes('--help')) { console.log('Usage: npm start -- [port]\nDefault: 127.0.0.1:3095\nDSH_LLSA_STATE: optional state directory'); return; }
  if (args.length > 1) throw new Error('只接受一个端口参数；使用 --help 查看帮助。');
  const port = parsePort(args[0]);
  const require = createRequire(import.meta.url);
  const harnessPath = require.resolve('@deepseek-ai/dsh/package.json');
  const { version } = require(harnessPath) as { version: string };
  if (version !== '0.2.2-rc.1') throw new Error(`需要 DeepSeek Harness 0.2.2-rc.1，当前为 ${version}。请运行 npm ci 恢复匹配依赖。`);
  await new Promise<void>((accept, reject) => {
    const server = createServer(); server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(error => error ? reject(error) : accept()));
  });
  const here = dirname(fileURLToPath(import.meta.url));
  const local = existsSync(join(here, 'collab.js'));
  const pluginPath = (name: string) => {
    try { return require.resolve(name); }
    catch { throw new Error(`缺少组件 ${name}。请在完整 DSH-LLSA 安装包目录运行 npm ci，启动器不单独提供完整应用。`); }
  };
  const collab = local ? join(here, 'collab.js') : pluginPath('@dsh-llsa/collab');
  const superagent = local ? join(here, 'superagent.js') : pluginPath('@dsh-llsa/superagent');
  const state = resolve(process.env.DSH_LLSA_STATE ?? '.dsh-llsa');
  await mkdir(state, { recursive: true });
  const patch = join(state, 'launch.json');
  const moneyPolicyFile = process.env.DSH_LLSA_MONEY_POLICY ? resolve(process.env.DSH_LLSA_MONEY_POLICY) : '';
  await writeFile(patch, JSON.stringify(makePatch(state, collab.replaceAll('\\', '/'), superagent.replaceAll('\\', '/'), moneyPolicyFile), null, 2));
  console.log(`DSH-LLSA · http://127.0.0.1:${port}/orchestrator/local\n先打开下方 Harness 认证链接，再进入任务页。Ctrl+C 停止。`);
  const child = spawn(process.execPath, [join(dirname(harnessPath), 'lib/bin.js'), 'web', '--patch', patch,
    '--host', '127.0.0.1', '--port', String(port), '--no-open'], { stdio: 'inherit', windowsHide: true });
  const stop = () => { child.kill(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  await new Promise<void>((accept, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 0 : 1); accept(); });
  }).finally(() => { process.off('SIGINT', stop); process.off('SIGTERM', stop); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
