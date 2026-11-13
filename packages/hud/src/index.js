/**
 * Host half of @dsh-llsa/hud.
 *
 * It owns exactly one job: turn live DSH activity into hud-v1 snapshots and
 * serve them to the plugin's own browser half over a same-origin read-only
 * route. It registers no tool, writes no session event, changes no agent
 * behaviour, and never mutates the orchestrator (§1, §6).
 *
 * The route is deliberately tiny and session-scoped:
 *
 *     GET /dsh-hud/api/state?session=<id>   -> { ok, snapshot }
 *     GET /dsh-hud/api/ping                 -> { ok, version }
 *
 * A malformed query, an unknown session, or a missing source all answer with a
 * well-formed JSON body: the client must never see a white screen (§5.3).
 */
import {
  createCollector,
  fetchHudSnapshot,
  normalizeHudSnapshot,
  MAX_SESSIONS,
} from './source.js';
import { Config } from './config.js';

/** Re-exported so the Loader renders this plugin's settings form. */
export { Config };

/** Read-only snapshot endpoint consumed by `client.js`. */
export const ROUTE = '/dsh-hud/api/state';

/** Cheap liveness probe; also tells the client which build answered. */
export const PING_ROUTE = '/dsh-hud/api/ping';

/** Wire version of the snapshot this build produces and reads. */
export const SNAPSHOT_VERSION = 1;

const DEFAULTS = Object.freeze({
  /** Optional orchestrator endpoint template, e.g. `http://127.0.0.1:3000/collab/api/runs/{session}/hud`. */
  hudEndpoint: '',
  /** Timeout for that endpoint before falling back to core events. */
  hudTimeoutMs: 900,
  /** Sessions kept warm by the collector. */
  maxSessions: MAX_SESSIONS,
  /** How long a `listChildren` answer is reused. */
  childrenRefreshMs: 1200,
});

