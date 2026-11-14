/**
 * The focus layer — scrim, field, hint, and the return capsule of §4.4/§4.5.
 *
 * Layout is measured from the host shell's own slot hosts, never from another
 * plugin's DOM. Anchor names differ across host versions and slot hosts render
 * as `display: contents` (a 0×0 box), so every anchor is resolved by walking up
 * to the first ancestor that actually paints — otherwise the measurement fails
 * and the scrim falls back to the whole window.
 *
 * The stylesheet is owned by the overlay entry, not by the focus layer: the
 * capsule and the offline pill are also mounted while the focus layer is gone,
 * and they must keep their fixed positioning, frosting and pointer events.
 */
import { CAPSULE_INSET, hudBox, stageFor } from './render.js';
import { capsuleOf } from './model.js';
import { colorOf } from './materials.js';

/**
 * Host slot names that can anchor the conversation column, the message area and
 * the composer. Newest spellings first; the resolver accepts the first that has
 * a painted box.
 */
const COLUMN_ANCHORS = ['conversation.session', 'conversation.view', 'main.conversation', 'conversation'];
const FLOW_ANCHORS = ['conversation.chat.flow', 'conversation.view'];
const COMPOSER_ANCHORS = ['conversation.composer.bar', 'conversation.input.dock'];

/** The scrim's transition of §4.5 — one duration for position and size. */
export const STAGE_TRANSITION = 'left .26s cubic-bezier(.22,.9,.2,1), top .26s cubic-bezier(.22,.9,.2,1), width .26s cubic-bezier(.22,.9,.2,1), height .26s cubic-bezier(.22,.9,.2,1), border-radius .26s ease';

/**
 * The stylesheet, rendered once by the overlay entry so every branch (field,
 * capsule, pill) keeps its rules. `z-index` stays small on purpose: the focus
 * layer is the lowest thing in the shell's overlay so a dialog from any other
 * entry paints above it.
 */
export const STYLES = `
.dsh-hud-scrim{position:fixed;z-index:1;background:rgba(6,9,14,.45);-webkit-backdrop-filter:blur(11px);backdrop-filter:blur(11px);transition:${STAGE_TRANSITION},background .2s ease}
.dsh-hud-scrim-soft{background:transparent;-webkit-backdrop-filter:none;backdrop-filter:none;pointer-events:none}
.dsh-hud-field{position:fixed;z-index:2;pointer-events:none;transition:${STAGE_TRANSITION}}
.dsh-hud-hint{position:fixed;z-index:2;pointer-events:none;text-align:center;font-size:11px;line-height:1.6;color:rgba(150,165,185,.75);letter-spacing:.02em;text-shadow:0 1px 6px rgba(0,0,0,.5)}
.dsh-hud-capsule{position:fixed;z-index:3;display:inline-flex;align-items:center;gap:8px;padding:7px 14px 7px 11px;border-radius:999px;background:rgba(20,26,35,.55);border:1px solid rgba(255,255,255,.16);color:#dbe5f2;font-size:12px;line-height:1;cursor:pointer;pointer-events:auto;touch-action:manipulation;user-select:none;box-shadow:0 8px 26px rgba(0,0,0,.35);-webkit-backdrop-filter:blur(14px) saturate(1.2);backdrop-filter:blur(14px) saturate(1.2);transition:background .16s ease,border-color .16s ease,color .16s ease,transform .16s ease}
.dsh-hud-capsule:hover{background:rgba(30,38,50,.72);border-color:rgba(76,154,255,.55);color:#fff;transform:translateY(-1px)}
.dsh-hud-capsule:active{transform:translateY(0)}
.dsh-hud-capsule:focus-visible{outline:2px solid rgba(76,154,255,.7);outline-offset:2px}
.dsh-hud-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto}
.dsh-hud-offline{position:fixed;z-index:3;display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;background:rgba(24,20,18,.55);border:1px solid rgba(255,95,109,.35);color:#e7b0b5;font-size:11px;line-height:1;pointer-events:none;-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}
/* Light host surface: the same layer, inverted. The scrim goes pale instead of
   black, the ink goes dark, and the frosted pill becomes white glass. */
.dsh-hud-scrim.dsh-hud-light{background:rgba(248,249,252,.62);-webkit-backdrop-filter:blur(10px) saturate(1.05);backdrop-filter:blur(10px) saturate(1.05)}
.dsh-hud-hint.dsh-hud-light{color:rgba(88,102,120,.8);text-shadow:none}
.dsh-hud-capsule.dsh-hud-light{background:rgba(255,255,255,.8);border-color:rgba(15,23,42,.14);color:#1f2a3a;box-shadow:0 8px 24px rgba(15,23,42,.14)}
.dsh-hud-capsule.dsh-hud-light:hover{background:#fff;border-color:rgba(47,111,208,.55);color:#0f172a}
.dsh-hud-capsule.dsh-hud-light:focus-visible{outline-color:rgba(47,111,208,.6)}
.dsh-hud-offline.dsh-hud-light{background:rgba(255,246,247,.85);border-color:rgba(198,47,63,.32);color:#8a2432}
`;

