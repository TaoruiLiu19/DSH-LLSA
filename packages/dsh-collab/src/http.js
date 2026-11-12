// @ts-check
import { PANEL_HTML, PANEL_SCRIPT } from './panel.js';
import { parseExactJson } from './protocol.js';

/** @typedef {import('node:http').IncomingMessage} Request */
/** @typedef {import('node:http').ServerResponse} Response */
/** @typedef {import('./types.js').JsonObject} JsonObject */
/**
 * @typedef {object} HttpService
 * @property {() => unknown} status
 * @property {() => unknown} protocols
 * @property {() => unknown} listRuns
 * @property {(runId: string) => unknown} describeRun
 * @property {(runId: string, stepId: string, options: import('./types.js').StepQuery) => unknown} inspect
 * @property {(runId: string, ref: string, options: import('./types.js').ArtifactRange) => {data: Buffer, mediaType: string}|Promise<{data: Buffer, mediaType: string}>} readArtifact
 * @property {(runId: string, paused: boolean) => unknown} pause
 * @property {(runId: string, agentId: string) => unknown} interrupt
 * @property {(command: {runId: string, action: string, idempotencyKey: string}) => unknown} operatorControl
 * @property {{status: () => unknown, getTask: (id: string) => unknown, startTask: (body: JsonObject) => unknown, previewCalculation: (body: JsonObject) => unknown, commitCalculation: (body: JsonObject) => unknown, interruptTask: (id: string) => unknown}} [localWorkspace]
 */
/** @typedef {{webServer: {register: (route: {kind: 'prefix', path: string, handler: (req: Request, res: Response) => Promise<void>}) => void|(() => void)|{dispose: () => void}}}} HttpContext */

const BASE = '/collab';
const MAX_BODY = 64 * 1024;
const MAX_ARTIFACT = 1024 * 1024;

/** @param {number} status @param {string} code */
function httpError(status, code) { return Object.assign(new Error(code), { status, code }); }
function loopback(address = '') { return address === '::1' || /^(?:::ffff:)?127(?:\.\d{1,3}){3}$/.test(address); }
/** @param {unknown} host @returns {boolean} */
function allowedHost(host) {
  if (typeof host !== 'string' || !host || /[\s/@?#\\]/.test(host)) return false;
  try {
    const url = new URL(`http://${host}`);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    return hostname === 'localhost' || loopback(hostname);
  } catch { return false; }
}
/** @param {string} text @returns {string} */
function identifier(text) {
  let id;
  try { id = decodeURIComponent(text); } catch { throw httpError(400, 'INVALID_IDENTIFIER'); }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(id) || id.includes('..')) throw httpError(400, 'INVALID_IDENTIFIER');
  return id;
}
/** @param {string|null|undefined} text @param {string} name @param {number} [fallback] */
function integer(text, name, fallback) {
  if (text === null || text === undefined) return fallback;
  if (!/^\d+$/.test(String(text))) throw httpError(400, `INVALID_${name}`);
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw httpError(400, `INVALID_${name}`);
  return value;
}
/** Display redaction leaves persisted evidence untouched; it is not a general secret detector.
 * @param {unknown} value @returns {unknown}
 */
function redact(value) {
  if (typeof value === 'string') {
    return value
      .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED]')
      .replace(/\bBearer[ \t]+[A-Za-z0-9._~+\/-]+={0,2}/gi, 'Bearer [REDACTED]');
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
      /^(api[_-]?key|authorization|password|secret|access[_-]?token|refresh[_-]?token|credential)$/i.test(key)
        ? '[REDACTED]' : redact(child)]));
  }
  return value;
}
/** @param {Response} res @param {number} status @param {unknown} data @param {string} [contentType] */
function send(res, status, data, contentType = 'application/json; charset=utf-8') {
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'self'; object-src 'none'; base-uri 'none'");
  res.end(Buffer.isBuffer(data) || typeof data === 'string' ? data : JSON.stringify(redact(data)));
}
/** @param {Request} req @returns {Promise<JsonObject>} */
async function bodyJSON(req) {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw httpError(415, 'JSON_REQUIRED');
  if (req.headers['content-length'] && Number(req.headers['content-length']) > MAX_BODY) throw httpError(413, 'BODY_TOO_LARGE');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY) throw httpError(413, 'BODY_TOO_LARGE');
    chunks.push(bytes);
  }
  let parsed;
  try { parsed = parseExactJson(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, 'INVALID_JSON'); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw httpError(400, 'OBJECT_REQUIRED');
  return parsed;
}
/** @param {JsonObject} body @param {string[]} keys */
function only(body, keys) {
  if (Object.keys(body).some(key => !keys.includes(key))) throw httpError(400, 'UNKNOWN_FIELD');
}
/** @param {Request} req */
function postOrigin(req) {
  const scheme = /** @type {import('node:net').Socket & {encrypted?: boolean}} */ (req.socket).encrypted ? 'https' : 'http';
  let origin;
  try { origin = new URL(req.headers.origin).origin; } catch { throw httpError(403, 'SAME_ORIGIN_REQUIRED'); }
  if (req.headers.origin !== origin || origin !== `${scheme}://${req.headers.host}` || req.headers['sec-fetch-site'] === 'cross-site') throw httpError(403, 'SAME_ORIGIN_REQUIRED');
}
/** @param {unknown} caught */
function mapError(caught) {
  const error = /** @type {{status?: number, code?: string}} */ (caught && typeof caught === 'object' ? caught : {});
  if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500) return { status: error.status, code: String(error.code ?? 'REQUEST_REJECTED') };
  const code = String(error.code ?? '');
  if (/NOT_FOUND|UNKNOWN_RUN|UNKNOWN_STEP|UNKNOWN_ARTIFACT|ARTIFACT_NOT_IN_RUN|CROSS_RUN/.test(code)) return { status: 404, code: 'NOT_FOUND' };
  if (/UNAUTHORIZED|FORBIDDEN|SCOPE/.test(code)) return { status: 403, code: 'FORBIDDEN' };
  if (/UNAVAILABLE|NO_BRIDGE|NOT_CONNECTED|UNSUPPORTED/.test(code)) return { status: 409, code: 'CAPABILITY_UNAVAILABLE' };
  if (/INVALID|AMBIGUOUS|CONFLICT/.test(code)) return { status: 400, code: 'INVALID_REQUEST' };
  return { status: 500, code: 'INTERNAL_ERROR' };
}

