import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const critical = { '@deepseek-ai/cordis':'4.1.0', '@deepseek-ai/schemastery':'3.19.0',
  '@deepseek-ai/dsh-llm':'0.2.2-rc.1', '@deepseek-ai/dsh-scope':'0.2.2-rc.1', '@deepseek-ai/dsh-tools':'0.2.2-rc.1',
  '@deepseek-ai/dsh-app-boot':'0.2.2-rc.1', '@deepseek-ai/dsh':'0.2.2-rc.1' };
let failed = false;
const dirs = process.argv.slice(2).length ? process.argv.slice(2) : ['.', 'packages/dsh-collab', 'packages/superagent', 'packages/launcher'];
for (const dir of dirs) {
  const file = resolve(root, dir, 'package-lock.json');
  if (!existsSync(file)) { console.error(`FAIL ${dir}: missing lockfile`); failed=true; continue; }
  const lock = JSON.parse(readFileSync(file, 'utf8'));
  for (const [name, version] of Object.entries(critical)) {
    const entries = Object.entries(lock.packages).filter(([p]) => p.endsWith(`node_modules/${name}`));
    if (!entries.length) { console.log(`SKIP ${dir}: ${name} not required`); continue; }
    if (entries.length !== 1 || entries[0][1].version !== version) {
      console.error(`FAIL ${dir}: ${name} must have one physical entry at ${version}`); failed=true;
    } else console.log(`OK ${dir}: ${name}@${version}`);
  }
  for (const [path, meta] of Object.entries(lock.packages)) {
    for (const [name, range] of Object.entries(meta.peerDependencies ?? {})) {
      if (name.startsWith('@deepseek-ai/dsh-') && /^\^0\.2\.1/.test(range)) {
        // Only our manifest peers are controlled here; upstream dependency metadata is retained verbatim.
        if (path === '') { console.error(`FAIL stale peer: ${name}`); failed=true; }
      }
    }
  }
}
if (failed) process.exitCode=1;