function px(value) {
  return `${Math.round(value)}px`;
}

/** Find a slot host by key, scoping to the app root when it exists. */
function slotHost(doc, name) {
  return doc.querySelector(`#root [data-slot="${name}"]`) ?? doc.querySelector(`[data-slot="${name}"]`);
}

/**
 * The first painted box at or above a slot host.
 *
 * Slot hosts are `display: contents`, so their own rect is 0×0 and contributes
 * no box; the column (or scroll container) is the nearest ancestor that paints.
 */
function boxOfHost(host) {
  const view = host.ownerDocument?.defaultView;
  let node = host;
  for (let hop = 0; hop < 12 && node !== null && node !== undefined; hop += 1) {
    const display = view?.getComputedStyle(node).display ?? '';
    if (display === 'contents') {
      node = node.parentElement;
      continue;
    }
    const rect = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;
    if (rect !== null && rect.width > 1 && rect.height > 1) return rect;
    node = node.parentElement;
  }
  return null;
}

/** Resolve the first anchor that measures. */
function rectOfSlots(doc, names) {
  for (const name of names) {
    const host = slotHost(doc, name);
    if (host === null || host === undefined) continue;
    const rect = boxOfHost(host);
    if (rect !== null) return rect;
  }
  return null;
}

/**
 * Measure the stage in viewport coordinates.
 *
 * Left/right come from the conversation column; the top from the message area;
 * the bottom from the composer's top edge (the composer must stay sharp and
 * clickable). Every edge is clamped by {@link stageFor}. Without a document the
 * stage is the empty window.
 */
export function measureStage(doc = typeof document === 'undefined' ? undefined : document) {
  if (doc === undefined || doc === null) return stageFor({ width: 0, height: 0 }, null);
  const viewport = { width: doc.defaultView?.innerWidth ?? 0, height: doc.defaultView?.innerHeight ?? 0 };
  const column = rectOfSlots(doc, COLUMN_ANCHORS);
  const flow = rectOfSlots(doc, FLOW_ANCHORS);
  const composer = rectOfSlots(doc, COMPOSER_ANCHORS);

  let center = null;
  if (column !== null) {
    const top = flow !== null ? Math.max(flow.top, column.top) : column.top;
    const limit = Math.min(composer !== null ? composer.top : column.bottom, column.bottom);
    // A tall approval panel can push the composer past the message area, or off
    // the screen entirely. A collapsed limit must not collapse the *measurement*
    // into the full-window fallback: when the composer no longer sits below the
    // top, the column's own bottom (clamped to the viewport) is the floor.
    const bottom = limit > top ? limit : Math.max(top, Math.min(column.bottom, viewport.height));
    if (bottom > top) center = { left: column.left, right: column.right, top, bottom };
  } else if (flow !== null) {
    const bottom = composer !== null ? Math.min(flow.bottom, composer.top) : flow.bottom;
    if (bottom > flow.top) center = { left: flow.left, right: flow.right, top: flow.top, bottom };
  }
  return stageFor(viewport, center);
}

/**
 * Split the scrim into the pieces around a hole.
 *
 * Four plain boxes instead of a CSS mask: no `mask-composite` support to depend
 * on, and the hole's edge is exactly where the blur should stop. The pieces are
 * click-through, so the surface inside the hole keeps receiving input.
 *
 * @param stage - the measured message area.
 * @param hole - `{x, y, width, height}` of the surface to keep sharp, or null.
 * @param pad - how far the sharp area extends past its own box.
 * @returns the stage box itself when there is no hole, otherwise up to four boxes.
 */
