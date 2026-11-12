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
import { STYLES, createCapsule, createFocusLayer, createOfflinePill, createStageHook } from './focus.js';

/** How often the snapshot is polled, by what the field is doing. */
export const POLL_MS = Object.freeze({ running: 240, waiting: 600, settled: 800, empty: 1400 });

const STRINGS = Object.freeze({
  zh: {
    hint: '点击空白处或按 Esc 返回；右下角胶囊可以再进来',
    open: '点击返回',
    capsule: '返回',
    offline: 'HUD 未连接',
  },
  en: {
    hint: 'Click the empty area or press Esc to leave; the capsule at the bottom right brings it back',
    open: 'Click to return',
    capsule: 'Back',
    offline: 'HUD offline',
  },
});

/**
 * Find the surface a dialog paints, if one is open.
 *
 * Dialogs arrive as a role-annotated element, or as a full-screen fixed backdrop
 * (usually portaled next to the app root) with a card inside it. The card is the
 * largest box inside the backdrop that is still smaller than the viewport.
 */
function findDialogSurface() {
  if (typeof document === 'undefined' || document.body === null) return null;
  try {
    const explicit = document.querySelector('[aria-modal="true"], [role="dialog"], [role="alertdialog"]');
    if (explicit !== null) return dialogBox(explicit);

    const viewportWidth = globalThis.innerWidth ?? 0;
    const viewportHeight = globalThis.innerHeight ?? 0;
    if (!(viewportWidth > 0) || !(viewportHeight > 0)) return null;

    // Portals mount next to the app root, one or two levels deep: a shallow walk
    // finds them without scanning the whole app on every frame.
    const candidates = [];
    const collect = (element, depth) => {
      if (element === null || depth > 2 || candidates.length > 80) return;
      candidates.push(element);
      for (const child of element.children ?? []) collect(child, depth + 1);
    };
    for (const child of document.body.children) {
      if (child.id === 'root') {
        for (const inner of child.children) collect(inner, 0);
        continue;
      }
      collect(child, 0);
    }

    let backdrop = null;
    let bestZ = -Infinity;
    for (const element of candidates) {
      if (element.closest('[class*="dsh-hud"]') !== null) continue;
      const style = getComputedStyle(element);
      if (style.position !== 'fixed' && style.position !== 'absolute') continue;
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = element.getBoundingClientRect();
      if (!(rect.width >= viewportWidth * 0.9 && rect.height >= viewportHeight * 0.9)) continue;
      const z = Number.parseInt(style.zIndex, 10);
      const rank = Number.isFinite(z) ? z : 0;
      if (rank >= bestZ) {
        bestZ = rank;
        backdrop = element;
      }
    }
    if (backdrop === null) return null;

    let card = null;
    let largest = 0;
    for (const element of backdrop.querySelectorAll('*')) {
      const rect = element.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area < 8000) continue;
      if (rect.width >= viewportWidth - 2 && rect.height >= viewportHeight - 2) continue;
      if (area > largest) {
        largest = area;
        card = element;
      }
    }
    return dialogBox(card ?? backdrop);
  } catch {
    return null;
  }
}

/**
 * The card the user must answer, found from the controls they must press.
 *
 * A question rendered inside the message flow has no role and no backdrop, so the
 * anchor is the last interactive control in the flow: walk up from it to the card
 * that holds it. Bounded by the stage, so a stray button elsewhere is ignored.
 */
function questionCardBox(stage) {
  if (typeof document === 'undefined' || stage === null) return null;
  try {
    const host = document.querySelector('#root [data-slot="conversation.chat.flow"]')
      ?? document.querySelector('[data-slot="conversation.chat.flow"]');
    if (host === null) return null;
    const controls = [...host.querySelectorAll('button, [role="button"], input, textarea')];
    const inside = controls.filter(element => {
      const rect = element.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) return false;
      return rect.top >= stage.y - 4 && rect.bottom <= stage.y + stage.h + 4;
    });
    const anchor = inside.at(-1);
    if (anchor === undefined) return null;
    let box = null;
    let node = anchor;
    for (let hop = 0; hop < 6 && node !== null; hop += 1, node = node.parentElement) {
      const rect = node.getBoundingClientRect();
      if (rect.width >= 240 && rect.height >= 56) {
        box = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
      }
      if (rect.width >= stage.w * 0.8) break;
    }
    return box;
  } catch {
    return null;
  }
}

/** The dialog's box in viewport coordinates, or null when it has none yet. */
function dialogBox(element) {
  if (element === null || typeof element.getBoundingClientRect !== 'function') return null;
  const rect = element.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

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
  const OfflinePill = createOfflinePill(React);
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
    // The slot catalog documents `sessionId`, but the owner also passes the
    // session snapshot on some host versions; accept either without guessing.
    const id = props.sessionId ?? props.session?.id ?? props.session?.sessionId ?? props.input?.sessionId;
    React.useEffect(() => {
      store.setSession(typeof id === 'string' ? id : null);
    }, [id]);
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
    // The stylesheet lives on the entry, not on the layer: the capsule and the
    // pill also mount while the layer is gone and must keep their rules.
    const sheet = React.createElement('style', { 'data-dsh-hud': 'overlay' }, STYLES);
    const wrap = node => React.createElement(React.Fragment, null, sheet, node);
    if (!focused) {
      const showCapsule = view.taskId !== null && state.focus.dismissedTaskId !== null;
      if (showCapsule) {
        return wrap(React.createElement(Capsule, {
          view,
          stage,
          onOpen: () => store.open(),
          labels: { open: strings.open, capsule: strings.capsule },
        }));
      }
      // A session is known but the snapshot route never answered: say so instead
      // of showing the same blank screen as "nothing is happening".
      if (state.sessionId !== null && state.online === false) {
        return wrap(React.createElement(OfflinePill, { stage, text: strings.offline }));
      }
      return wrap(null);
    }
    // The scrim is split around whatever the user must interact with: a modal
    // card, or the answer controls of an inline question. The blur and the dim
    // stay everywhere else, and the sharp area stays clickable. If neither can be
    // located, the scrim steps aside rather than covering the question.
    const hole = findDialogSurface() ?? (view.pending === true ? questionCardBox(stage) : null);
    const soft = view.pending === true && hole === null;
    return wrap(React.createElement(FocusLayer, {
      view,
      stage,
      soft,
      hole: soft ? null : hole,
      onDismiss: () => store.dismiss(),
      hint: strings.hint,
      canvasProps: { getView, getStage },
    }));
  }

  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    // A negative order keeps the focus layer underneath every other overlay
    // entry, so a dialog from another plugin paints above it (§4.4, §4.6).
    { name: 'shell.overlay', id: 'hud:focus', order: -10 },
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
