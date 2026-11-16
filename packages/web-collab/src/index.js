import { readFileSync } from 'node:fs'
import { Service } from '@deepseek-ai/cordis'
import { browserAdvisor } from './browser-advisor.js'
import { ChildConsultations } from './child-consultations.js'
import { SingleAgentJobs } from './single-agent.js'
import { TASK_BODY_LIMIT } from './task-evidence.js'

export const name = 'dsh-web-collab'
export const inject = ['webServer', 'agents', 'llm', 'sessionTitle']

const BASE = '/web-collab'
const loopback = address => address === '::1' || address === '127.0.0.1' || address === '::ffff:127.0.0.1'
const fail = (status, code) => Object.assign(new Error(code), { status, code })

class WebChildConsultationService extends Service {
  constructor(ctx, consultations) {
    super(ctx, 'webChildConsultations')
    this.consultations = consultations
  }

  ask(request) { return this.consultations.ask(request) }
}

function send(res, status, value, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
  })
  res.end(type.startsWith('application/json') ? JSON.stringify(value) : value)
}

async function readBody(req, limit = 128 * 1024) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw fail(415, 'JSON_REQUIRED')
  }
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > limit) throw fail(413, 'BODY_TOO_LARGE')
    chunks.push(bytes)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Object required')
    return value
  } catch { throw fail(400, 'INVALID_JSON') }
}

export function apply(ctx) {
  if (!loopback(ctx.webServer.host)) throw new Error('Web collaboration requires a loopback Harness web server')
  const assets = new Map([
    ['', ['panel.html', 'text/html; charset=utf-8']],
    ['/', ['panel.html', 'text/html; charset=utf-8']],
    ['/panel.js', ['panel.js', 'text/javascript; charset=utf-8']],
    ['/native-handoff.js', ['native-handoff.js', 'text/javascript; charset=utf-8']],
    ['/task-evidence.js', ['task-evidence.js', 'text/javascript; charset=utf-8']],
  ].map(([route, [file, type]]) => [BASE + route, [readFileSync(new URL(file, import.meta.url)), type]]))
  const advisor = browserAdvisor(process.env)
  const consultations = new ChildConsultations(advisor)
  new WebChildConsultationService(ctx, consultations)
  const jobs = new SingleAgentJobs(ctx)
  const dispose = ctx.webServer.register({ kind: 'prefix', path: BASE, handler: async (req, res) => {
    try {
      const host = req.headers.host
      const port = ctx.webServer.port
      if (!port || !loopback(req.socket.remoteAddress) ||
          ![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host)) {
        throw fail(403, 'LOCAL_ACCESS_REQUIRED')
      }
      const origin = `http://${host}`
      const url = new URL(req.url, origin)
      if (url.origin !== origin) throw fail(400, 'INVALID_URL')
      const path = url.pathname
      const asset = assets.get(path)
      if (req.method === 'GET' && asset) return send(res, 200, ...asset)
      if (req.headers['x-web-collab-request'] !== '1' || req.headers['sec-fetch-site'] === 'cross-site' ||
          (req.headers.origin !== undefined && req.headers.origin !== origin) ||
          (req.method === 'POST' && req.headers.origin !== origin)) {
        throw fail(403, 'SAME_ORIGIN_REQUIRED')
      }
      const job = path.match(/^\/web-collab\/api\/jobs\/([a-zA-Z0-9-]+)(\/interrupt)?$/)
      const consultation = path.match(/^\/web-collab\/api\/child-consultations\/([a-f0-9-]{36})\/complete$/)
      if (req.method === 'GET') {
        if (path === BASE + '/api/status') return send(res, 200, { ...jobs.status(), advisorAvailable: advisor.available })
        if (path === BASE + '/api/child-consultations') return send(res, 200, consultations.listPending())
        if (job && !job[2]) return send(res, 200, jobs.get(job[1]))
      }
      if (req.method === 'POST') {
        if (path === BASE + '/api/advice') return send(res, 200, await advisor.consult(await readBody(req)))
        if (consultation) return send(res, 200, consultations.complete(consultation[1], await readBody(req)))
        if (path === BASE + '/api/jobs') return send(res, 202, jobs.start(await readBody(req, TASK_BODY_LIMIT)))
        if (job?.[2]) {
          if (Object.keys(await readBody(req)).length) throw fail(400, 'INVALID_JSON')
          return send(res, 200, await jobs.interrupt(job[1]))
        }
      }
      throw fail(404, 'NOT_FOUND')
    } catch (error) {
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500
      const code = /^[A-Z][A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : 'INTERNAL_ERROR'
      send(res, status, { error: code })
    }
  } })
  ctx.effect(() => async () => {
    dispose()
    consultations.close()
    advisor.close()
    await jobs.close()
  })
}