export function scrimPieces(stage, hole, pad = 10) {
  const stageBox = { x: stage.x, y: stage.y, w: stage.w, h: stage.h, radius: stage.radius ?? 0, full: stage.full === true };
  if (hole === null || hole === undefined) return [stageBox];
  const width = Number.isFinite(hole.width) ? hole.width : 0;
  const height = Number.isFinite(hole.height) ? hole.height : 0;
  if (!(width > 0) || !(height > 0)) return [stageBox];
  const x = hole.x - pad;
  const y = hole.y - pad;
  const w = width + pad * 2;
  const h = height + pad * 2;
  const top = Math.max(stage.y, y);
  const bottom = Math.min(stage.y + stage.h, y + h);
  const left = Math.max(stage.x, x);
  const right = Math.min(stage.x + stage.w, x + w);
  const pieces = [
    { x: stage.x, y: stage.y, w: stage.w, h: Math.max(0, top - stage.y) },
    { x: stage.x, y: bottom, w: stage.w, h: Math.max(0, stage.y + stage.h - bottom) },
    { x: stage.x, y: top, w: Math.max(0, left - stage.x), h: Math.max(0, bottom - top) },
    { x: right, y: top, w: Math.max(0, stage.x + stage.w - right), h: Math.max(0, bottom - top) },
  ];
  const visible = pieces.filter(piece => piece.w > 0 && piece.h > 0);
  // Nothing left to blur: the dialog covers the whole stage, so the scrim must
  // get out of the way instead of covering it.
  return visible.map(piece => ({ ...piece, radius: 0, full: false }));
}

/**
 * Relative luminance of a computed CSS colour, or `null` when it is unknown or
 * effectively transparent (the caller then keeps walking up the tree).
 */
export function luminanceOf(css) {
  const match = /^rgba?\(([^)]+)\)$/i.exec(typeof css === 'string' ? css.trim() : '');
  if (match === null) return null;
  const parts = match[1].split(/[,/\s]+/).filter(Boolean).map(value => Number.parseFloat(value));
  if (parts.length < 3 || parts.slice(0, 3).some(value => !Number.isFinite(value))) return null;
  const alpha = parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1;
  if (alpha <= 0.05) return null;
  const linear = value => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(parts[0]) + 0.7152 * linear(parts[1]) + 0.0722 * linear(parts[2]);
}

/** Which palette suits a surface. Dark is the safe default. */
export function themeNameFor(luminance) {
  return Number.isFinite(luminance) && luminance > 0.5 ? 'light' : 'dark';
}

/**
 * Pick a palette from the host's own painted surface.
 *
 * Not a theme API: the shell may follow the OS, a profile setting or a
 * per-session override, and only the rendered pixels know the answer. The slot
 * hosts are `display: contents`, so the walk goes up until something paints.
 */
export function measureTheme(doc = typeof document === 'undefined' ? undefined : document) {
  if (doc === undefined || doc === null) return 'dark';
  const view = doc.defaultView;
  let node = slotHost(doc, COLUMN_ANCHORS[0]) ?? doc.body ?? null;
  for (let hop = 0; hop < 12 && node !== null && node !== undefined; hop += 1) {
    const style = view?.getComputedStyle(node);
    const luminance = luminanceOf(style === undefined ? '' : style.backgroundColor);
    if (luminance !== null) return themeNameFor(luminance);
    node = node.parentElement;
  }
  try {
    const media = view?.matchMedia?.('(prefers-color-scheme: dark)');
    if (media !== undefined && media !== null) return media.matches === true ? 'dark' : 'light';
  } catch {
    // no media support: keep the dark default
  }
  return 'dark';
}

/**
 * Track the stage. Recovers from boot swaps and panel animation without polling
 * the document on every streamed token: a rAF-debounced mutation watcher plus a
 * slow safety net. The theme rides along on the same watcher, so a light/dark
 * switch in the shell repaints the field on the next frame.
 */
export function createStageHook(React) {
  return function useStage() {
    const [state, setState] = React.useState(() => ({ stage: measureStage(), theme: measureTheme() }));
    React.useEffect(() => {
      let disposed = false;
      let scheduled = 0;
      let retry = 0;
      const measure = () => {
        if (disposed) return;
        const nextStage = measureStage();
        const nextTheme = measureTheme();
        setState(prev => (prev.stage.x === nextStage.x && prev.stage.y === nextStage.y
          && prev.stage.w === nextStage.w && prev.stage.h === nextStage.h
          && prev.stage.full === nextStage.full && prev.theme === nextTheme
          ? prev
          : { stage: nextStage, theme: nextTheme }));
      };
      const schedule = () => {
        if (scheduled !== 0) return;
        scheduled = globalThis.requestAnimationFrame(() => {
          scheduled = 0;
          measure();
        });
      };
      measure();
      const root = document.getElementById('root');
      const watcher = new MutationObserver(schedule);
      if (root !== null) watcher.observe(root, { childList: true, subtree: true });
      const styleWatcher = new MutationObserver(schedule);
      styleWatcher.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
      globalThis.addEventListener('resize', schedule);
      retry = globalThis.setInterval(schedule, 1500);
      return () => {
        disposed = true;
        if (scheduled !== 0) globalThis.cancelAnimationFrame(scheduled);
        globalThis.clearInterval(retry);
        watcher.disconnect();
        styleWatcher.disconnect();
        globalThis.removeEventListener('resize', schedule);
      };
    }, []);
    return state;
  };
}

