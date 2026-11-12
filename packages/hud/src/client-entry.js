/**
 * Browser half of @dsh-llsa/hud.
 *
 * One store, two registrations:
 *
 * - `conversation.input.dock` carries the active `sessionId` (the only thing the
 *   root-scoped overlay cannot know by itself). It renders nothing.
 * - `shell.overlay` is the frame-wide surface the focus layer and the return
 *   capsule live in. The layer is click-through except for its own scrim and
 *   capsule, so the composer below stays usable.
 *
 * The half is read-only by construction: it polls one JSON route and draws.
 * There is no write path, no tool, and no session event (§6).
 */
import { createView, foldSnapshot, nextFocus, stepLifecycle } from './model.js';
import { createFieldCanvas } from './render.js';
import { createCapsule, createFocusLayer, createStageHook } from './focus.js';

/** How often the snapshot is polled, by what the field is doing. */
export const POLL_MS = Object.freeze({ running: 240, waiting: 600, settled: 800, empty: 1400 });

const STRINGS = Object.freeze({
  zh: {
    hint: '点击空白处或按 Esc 返回；右下角胶囊可以再进来',
    open: '点击返回',
  },
  en: {
    hint: 'Click the empty area or press Esc to leave; the capsule at the bottom right brings it back',
    open: 'Click to return',
  },
});

function stringsOf(locale) {
  return /^en\b/i.test(String(locale ?? '')) ? STRINGS.en : STRINGS.zh;
}

/** The client locale service, read defensively: absence is not an error. */
function localeOf(ctx) {
  try {
    const service = ctx.get('locale');
    if (service === undefined) return 'zh';
    const snapshot = typeof service.getSnapshot === 'function' ? service.getSnapshot() : undefined;
    const id = snapshot?.id ?? snapshot?.locale ?? snapshot?.current;
    return typeof id === 'string' && id !== '' ? id : 'zh';
  } catch {
    return 'zh';
  }
}

