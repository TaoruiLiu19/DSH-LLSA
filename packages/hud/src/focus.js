/**
 * The focus layer — scrim, field, hint, and the return capsule of §4.4/§4.5.
 *
 * Layout is measured from the host shell's own slot hosts, never from another
 * plugin's DOM: the conversation column is the ancestor that renders a box
 * around `main.conversation`, and the message area is the chat-flow host inside
 * it. Everything else (composer, tabs, side panels) stays sharp because the
 * scrim simply does not cover it.
 */
import { CAPSULE_INSET, hudBox, stageFor } from './render.js';
import { capsuleOf } from './model.js';
import { colorOf } from './materials.js';

/** Slots this layer anchors on; both spellings exist across host versions. */
const COLUMN_SELECTOR = '#root [data-slot="main.conversation"], #root [data-slot="conversation"]';
const FLOW_SELECTOR = '#root [data-slot="conversation.chat.flow"]';
const COMPOSER_SELECTOR = '#root [data-slot="conversation.composer.bar"]';

/** The scrim's transition of §4.5 — one duration for position and size. */
export const STAGE_TRANSITION = 'left .26s cubic-bezier(.22,.9,.2,1), top .26s cubic-bezier(.22,.9,.2,1), width .26s cubic-bezier(.22,.9,.2,1), height .26s cubic-bezier(.22,.9,.2,1), border-radius .26s ease';

/** The stylesheet the layer renders as an element, so unmounting removes it. */
export const STYLES = `
.dsh-hud-scrim{position:fixed;z-index:40;background:rgba(6,9,14,.45);-webkit-backdrop-filter:blur(11px);backdrop-filter:blur(11px);transition:${STAGE_TRANSITION}}
.dsh-hud-field{position:fixed;z-index:41;pointer-events:none;transition:${STAGE_TRANSITION}}
.dsh-hud-hint{position:fixed;z-index:42;pointer-events:none;text-align:center;font-size:11px;line-height:1.6;color:rgba(150,165,185,.75);letter-spacing:.02em}
.dsh-hud-capsule{position:fixed;z-index:43;display:inline-flex;align-items:center;gap:9px;padding:9px 15px 9px 12px;border-radius:999px;background:rgba(18,23,31,.92);border:1px solid rgba(255,255,255,.1);color:#c3cedd;font-size:12.5px;line-height:1;cursor:pointer;box-shadow:0 12px 34px rgba(0,0,0,.45);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);transition:border-color .18s ease,color .18s ease,transform .18s ease}
.dsh-hud-capsule:hover{border-color:rgba(76,154,255,.5);color:#fff}
.dsh-hud-capsule:focus-visible{outline:2px solid rgba(76,154,255,.7);outline-offset:2px}
.dsh-hud-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto}
.dsh-hud-capsule small{color:#6f7d90;font-size:11px;margin-left:2px}
`;

function px(value) {
  return `${Math.round(value)}px`;
}

/** The conversation column: the first ancestor that actually renders a box. */
function resolveColumn(doc) {
  const host = doc.querySelector(COLUMN_SELECTOR);
  if (host === null) return null;
  const view = host.ownerDocument.defaultView;
  let node = host.parentElement;
  while (node !== null && (view?.getComputedStyle(node).display ?? '') === 'contents') {
    node = node.parentElement;
  }
  return node;
}

/**
 * Measure the stage in viewport coordinates.
 *
 * The message area is the chat-flow host when the shell renders one; otherwise
 * the column is used and clipped at the composer's top edge. Both measurements
 * are reads only. Without a document (unit tests, a boot before the shell) the
 * stage is the empty window.
 */
export function measureStage(doc = typeof document === 'undefined' ? undefined : document) {
  if (doc === undefined) return stageFor({ width: 0, height: 0 }, null);
  const viewport = { width: doc.defaultView?.innerWidth ?? 0, height: doc.defaultView?.innerHeight ?? 0 };
  const column = resolveColumn(doc);
  const columnRect = column === null ? null : column.getBoundingClientRect();
  const flow = doc.querySelector(FLOW_SELECTOR);
  const composer = doc.querySelector(COMPOSER_SELECTOR);
  let center = null;
  if (flow !== null) {
    const rect = flow.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      center = { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    }
  } else if (columnRect !== null && columnRect.width > 0) {
    center = { left: columnRect.left, right: columnRect.right, top: columnRect.top, bottom: columnRect.bottom };
  }
  if (center === null) return stageFor(viewport, null);
  // The chat flow scrolls, so its box can start above the viewport; the composer
  // and the column edges cap it so the scrim never covers the composer card.
  if (composer !== null) center.bottom = Math.min(center.bottom, composer.getBoundingClientRect().top);
  if (columnRect !== null) {
    center.left = Math.max(center.left, columnRect.left);
    center.right = Math.min(center.right, columnRect.right);
  }
  return stageFor(viewport, center);
}