/**
 * The focus layer: scrim, field and hint. The stylesheet is rendered by the
 * overlay entry, so this component only draws its own nodes.
 *
 * @param React - the host's React module.
 */
export function createFocusLayer(React, options = {}) {
  const FieldCanvas = options.FieldCanvas;
  return function FocusLayer(props) {
    const { view, stage, onDismiss, hint, soft, hole, theme } = props;
    const themeClass = theme === 'light' ? ' dsh-hud-light' : '';
    const box = hudBox(stage);
    const hintBottom = Math.max(12, (globalThis.innerHeight ?? 0) - (stage.y + stage.h) + 12);
    const pieces = soft === true ? [] : scrimPieces(stage, hole);
    const clickThrough = soft === true || pieces.length > 1;
    const scrims = soft === true ? null : pieces.map((piece, index) => React.createElement('div', {
      key: `scrim-${index}`,
      className: `dsh-hud-scrim${themeClass}`,
      onClick: clickThrough ? undefined : onDismiss,
      'aria-hidden': true,
      style: {
        left: px(piece.x),
        top: px(piece.y),
        width: px(piece.w),
        height: px(piece.h),
        borderRadius: `${piece.radius ?? 0}px`,
        pointerEvents: clickThrough ? 'none' : undefined,
      },
    }));
    return React.createElement(
      React.Fragment,
      null,
      scrims,
      React.createElement(
        'div',
        {
          className: 'dsh-hud-field',
          style: { left: px(box.x), top: px(box.y), width: px(box.size), height: px(box.size) },
        },
        FieldCanvas === undefined || FieldCanvas === null ? null : React.createElement(FieldCanvas, props.canvasProps),
      ),
      props.showHint === false || soft === true
        ? null
        : React.createElement(
          'div',
          { className: `dsh-hud-hint${themeClass}`, style: { left: px(stage.x), width: px(stage.w), bottom: px(hintBottom) } },
          hint,
        ),
    );
  };
}

/**
 * A small pill shown only when the page cannot read its snapshot.
 *
 * A healthy field never draws it: it exists so "nothing is happening" and "the
 * Host half is unreachable" are visibly different states instead of the same
 * blank screen.
 */
export function createOfflinePill(React) {
  return function OfflinePill(props) {
    const { stage, text, theme } = props;
    const themeClass = theme === 'light' ? ' dsh-hud-light' : '';
    const left = Math.max(stage.x + 8, stage.x + stage.w - 132 - CAPSULE_INSET.right);
    const top = Math.max(stage.y + 8, stage.y + stage.h - 26 - CAPSULE_INSET.bottom);
    return React.createElement('div', { className: `dsh-hud-offline${themeClass}`, style: { left: px(left), top: px(top) } }, text);
  };
}

/**
 * The return capsule (§4.4): a frosted `返回` pill pinned inside the message
 * area's bottom-right, clear of the composer and the send/stop button.
 *
 * Placement uses `right`/`bottom` insets computed from the stage instead of
 * `left`/`top` from a measured width, so it lands correctly on the first frame —
 * before any measurement — and keeps hugging the corner as the panel animates.
 */
export function createCapsule(React) {
  return function Capsule(props) {
    const { view, stage, onOpen, labels, theme } = props;
    const themeClass = theme === 'light' ? ' dsh-hud-light' : '';
    const state = capsuleOf(view);
    const dot = colorOf(state.state, theme);
    const stageRight = stage.x + stage.w;
    const stageBottom = stage.y + stage.h;
    const insetRight = Math.max(0, (globalThis.innerWidth ?? stageRight) - stageRight) + CAPSULE_INSET.right;
    const insetBottom = Math.max(0, (globalThis.innerHeight ?? stageBottom) - stageBottom) + CAPSULE_INSET.bottom;
    return React.createElement(
      'button',
      {
        type: 'button',
        className: `dsh-hud-capsule${themeClass}`,
        onPointerDown: event => event.stopPropagation(),
        onClick: event => {
          event.preventDefault();
          event.stopPropagation();
          onOpen();
        },
        title: `${state.label} · ${labels.open}`,
        'aria-label': `${state.label} · ${labels.open}`,
        style: { right: px(insetRight), bottom: px(insetBottom) },
      },
      React.createElement('i', {
        className: 'dsh-hud-dot',
        style: { background: dot, boxShadow: `0 0 8px ${dot}` },
      }),
      // §5.3: the capsule speaks the run's vocabulary, so leaving the field is
      // lossless — the conclusion stays readable at the bottom-right corner.
      React.createElement('span', null, state.label),
    );
  };
}
