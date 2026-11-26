/** Start an isolated Harness to check registration and optionally exercise local file delivery. */
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PANEL_HTML, PANEL_SCRIPT } from '../packages/dsh-collab/src/text-assets.js';
import { openDeliveryFixture, smokeDelivery } from './smoke-delivery.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

export async function smoke(cwd = root, entry = 'dist/start.js', { csvWorkspace, webCollab = false, delivery = false } = {}) {
  const state = await mkdtemp(join(tmpdir(), 'dsh-llsa-smoke-'));
  const reservation = createServer();
  await new Promise((accept, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', accept);
  });
  const port = reservation.address().port;
  await new Promise(accept => reservation.close(accept));
  const env = { ...process.env, DSH_HOME: join(state, 'harness'), DSH_LLSA_STATE: join(state, 'plugin') };
  // The check uses its own empty home and never inherits a provider credential.
  for (const key of Object.keys(env)) {
    if (/API[_-]?KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|^DSH_/i.test(key)) delete env[key];
  }
  env.DSH_HOME = join(state, 'harness');
  env.DSH_LLSA_STATE = join(state, 'plugin');
  env.DSH_TELEMETRY_DISABLED = '1';
  if (csvWorkspace) env.DSH_LLSA_CSV_WORKSPACE = resolve(cwd, csvWorkspace);
  if (webCollab) env.DSH_LLSA_WEB_COLLAB = '1';
  const fixture = delivery ? await openDeliveryFixture() : undefined;
  if (fixture) {
    env.DEEPSEEK_BASE_URL = fixture.baseURL;
    env.DEEPSEEK_API_KEY = fixture.key;
    env.NO_PROXY = '127.0.0.1,localhost';
  }
  const child = spawn(process.execPath, [resolve(cwd, entry), String(port)], {
    cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    detached: process.platform !== 'win32',
  });
  let output = '';
  let error;
  child.on('error', value => { error = value; });
  child.stdout.on('data', data => { output += data.toString(); });
  child.stderr.on('data', data => { output += data.toString(); });
  const origin = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 45_000;
    let auth;
    while (Date.now() < deadline) {
      if (error) throw error;
      if (child.exitCode !== null) throw new Error(`Launcher exited: ${child.exitCode}`);
      auth = output.match(/dsh web: (http:\/\/[^\s]+\?token=[^\s]+)/)?.[1];
      if (auth) break;
      await delay(200);
    }
    assert.ok(auth, 'Harness did not announce its authenticated URL within 45 seconds');
    assert.equal(new URL(auth).origin, origin);
    const login = await fetch(auth, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    assert.ok([302, 303].includes(login.status), 'Authentication must redirect to a clean URL');
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    assert.ok(cookie, 'No authentication cookie received');
    const headers = { cookie, origin, 'x-orchestrator-request': '1' };
    for (const route of ['/orchestrator/local', '/collab']) {
      const page = await fetch(origin + route, { headers, signal: AbortSignal.timeout(5000) });
      assert.equal(page.status, 200, `${route} HTTP status`);
      assert.match(page.headers.get('content-type'), /text\/html/);
      if (route === '/collab') assert.equal(await page.text(), PANEL_HTML, 'Bundled panel must match its source assets');
    }
    const response = await fetch(origin + '/collab/api/status', { headers, signal: AbortSignal.timeout(5000) });
    const panelScript = await fetch(origin + '/collab/panel.js', { headers, signal: AbortSignal.timeout(5000) });
    assert.equal(panelScript.status, 200, 'Bundled panel script must be available without source assets');
    const panelCode = await panelScript.text();
    assert.equal(panelCode, PANEL_SCRIPT, 'Bundled browser code must match its source asset');
    assert.match(panelCode, /textContent/);
    assert.doesNotThrow(() => new Script(panelCode));
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.ok(status.bridge, 'Native collaboration bridge did not register');
    assert.equal(status.mode, 'managed_tools', 'Managed delegation backend did not register');
    assert.equal(status.capabilities.hostCsvWorkflow, Boolean(csvWorkspace), 'CSV opt-in status did not match the launch configuration');
    if (csvWorkspace) {
      const post = async (path, body) => {
        const result = await fetch(origin + '/collab/api' + path, {
          method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
        });
        assert.equal(result.status, 200, path);
        return result.json();
      };
      const preview = await post('/local/calculations/preview', { rowsJSON: '[{"count":1}]', operation: 'count' });
      const { runId } = await post('/local/calculations/commit', { previewId: preview.previewId, requestId: randomUUID() });
      const run = '/runs/' + encodeURIComponent(runId);
      const snapshot = async () => (await fetch(origin + '/collab/api' + run, { headers, signal: AbortSignal.timeout(5000) })).json();
      assert.deepEqual((await snapshot()).csvWorkflow, { available: true, enabled: false });
      for (const enabled of [true, false]) {
        assert.deepEqual((await post(run + '/csv-workflow', { enabled })).result, { enabled });
        assert.deepEqual((await snapshot()).csvWorkflow, { available: true, enabled });
      }
    }
    const native = await fetch(origin + '/orchestrator/api/state', { headers, signal: AbortSignal.timeout(5000) });
    assert.equal(native.status, 200);
    assert.ok((await native.json()).setup, 'Native task state missing');
    const get = (route, extra = {}) => fetch(origin + route, {
      headers: { ...headers, ...extra }, signal: AbortSignal.timeout(5000),
    });
    const tasks = await get('/orchestrator/api/local/tasks');
    assert.equal(tasks.status, 200);
    assert.equal((await tasks.json()).webConsultationProtocol === 1, webCollab,
      'Native consultation capability did not match the launch configuration');

    const webPage = await get('/web-collab');
    const webPanel = await readFile(resolve(root, 'packages/web-collab/src/panel.html'));
    if (webCollab) {
      assert.equal(webPage.status, 200);
      assert.match(webPage.headers.get('content-type'), /text\/html/);
      assert.deepEqual(Buffer.from(await webPage.arrayBuffer()), webPanel);
      const toggle = webPanel.toString('utf8').match(/<input\b[^>]*\bid="web"[^>]*>/)?.[0];
      assert.ok(toggle, 'Web collaboration task opt-in is missing');
      assert.doesNotMatch(toggle, /\bchecked\b/i, 'Every task must start with web consultation off');
      for (const file of ['panel.js', 'native-handoff.js', 'task-evidence.js']) {
        const module = await get(`/web-collab/${file}`);
        assert.equal(module.status, 200, `${file} HTTP status`);
        assert.match(module.headers.get('content-type'), /javascript/);
        assert.deepEqual(Buffer.from(await module.arrayBuffer()), await readFile(resolve(root, 'packages/web-collab/src', file)));
      }
      const status = await get('/web-collab/api/status', { 'x-web-collab-request': '1' });
      assert.equal(status.status, 200);
      assert.equal((await status.json()).advisorAvailable, false, 'A fresh launch must work without Open WebUI');
    } else {
      assert.notDeepEqual(Buffer.from(await webPage.arrayBuffer()), webPanel, 'Web Collab is enabled without opt-in');
      const status = await get('/web-collab/api/status', { 'x-web-collab-request': '1' });
      assert.ok(status.status === 404 || !/application\/json/i.test(status.headers.get('content-type') ?? ''),
        'The optional Web Collab API is registered on a default launch');
      await status.body?.cancel();
    }
    console.log('PASS: isolated Harness, both panels, collaboration bridge and native state');
    if (csvWorkspace) console.log('PASS: local CSV policy toggles on and off over the running web API');
    console.log(`PASS: Web Collab ${webCollab ? 'loads its shipped panel and starts without an advisor' : 'is disabled by default'}`);
    if (fixture) await smokeDelivery(origin, headers, state, fixture);
  } catch (error) {
    // Keep ephemeral auth URLs out of CI output even when boot fails.
    const safe = output.replace(/([?&]token=)[^\s&]+/g, '$1[REDACTED]');
    console.error((fixture ? safe.replaceAll(fixture.key, '[REDACTED]') : safe).slice(-7000));
    throw error;
  } finally {
    if (child.pid && child.exitCode === null) {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
    await fixture?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await smoke(root, 'dist/start.js', { webCollab: process.argv.includes('--web-collab'), delivery: process.argv.includes('--delivery') });
}