/** A minimal external store; the overlay subscribes, the poller publishes. */
function createStore(getLocale) {
  const state = {
    sessionId: null,
    view: createView({ now: 0 }),
    focus: { taskId: null, active: false, dismissedTaskId: null, state: 'idle' },
    online: false,
    locale: 'zh',
    version: 0,
    listeners: new Set(),
  };
  const notify = () => {
    state.version += 1;
    for (const listener of state.listeners) listener();
  };
  return {
    get: () => state,
    subscribe: listener => {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
    setSession(sessionId) {
      const next = typeof sessionId === 'string' && sessionId !== '' ? sessionId : null;
      if (next === state.sessionId) return;
      state.sessionId = next;
      state.view = createView({ sessionId: next, now: globalThis.performance?.now?.() ?? 0, locale: getLocale() });
      state.focus = { taskId: null, active: false, dismissedTaskId: null, state: 'idle' };
      notify();
    },
    setLocale(locale) {
      if (state.locale === locale) return;
      state.locale = locale;
      state.view.locale = locale;
      notify();
    },
    fold(snapshot, now, meta) {
      foldSnapshot(state.view, snapshot, now, { ...meta, sessionId: state.sessionId });
      state.online = true;
      const focus = nextFocus(state.focus, state.view);
      const changedFocus = focus.active !== state.focus.active || focus.taskId !== state.focus.taskId || focus.dismissedTaskId !== state.focus.dismissedTaskId;
      state.focus = { taskId: focus.taskId, active: focus.active, dismissedTaskId: focus.dismissedTaskId, state: focus.state, reason: focus.reason };
      notify();
      return changedFocus;
    },
    offline() {
      if (state.online === false) return;
      state.online = false;
      notify();
    },
    dismiss() {
      state.focus = { ...state.focus, active: false, dismissedTaskId: state.focus.taskId };
      notify();
    },
    open() {
      state.focus = { ...state.focus, active: true, dismissedTaskId: null };
      notify();
    },
  };
}

/**
 * Register the plugin's Client half.
 *
 * @param ctx - the restricted client context.
 * @param React - the host's React module.
 */
export function applyClient(ctx, React) {
  const FieldCanvas = createFieldCanvas(React);
  const FocusLayer = createFocusLayer(React, { FieldCanvas });
  const Capsule = createCapsule(React);
  const useStage = createStageHook(React);
  const store = createStore(() => localeOf(ctx));
  store.setLocale(localeOf(ctx));

  /**
   * Poll one session's snapshot. Failures keep the last view: the field freezes
   * on its last known state instead of blanking (§5.3).
   */
  function startPolling(getSessionId) {
    let disposed = false;
    let timer = 0;
    let inFlight = false;
    const tick = async () => {
      if (disposed || inFlight) return;
      const sessionId = getSessionId();
      if (sessionId === null) {
        timer = globalThis.setTimeout(tick, POLL_MS.empty);
        return;
      }
      inFlight = true;
      try {
        const response = await fetch(`/dsh-hud/api/state?session=${encodeURIComponent(sessionId)}`, {
          headers: { accept: 'application/json' },
          cache: 'no-store',
        });
        if (!response.ok) {
          store.offline();
        } else {
          const body = await response.json();
          if (body !== null && typeof body === 'object' && body.ok === true && body.snapshot !== null && typeof body.snapshot === 'object') {
            store.fold(body.snapshot, globalThis.performance?.now?.() ?? Date.now(), body.meta ?? {});
          } else {
            store.offline();
          }
        }
      } catch {
        store.offline();
      } finally {
        inFlight = false;
      }
      const view = store.get().view;
      const delay = view.state === 'running'
        ? POLL_MS.running
        : (view.state === 'waiting-human' ? POLL_MS.waiting : POLL_MS.settled);
      if (!disposed) timer = globalThis.setTimeout(tick, delay);
    };
    timer = globalThis.setTimeout(tick, 60);
    return () => {
      disposed = true;
      globalThis.clearTimeout(timer);
    };
  }

  /** Subscribe a component to the store (React 18's external store hook). */
  function useSnapshot() {
    if (typeof React.useSyncExternalStore === 'function') {
      return React.useSyncExternalStore(store.subscribe, () => store.get().version);
    }
    const [, force] = React.useState(0);
    React.useEffect(() => store.subscribe(() => force(value => value + 1)), []);
    return store.get().version;
  }

  /** Captures the active session id; draws nothing. */
  function SessionBridge(props) {
    React.useEffect(() => {
      store.setSession(typeof props.sessionId === 'string' ? props.sessionId : null);
    }, [props.sessionId]);
    return null;
  }

  /** The focus layer and the capsule, both frame-wide. */
  function OverlayEntry() {
    useSnapshot();
    const stage = useStage();
    const state = store.get();
    const view = state.view;
    const strings = stringsOf(state.locale);
    const now = () => globalThis.performance?.now?.() ?? Date.now();
    const getView = React.useCallback(() => {
      const current = store.get().view;
      stepLifecycle(current, now());
      return current;
    }, []);
    const getStage = React.useCallback(() => stage, [stage]);

    React.useEffect(() => {
      const onKey = event => {
        if (event.key === 'Escape' && store.get().focus.active) {
          event.stopPropagation();
          store.dismiss();
        }
      };
      globalThis.addEventListener('keydown', onKey, true);
      return () => globalThis.removeEventListener('keydown', onKey, true);
    }, []);

    React.useEffect(() => {
      const unsubscribe = startPolling(() => store.get().sessionId);
      return unsubscribe;
    }, []);

    const focused = state.focus.active && view.taskId !== null;
    if (!focused) {
      const showCapsule = view.taskId !== null && state.focus.dismissedTaskId !== null;
      if (!showCapsule) return null;
      return React.createElement(Capsule, {
        view,
        stage,
        onOpen: () => store.open(),
        labels: { open: strings.open },
      });
    }
    return React.createElement(FocusLayer, {
      view,
      stage,
      onDismiss: () => store.dismiss(),
      hint: strings.hint,
      canvasProps: { getView, getStage },
    });
  }

  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: 'hud:focus', order: 40 },
    OverlayEntry,
  ));
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
    { name: 'conversation.input.dock', id: 'hud:session', order: 0 },
    SessionBridge,
  ));

  // Keep the field's labels in the page's language without re-registering slots.
  try {
    const locale = ctx.get('locale');
    if (locale !== undefined && typeof locale.subscribe === 'function') {
      const unsubscribe = locale.subscribe(() => store.setLocale(localeOf(ctx)));
      if (typeof unsubscribe === 'function') ctx.effect(() => unsubscribe);
    }
  } catch {
    // no locale service: the field keeps its default language
  }
}