/**
 * Track the stage. Recovers from boot swaps and panel animation without polling
 * the document on every streamed token: a rAF-debounced mutation watcher plus a
 * slow safety net while nothing has been measured.
 */
export function createStageHook(React) {
  return function useStage() {
    const [stage, setStage] = React.useState(() => measureStage());
    React.useEffect(() => {
      let disposed = false;
      let scheduled = 0;
      let retry = 0;
      const measure = () => {
        if (disposed) return;
        const next = measureStage();
        setStage(prev => (prev.x === next.x && prev.y === next.y && prev.w === next.w && prev.h === next.h && prev.full === next.full ? prev : next));
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
    return stage;
  };
}

/**
 * The focus layer: scrim, field and hint.
 *
 * @param React - the host's React module.
 */
export function createFocusLayer(React, options = {}) {
  const FieldCanvas = options.FieldCanvas;
  return function FocusLayer(props) {
    const { view, stage, onDismiss, hint } = props;
    const box = hudBox(stage);
    return React.createElement(
      React.Fragment,
      null,
      React.createElement('style', { 'data-dsh-hud': 'focus' }, STYLES),
      React.createElement('div', {
        className: 'dsh-hud-scrim',
        onClick: onDismiss,
        'aria-hidden': true,
        style: {
          left: px(stage.x),
          top: px(stage.y),
          width: px(stage.w),
          height: px(stage.h),
          borderRadius: `${stage.radius}px`,
        },
      }),
      React.createElement(
        'div',
        {
          className: 'dsh-hud-field',
          style: { left: px(box.x), top: px(box.y), width: px(box.size), height: px(box.size) },
        },
        FieldCanvas === undefined || FieldCanvas === null ? null : React.createElement(FieldCanvas, props.canvasProps),
      ),
      props.showHint === false
        ? null
        : React.createElement(
          'div',
          {
            className: 'dsh-hud-hint',
            style: { left: px(stage.x), width: px(stage.w), bottom: px(Math.max(12, globalThis.innerHeight - (stage.y + stage.h) + 12)) },
          },
          hint,
        ),
    );
  };
}

/**
 * The return capsule (§4.4): pinned inside the message area's bottom-right, so
 * it never overlaps the composer or the send/stop button.
 */
export function createCapsule(React) {
  return function Capsule(props) {
    const { view, stage, onOpen, labels } = props;
    const ref = React.useRef(null);
    const [size, setSize] = React.useState({ width: 132, height: 34 });
    React.useLayoutEffect(() => {
      const node = ref.current;
      if (node === null) return;
      const rect = node.getBoundingClientRect();
      if (rect.width > 0 && (Math.abs(rect.width - size.width) > 0.5 || Math.abs(rect.height - size.height) > 0.5)) {
        setSize({ width: rect.width, height: rect.height });
      }
    });
    const state = capsuleOf(view);
    const left = Math.max(stage.x + 8, stage.x + stage.w - size.width - CAPSULE_INSET.right);
    const top = Math.max(stage.y + 8, stage.y + stage.h - size.height - CAPSULE_INSET.bottom);
    return React.createElement(
      'button',
      {
        ref,
        type: 'button',
        className: 'dsh-hud-capsule',
        onClick: onOpen,
        title: labels.open,
        'aria-label': `${state.label} · ${labels.open}`,
        style: { left: px(left), top: px(top) },
      },
      React.createElement('i', {
        className: 'dsh-hud-dot',
        style: { background: colorOf(state.state), boxShadow: `0 0 10px ${colorOf(state.state)}` },
      }),
      React.createElement('span', null, state.label),
      React.createElement('small', null, labels.open),
    );
  };
}
