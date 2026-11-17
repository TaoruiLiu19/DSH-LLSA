/** Exercise marketplace installation and both workspaces in stock Harness Web without model credentials. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtempDisposable, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { PANEL_HTML } from '../packages/dsh-collab/src/text-assets.js';
import { readReleaseInfo } from './release-info.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url));
const bundleName = '@dsh-llsa/harness-bundle';
const profile = 'llsa-verify';
const release = await readReleaseInfo();
const archive = process.argv[2] ? resolve(process.argv[2]) : join(root, 'artifacts', release.harnessBundleFilename);
assert.ok((await stat(archive)).isFile(), 'Expected a built Harness bundle archive');

await using fixture = await mkdtempDisposable(join(tmpdir(), 'dsh-llsa-harness-bundle-'));
const cwd = join(fixture.path, 'existing workspace');
await mkdir(cwd);
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/API[_-]?KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|^DSH_|^DEEPSEEK_/i.test(name)));
env.DSH_HOME = join(fixture.path, 'harness');
const profileDir = join(env.DSH_HOME, 'profiles', profile);
const profileManifest = async () => JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'));

function runCli(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd, env, timeout: 180_000, encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, sanitize((result.stderr + '\n' + result.stdout).slice(-6000)));
}

function sanitize(output) {
  return output.replace(/([?&]token=)[^\s&]+/g, '$1[REDACTED]');
}

// Install into an already initialized public Web profile, using the same CLI outside this test.
runCli(['--profile', profile, '--from-default-profile', 'web', '--dump-config']);
const existingBundles = (await profileManifest()).dsh.profile.bundles;
assert.ok(existingBundles.includes('@deepseek-ai/dsh-web-app'), 'Fixture is not a stock Harness Web profile');
const patchBefore = await readFile(join(profileDir, 'cordis.patch.yml'));
runCli(['plugin', '--profile', profile, 'add', archive, '--store-dir', join(fixture.path, 'pnpm-store')]);
assert.deepEqual((await profileManifest()).dsh.profile.bundles, [...existingBundles, bundleName]);
assert.deepEqual(await readFile(join(profileDir, 'cordis.patch.yml')), patchBefore);

const reservation = createServer().listen(0, '127.0.0.1');
await once(reservation, 'listening');
const { port } = reservation.address();
await new Promise((accept, reject) => reservation.close(error => error ? reject(error) : accept()));
const origin = 'http://127.0.0.1:' + port;
const child = spawn(process.execPath, [cli, '--profile', profile, '--host', '127.0.0.1', '--port', String(port), '--no-open'], {
  cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
let launchError;
for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', data => { output += data.toString(); });
}
child.on('error', error => { launchError = error; });

const request = (route, options = {}) => fetch(origin + route, {
  redirect: 'manual', signal: AbortSignal.timeout(5000), ...options,
});
try {
  const deadline = Date.now() + 45_000;
  let auth;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Harness exited before announcing its URL');
    auth = output.match(/dsh web: (http:\/\/[^\s]+\?token=[^\s]+)/)?.[1];
    if (auth) break;
    await delay(200);
  }
  assert.ok(auth, 'Harness did not announce its authentication URL');
  assert.equal(new URL(auth).origin, origin);

  const guarded = ['/orchestrator/local', '/orchestrator/api/local/tasks', '/collab', '/collab/api/status'];
  const sameOrigin = { origin, 'x-orchestrator-request': '1' };
  for (const route of guarded) {
    const anonymous = await request(route, { headers: sameOrigin });
    assert.ok([401, 403].includes(anonymous.status), route + ' must require Harness authentication');
    await anonymous.body?.cancel();
  }

  const login = await request(auth.slice(origin.length));
  assert.ok([302, 303].includes(login.status), 'Authentication must redirect to a clean URL');
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  await login.body?.cancel();
  assert.ok(cookie, 'Harness issued no login cookie');
  const headers = { ...sameOrigin, cookie };
  for (const route of guarded) {
    const crossSite = await request(route, { headers: { ...headers, origin: 'https://not-harness.invalid' } });
    assert.equal(crossSite.status, 403, route + ' must reject a foreign origin even with the login cookie');
    await crossSite.body?.cancel();
  }

  const nativeRoot = await request('/', { headers });
  assert.equal(nativeRoot.status, 200, 'Stock Harness Web remains available');
  assert.match(nativeRoot.headers.get('content-type') ?? '', /text\/html/);
  await nativeRoot.body?.cancel();

  const taskPanel = await request('/orchestrator/local', { headers });
  assert.equal(taskPanel.status, 200, 'Super-agent task panel');
  const taskPanelHtml = await taskPanel.text();
  assert.ok(taskPanelHtml.includes('/orchestrator/api/') && taskPanelHtml.includes('local/tasks'),
    'Orchestrator page must connect to the native local tasks API');
  const collabPanel = await request('/collab', { headers });
  assert.equal(collabPanel.status, 200, 'LeanLink records panel');
  assert.equal(await collabPanel.text(), PANEL_HTML);
  const panelScript = await request('/collab/panel.js', { headers });
  assert.equal(panelScript.status, 200, 'LeanLink panel script');
  assert.match(panelScript.headers.get('content-type') ?? '', /javascript/);
  await panelScript.body?.cancel();

  const status = await request('/collab/api/status', { headers });
  assert.equal(status.status, 200, 'LeanLink status');
  const core = await status.json();
  assert.ok(core.bridge, 'Super-agent did not register the LeanLink bridge');
  assert.equal(core.mode, 'managed_tools', 'LeanLink did not register managed delegation');

  const nativeTasks = await request('/orchestrator/api/local/tasks', { headers });
  assert.equal(nativeTasks.status, 200, 'Native local task API');
  const tasks = await nativeTasks.json();
  assert.ok(tasks.masterSessionId, 'No orchestrator session ID');
  assert.deepEqual(tasks.tickets, []);
  assert.notEqual(tasks.webConsultationProtocol, 1, 'Web Collab must be separate from this bundle');
  const web = await request('/web-collab/api/status', { headers: { ...headers, 'x-web-collab-request': '1' } });
  assert.ok(web.status === 404 || !/application\/json/i.test(web.headers.get('content-type') ?? ''),
    'Installing the bundle must not activate Web Collab');
  await web.body?.cancel();

  async function post(route, body, expected = 200) {
    const response = await request(route, { method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, expected, route);
    return response.json();
  }
  // Exercise the live native POST contract with opt-in rejected before any model dispatch.
  const disabled = await post('/orchestrator/api/local/tasks',
    { requestId: randomUUID(), prompt: 'Keyless installation check', webConsultationEnabled: true }, 409);
  assert.match(disabled.error, /Web collaboration is disabled/);

  const preview = await post('/collab/api/local/calculations/preview', {
    rowsJSON: '[{"points":2},{"points":5}]', operation: 'sum', field: 'points',
  });
  assert.deepEqual(preview.result, { total: 7, matchedRows: 2 });
  assert.equal(preview.modelCalls, 0);
  const commit = await post('/collab/api/local/calculations/commit', { previewId: preview.previewId, requestId: randomUUID() });
  assert.deepEqual(commit.result, preview.result);
  assert.equal(commit.modelCalls, 0);
  const receipt = await request('/collab/api/runs/' + encodeURIComponent(commit.runId), { headers });
  assert.equal(receipt.status, 200, 'Saved calculation record');
  const record = await receipt.json();
  assert.ok(record.events.some(event => event.kind === 'computation_receipt'), 'The computation receipt was not saved');
  assert.ok(record.events.some(event => event.kind === 'final_result' && event.payload.result.total === 7),
    'The saved result lost the verified total');

  console.log('PASS: dsh plugin add installed LeanLink and Super-agent in an existing Web profile');
  console.log('PASS: authenticated pages, management bridge, disabled Web Collab, and a saved zero-model calculation');
} catch (error) {
  console.error(sanitize(output).slice(-7000));
  throw error;
} finally {
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
}
