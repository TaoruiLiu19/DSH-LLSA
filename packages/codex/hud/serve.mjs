import { createServer } from 'node:http';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const LOOPBACK = '127.0.0.1';
const headers = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};
const runIdPattern = /^[A-Za-z0-9_.:-]{1,256}$/;
const webDirectory = new URL('./web/', import.meta.url);
const bundledRenderer = new URL('./shared/', import.meta.url);

async function rendererLocation() {
  try {
    await access(new URL('render.js', bundledRenderer));
    return bundledRenderer;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return new URL('../../hud/src/', import.meta.url);
  }
}

function reply(req, res, status, type, content) {
  res.writeHead(status, { ...headers, 'Content-Type': type });
  res.end(req.method === 'HEAD' ? undefined : content);
}

function json(req, res, status, body) {
  reply(req, res, status, 'application/json; charset=utf-8', JSON.stringify(body));
}

export async function startHudServer({ port = 0, data, rendererDirectory } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError('HUD port must be an integer from 0 to 65535');
  const { listRuns, getSnapshot } = data ?? await import('./collector.mjs');
  const renderer = rendererDirectory ?? await rendererLocation();
  const files = new Map([
    ['/', [new URL('index.html', webDirectory), 'text/html; charset=utf-8']],
    ['/hud.css', [new URL('hud.css', webDirectory), 'text/css; charset=utf-8']],
    ['/app.mjs', [new URL('app.mjs', webDirectory), 'text/javascript; charset=utf-8']],
    ['/tree.mjs', [new URL('tree.mjs', webDirectory), 'text/javascript; charset=utf-8']],
    ...['render.js', 'model.js', 'materials.js'].map(name => [`/shared/${name}`, [new URL(name, renderer), 'text/javascript; charset=utf-8']]),
  ]);
  // Load only known assets before binding. Request paths never become filesystem paths.
  for (const [route, [file, type]] of files) files.set(route, [await readFile(file), type]);
  const server = createServer(async (req, res) => {
    const host = `${LOOPBACK}:${server.address().port}`;
    const origin = `http://${host}`;
    if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== origin)
      || req.headers['sec-fetch-site'] === 'cross-site') {
      json(req, res, 403, { error: 'local_origin_required' });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      json(req, res, 405, { error: 'read_only' });
      return;
    }
    try {
      const url = new URL(req.url, origin);
      if (url.origin !== origin) {
        json(req, res, 403, { error: 'local_origin_required' });
        return;
      }
      const asset = files.get(url.pathname);
      if (asset) {
        reply(req, res, 200, asset[1], asset[0]);
      } else if (url.pathname === '/api/runs') {
        json(req, res, 200, { runs: await listRuns() });
      } else if (url.pathname === '/api/snapshot') {
        const id = url.searchParams.get('runId') ?? '';
        if (!runIdPattern.test(id) || url.searchParams.getAll('runId').length !== 1) {
          json(req, res, 400, { error: 'invalid_run_id' });
          return;
        }
        const snapshot = await getSnapshot(id);
        json(req, res, snapshot ? 200 : 404, snapshot ?? { error: 'run_unavailable' });
      } else {
        json(req, res, 404, { error: 'not_found' });
      }
    } catch {
      json(req, res, 503, { error: 'hud_unavailable' });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, LOOPBACK, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return { server, url: `http://${LOOPBACK}:${server.address().port}/` };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { url } = await startHudServer({ port: Number(process.env.CODEX_LEANLINK_HUD_PORT ?? 0) });
    console.log(`LeanLink HUD: ${url}`);
  } catch (error) {
    console.error(`LeanLink HUD: ${error.message}`);
    process.exitCode = 1;
  }
}