/** Plugin routes enforce loopback/Host/origin themselves; native index login is a separate boundary.
 * @param {HttpContext} ctx @param {HttpService} service @returns {() => void}
 */
export function registerHttp(ctx, service) {
  if (!ctx?.webServer?.register) throw new Error('DSH webServer.register is required');
  /** @param {Request} req @param {Response} res */
  const handler = async (req, res) => {
    try {
      if (!loopback(req.socket.remoteAddress) || !allowedHost(req.headers.host)) throw httpError(403, 'LOCAL_ACCESS_REQUIRED');
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.origin !== `http://${req.headers.host}`) throw httpError(400, 'INVALID_URL');
      const pathname = url.pathname;
      if (req.method === 'GET' && (pathname === BASE || pathname === `${BASE}/`)) return send(res, 200, PANEL_HTML, 'text/html; charset=utf-8');
      if (req.method === 'GET' && pathname === `${BASE}/panel.js`) return send(res, 200, PANEL_SCRIPT, 'text/javascript; charset=utf-8');
      if (req.method === 'GET' && pathname === `${BASE}/api/status`) return send(res, 200, await service.status());
      if (req.method === 'GET' && pathname === `${BASE}/api/protocols`) return send(res, 200, await service.protocols());
      if (req.method === 'GET' && pathname === `${BASE}/api/runs`) return send(res, 200, await service.listRuns());
      if (pathname === `${BASE}/api/local` && req.method === 'GET') return send(res,200,service.localWorkspace?.status()??{available:false,calculationAvailable:false,jobs:[]});
      if (pathname.startsWith(`${BASE}/api/local/`)) {
        const workspace=service.localWorkspace;
        if(!workspace)throw httpError(409,'LOCAL_WORKSPACE_UNAVAILABLE');
        const task=pathname.match(/^\/collab\/api\/local\/tasks\/([^/]+)(?:\/(interrupt))?$/);
        if(req.method==='GET'&&task&&!task[2])return send(res,200,workspace.getTask(identifier(task[1])));
        if(req.method!=='POST')throw httpError(405,'METHOD_NOT_ALLOWED');
        postOrigin(req);const body=await bodyJSON(req);
        if(pathname===`${BASE}/api/local/tasks`)return send(res,202,await workspace.startTask(body));
        if(pathname===`${BASE}/api/local/calculations/preview`)return send(res,200,workspace.previewCalculation(body));
        if(pathname===`${BASE}/api/local/calculations/commit`)return send(res,200,workspace.commitCalculation(body));
        if(task?.[2]==='interrupt'){only(body,[]);return send(res,200,await workspace.interruptTask(identifier(task[1])));}
        throw httpError(404,'NOT_FOUND');
      }
      const match = pathname.match(/^\/collab\/api\/runs\/([^/]+)(?:\/(.*))?$/);
      if (!match) throw httpError(404, 'NOT_FOUND');
      const runId = identifier(match[1]);
      const tail = match[2] ?? '';
      if (req.method === 'GET') {
        if (!tail) {
          const snapshot=await service.describeRun(runId);
          if(url.searchParams.get('view')==='hud') {
            if(!snapshot || typeof snapshot!=='object' || !('hud' in snapshot) || !snapshot.hud)throw httpError(409,'HUD_UNAVAILABLE');
            return send(res,200,snapshot.hud);
          }
          return send(res, 200, snapshot);
        }
        const step = tail.match(/^steps\/([^/]+)$/);
        if (step) {
          /** @type {import('./types.js').StepQuery} */
          const opts = {};
          if (url.searchParams.has('attemptId')) opts.attemptId = identifier(url.searchParams.get('attemptId'));
          if (url.searchParams.has('asOfSeq')) opts.asOfSeq = integer(url.searchParams.get('asOfSeq'), 'AS_OF');
          return send(res, 200, await service.inspect(runId, identifier(step[1]), opts));
        }
        const artifact = tail.match(/^artifacts\/([^/]+)$/);
        if (artifact) {
          const start = integer(url.searchParams.get('start'), 'START', 0);
          const end = integer(url.searchParams.get('end'), 'END', start + 64 * 1024);
          if (end < start || end - start > MAX_ARTIFACT) throw httpError(400, 'INVALID_RANGE');
          // The service MUST verify that this artifact belongs to this run before opening bytes.
          const result = await service.readArtifact(runId, identifier(artifact[1]), { start, end });
          if (!Buffer.isBuffer(result?.data) || result.data.length > MAX_ARTIFACT) throw httpError(500, 'INVALID_ARTIFACT_RESPONSE');
          res.setHeader('Content-Disposition', 'attachment; filename="evidence.bin"');
          res.setHeader('X-Artifact-Media-Type', /^[\w.+-]+\/[\w.+-]+$/.test(result.mediaType ?? '') ? result.mediaType : 'application/octet-stream');
          return send(res, 200, result.data, 'application/octet-stream');
        }
        throw httpError(404, 'NOT_FOUND');
      }
      if (req.method !== 'POST') throw httpError(405, 'METHOD_NOT_ALLOWED');
      postOrigin(req);
      const body = await bodyJSON(req);
      if (tail === 'pause') {
        only(body, ['paused']);
        if (typeof body.paused !== 'boolean') throw httpError(400, 'BOOLEAN_REQUIRED');
        return send(res, 200, { result: await service.pause(runId, body.paused) });
      }
      if (tail === 'interrupt') {
        only(body, ['agentId']);
        if (typeof body.agentId !== 'string') throw httpError(400, 'AGENT_REQUIRED');
        return send(res, 200, { result: await service.interrupt(runId, identifier(body.agentId)) });
      }
      if (tail === 'control') {
        only(body, ['action', 'idempotencyKey']);
        if (typeof body.action !== 'string' || !['stop', 'retry'].includes(body.action) || typeof body.idempotencyKey !== 'string') throw httpError(400, 'INVALID_COMMAND');
        return send(res, 200, { result: await service.operatorControl({ runId, action: body.action, idempotencyKey: identifier(body.idempotencyKey) }) });
      }
      throw httpError(404, 'NOT_FOUND');
    } catch (error) {
      if (!res.headersSent) {
        const mapped = mapError(error);
        send(res, mapped.status, { error: mapped.code });
      } else res.end();
    }
  };
  const dispose = ctx.webServer.register({ kind: 'prefix', path: BASE, handler });
  if (typeof dispose === 'function') return dispose;
  if (dispose && typeof dispose.dispose === 'function') return () => dispose.dispose();
  return () => {};
}
