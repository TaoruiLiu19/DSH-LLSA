/** Assemble the local Codex marketplace. Shared HUD renderer assets come from their original package. */
import { cp, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const pluginName = 'leanlink-codex';
const marketplaceName = 'dsh-llsa-codex';
const components = ['.codex-plugin', '.mcp.json', 'package.json', 'README.md', 'README.en.md',
  'skills', 'hooks', 'leanlink', 'hud'];
const sharedHud = ['materials.js', 'model.js', 'render.js'];

export async function buildCodexMarketplace(output = join(root, 'artifacts', 'codex-marketplace'), {
  dataHome = process.env.CODEX_LEANLINK_HOME, workspace = process.env.CODEX_LEANLINK_WORKSPACE,
} = {}) {
  if (dataHome && !isAbsolute(dataHome)) throw new Error('CODEX_LEANLINK_HOME must be an absolute path');
  const plugin = join(output, 'plugins', pluginName);
  const shared = join(plugin, 'hud', 'shared');
  await mkdir(shared, { recursive: true });
  for (const component of components) {
    await cp(join(root, 'packages', 'codex', component), join(plugin, component), {
      recursive: true,
      filter: path => !['test', 'tests', 'node_modules'].includes(basename(path)) && !/\.test\.[cm]?js$/u.test(path),
    });
  }
  for (const file of sharedHud) await copyFile(join(root, 'packages', 'hud', 'src', file), join(shared, file));
  await copyFile(join(root, 'LICENSE'), join(plugin, 'LICENSE'));
  if (dataHome || workspace) {
    const path = join(plugin, '.mcp.json');
    const mcp = JSON.parse(await readFile(path, 'utf8'));
    mcp.mcpServers.leanlink.env = {
      ...(dataHome ? { CODEX_LEANLINK_HOME: dataHome } : {}),
      ...(workspace ? { CODEX_LEANLINK_WORKSPACE: workspace } : {}),
    };
    await writeFile(path, JSON.stringify(mcp, null, 2) + '\n');
  }
  const catalog = join(output, '.agents', 'plugins', 'marketplace.json');
  await mkdir(dirname(catalog), { recursive: true });
  await writeFile(catalog, JSON.stringify({
    name: marketplaceName,
    interface: { displayName: 'DSH-LLSA Codex' },
    plugins: [{
      name: pluginName,
      source: { source: 'local', path: './plugins/' + pluginName },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Developer Tools',
    }],
  }, null, 2) + '\n');
  return { marketplace: output, plugin };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { marketplace, plugin } = await buildCodexMarketplace();
  console.log(`codex plugin marketplace add "${marketplace}"`);
  console.log(`codex plugin add ${pluginName}@${marketplaceName}`);
  console.log(`node "${join(plugin, 'hud', 'serve.mjs')}"`);
}