function normalizeConfig(config) {
  const source = config !== null && typeof config === 'object' ? config : {};
  const hudEndpoint = typeof source.hudEndpoint === 'string' ? source.hudEndpoint.trim() : '';
  return {
    // Focus mode is opt-out: an absent field means "on", matching the schema
    // default, so a hand-written `config: {}` behaves like a fresh install.
    focusMode: source.focusMode !== false,
    hudEndpoint,
    hudTimeoutMs: Number.isFinite(source.hudTimeoutMs) ? Math.max(50, source.hudTimeoutMs) : DEFAULTS.hudTimeoutMs,
    maxSessions: Number.isFinite(source.maxSessions) ? Math.max(1, Math.floor(source.maxSessions)) : DEFAULTS.maxSessions,
    childrenRefreshMs: Number.isFinite(source.childrenRefreshMs) ? Math.max(200, source.childrenRefreshMs) : DEFAULTS.childrenRefreshMs,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

/** Session ids are branded strings; every carrier here normalises to one form. */
function sessionIdOf(carrier) {
  if (typeof carrier === 'string') return carrier;
  if (carrier === null || carrier === undefined) return '';
  if (typeof carrier.id === 'string') return carrier.id;
  const header = carrier.header;
  if (header !== null && typeof header === 'object' && typeof header.id === 'string') return header.id;
  return '';
}

/**
 * @param ctx - the plugin context.
 * @param config - the loader row's config (all keys optional).
 */
export function apply(ctx, config) {
  const options = normalizeConfig(config);
  const collector = createCollector({ maxSessions: options.maxSessions });
  /** @type {Map<string, { at: number, promise: Promise<Array<{ id: string, label?: string }>> }>} */
  const childrenCache = new Map();

  ctx.on('session/event', (session, event) => {
    const sessionId = sessionIdOf(session);
    if (sessionId === '') return;
    // The session itself is passed along so the collector can seed the task line
    // from the log when the plugin was activated mid-turn.
    collector.observeEvent(sessionId, event, session);
  });

  ctx.on('agent/status', payload => {
    if (payload === null || typeof payload !== 'object') return;
    const sessionId = sessionIdOf(payload.agent);
    if (sessionId === '') return;
    collector.observeStatus(sessionId, payload.status);
  });

  // A published child is created and retired outside the parent's log, so the
  // cached child list is invalidated by the subagent events themselves.
  const invalidateChildren = () => childrenCache.clear();
  ctx.on('subagent/start', invalidateChildren);
  ctx.on('subagent/end', invalidateChildren);
  ctx.on('session/disposed', session => {
    const sessionId = sessionIdOf(session);
    if (sessionId !== '') collector.forget(sessionId);
  });

  /** Published sub-agents of one session, with the labels the parent gave them. */
  async function childrenOf(sessionId) {
    const service = ctx.get('subagents');
    if (service === undefined || typeof service.listChildren !== 'function') return [];
    const cached = childrenCache.get(sessionId);
    const now = Date.now();
    if (cached !== undefined && now - cached.at < options.childrenRefreshMs) return cached.promise;
    const promise = (async () => {
      try {
        const entries = await service.listChildren(sessionId);
        if (!Array.isArray(entries)) return [];
        return entries
          .filter(entry => entry !== null && typeof entry === 'object' && entry.id !== undefined)
          .map(entry => ({ id: String(entry.id), label: typeof entry.label === 'string' ? entry.label : undefined }));
      } catch {
        return [];
      }
    })();
    childrenCache.set(sessionId, { at: now, promise });
    return promise;
  }

  async function snapshotFor(sessionId) {
    if (options.hudEndpoint !== '') {
      const external = await fetchHudSnapshot(options.hudEndpoint, sessionId, { timeoutMs: options.hudTimeoutMs });
      if (external !== undefined) {
        // An orchestrator already speaks hud-v1; it owns its own hints, so the
        // derived ones stay empty rather than guessing on its behalf.
        return {
          snapshot: external,
          meta: { sessionId, source: 'hud', taskText: '', focusMode: options.focusMode, exec: null, materials: {} },
        };
      }
    }
    const children = await childrenOf(sessionId);
    return {
      snapshot: collector.snapshotFor(sessionId, { children }),
      meta: {
        sessionId,
        source: 'core',
        taskText: collector.taskTextOf(sessionId),
        // Rides in `meta`, not the snapshot: the frozen schema forbids extra keys.
        focusMode: options.focusMode,
        // §7: derived enums only — never the call's raw arguments.
        exec: collector.execOf(sessionId),
        materials: collector.materialsOf(sessionId),
      },
    };
  }

  const handler = async request => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === PING_ROUTE) {
      return jsonResponse({ ok: true, version: SNAPSHOT_VERSION, route: ROUTE, focusMode: options.focusMode });
    }
    const sessionId = url.searchParams.get('session');
    if (sessionId === null || sessionId === '') {
      return jsonResponse({ ok: false, error: 'session-required' }, 400);
    }
    try {
      const { snapshot, meta } = await snapshotFor(sessionId);
      return jsonResponse({ ok: true, snapshot, meta });
    } catch (error) {
      // Never surface a stack to the page; the client degrades to "no HUD".
      return jsonResponse({ ok: false, error: 'snapshot-failed', message: String(error?.message ?? error) }, 200);
    }
  };

  /**
   * Register both routes on the web carrier, if it exists right now.
   *
   * The carrier may not exist yet: on an app restart the Loader can activate this
   * row before `webServer` is up, and asking once would leave the page with no
   * route for the rest of the session ("HUD 未连接" forever). So registration is
   * retried until the service appears, and the effect removes it on dispose.
   *
   * @returns a disposer when the routes were registered, otherwise `null`.
   */
  const attachRoutes = () => {
    const server = ctx.get('webServer');
    if (server === undefined || typeof server.register !== 'function') return null;
    const detachRoute = server.register({ kind: 'exact', path: ROUTE, resource: handler });
    const detachPing = server.register({ kind: 'exact', path: PING_ROUTE, resource: handler });
    return () => {
      try {
        detachRoute();
      } catch {
        // a carrier that already dropped the route must not break disposal
      }
      try {
        detachPing();
      } catch {
        // same
      }
    };
  };

  ctx.effect(() => {
    let detach = attachRoutes();
    let timer = 0;
    let delay = 200;
    // Bounded backoff: a non-web profile never gets a carrier, so the wait must
    // become cheap instead of polling forever at 5 Hz.
    const wait = () => {
      if (detach !== null) return;
      timer = globalThis.setTimeout(() => {
        timer = 0;
        detach = attachRoutes();
        if (detach === null) {
          delay = Math.min(delay * 2, 2000);
          wait();
        }
      }, delay);
      // A Host-side plugin must never hold the process open while it waits for a
      // carrier that may never exist (a TUI profile, a test harness).
      timer?.unref?.();
    };
    if (detach === null) wait();
    return () => {
      if (timer !== 0) globalThis.clearTimeout(timer);
      if (detach !== null) detach();
    };
  });
}

/**
 * Exported for tests and for the browser-side fixture loader: a HudSnapshot
 * payload is accepted in its bare or `{ snapshot }`-wrapped form.
 */
export { normalizeHudSnapshot };
