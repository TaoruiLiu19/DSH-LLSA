/**
 * Local, read-only HUD service. Two jobs:
 *   1. accept hook payloads pushed by bin/hook-emit.mjs
 *   2. serve hud-v1 snapshots and the companion window over loopback
 *
 * Zero dependencies. Binds 127.0.0.1 only. No tool output is ever read.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdapter } from '../lib/adapter.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number.parseInt(process.env.HUD_PORT ?? '4317', 10);
const VERSION = '0.1.0';
const adapter = createAdapter();

const json = (body, status = 200) => {
  const text = JSON.stringify(body);
  return {
    status,
    text,
    type: 'application/json; charset=utf-8',
  };
};

/** Only files under core/ and view/ are reachable; no traversal. */
async function staticFile(pathname) {
  const map = new Map([
    ['/', join(ROOT, 'view', 'index.html')],
    ['/view', join(ROOT, 'view', 'index.html')],
    ['/view/', join(ROOT, 'view', 'index.html')],
  ]);
  let target = map.get(pathname);
  if (target === undefined && pathname.startsWith('/core/')) {
    const name = pathname.slice('/core/'.length);
    if (/^[A-Za-z0-9._-]+$/.test(name) === false) return undefined;
    target = join(ROOT, 'core', name);
  }
  if (target === undefined) return undefined;
  const base = `${ROOT}${sep}`;
  if (target !== ROOT && target.startsWith(base) === false) return undefined;
  try {
    const text = await readFile(target, 'utf8');
    return {
      status: 200,
      text,
      type: pathname.startsWith('/core/')
        ? 'text/javascript; charset=utf-8'
        : 'text/html; charset=utf-8',
    };
  } catch {
    return undefined;
  }
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);
  const pathname = url.pathname;

  const send = result => {
    const body = result ?? json({ ok: false, error: 'not found' }, 404);
    response.writeHead(body.status, {
      'content-type': body.type,
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'x-content-type-options': 'nosniff',
    });
    response.end(body.text);
  };

  if (request.method === 'POST' && pathname === '/event') {
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size <= 1_000_000) chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        if (size > 1_000_000) throw new Error('payload too large');
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const result = adapter.ingest(payload);
        send(json({ ok: true, version: VERSION, ...result }));
      } catch (error) {
        send(json({ ok: false, error: error.message }, 400));
      }
    });
    return;
  }

  if (request.method === 'GET' && pathname === '/state') {
    const session = url.searchParams.get('session') ?? 'default';
    send(json({
      ok: true,
      snapshot: adapter.snapshotFor(session),
      meta: { sessionId: session, taskText: adapter.taskTextOf(session), focusMode: false, version: VERSION },
    }));
    return;
  }

  if (request.method === 'GET' && pathname === '/ping') {
    send(json({ ok: true, version: VERSION, sessions: adapter.sessions.size }));
    return;
  }

  if (request.method === 'GET') {
    staticFile(pathname).then(send);
    return;
  }
  send(json({ ok: false, error: 'method not allowed' }, 405));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`hud-workbuddy ${VERSION} listening on http://127.0.0.1:${PORT}`);
  console.log(`companion window: http://127.0.0.1:${PORT}/view`);
});
