/**
 * The field renderer — a canvas of concentric rings plus a centre block.
 *
 * The pure maths (stage box, seat angles, ring radii) live at the top so the
 * tests can pin the two layout tiers of §4.5 without a browser. The drawing
 * itself is artwork: literal colours from §4.1 are allowed here, and nothing
 * here reads the host's DOM or another plugin's styles.
 */
import { colorOf, materialDoneLabel, materialLabel, paletteOf, seatIndexOf, stateLabel } from './materials.js';
import { TIMING, centerText, stepLifecycle } from './model.js';

/** Distance from the stage edge the capsule keeps (§4.4). */
export const CAPSULE_INSET = Object.freeze({ right: 18, bottom: 16 });

/** Radius of the scrim inside the conversation column (§4.5). */
export const STAGE_RADIUS = 14;

/** HUD diameter as a share of the stage's short side (§4.5). */
export const HUD_SCALE = Object.freeze({ windowed: 0.97, column: 0.9 });

/** The eight materials sit on one ring; the AGENT ring sits inside it. */
export const RINGS = Object.freeze({ material: 0.335, agent: 0.19 });

function clampInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : fallback;
}

/**
 * Stage for the two layout tiers of §4.5.
 *
 * `center` is the conversation column's box in viewport coordinates. Both side
 * panels expanded means the column is inset on both sides, and then — and only
 * then — the scrim is the rounded column. Any collapsed panel makes the column
 * flush with the window, and the scrim covers everything, square.
 *
 * @param viewport - `{ width, height }`.
 * @param center - `{ left, right, top, bottom }` or `null` when unmeasured.
 */
export function stageFor(viewport, center) {
  const width = clampInt(viewport?.width, 0);
  const height = clampInt(viewport?.height, 0);
  const full = { x: 0, y: 0, w: width, h: height, radius: 0, full: true };
  if (center === null || center === undefined) return full;
  // A measured column can reach outside the viewport — the chat flow grows with
  // its content and scrolls — so every edge is clamped before it becomes a box.
  const clamp = (value, low, high, fallback) => Math.max(low, Math.min(high, clampInt(value, fallback)));
  const left = clamp(center.left, 0, width, 0);
  const right = clamp(center.right, 0, width, width);
  const top = clamp(center.top, 0, height, 0);
  const bottom = clamp(center.bottom, 0, height, height);
  const column = { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top), radius: STAGE_RADIUS, full: false };
  // Side panels are open when the column does not reach either edge. Height is
  // deliberately *not* part of this: a tall approval panel compresses the
  // message area without making it stop being the message area, and promoting a
  // short column to the whole window is what turned the blur full-screen.
  const bothPanelsOpen = left > 1 && right < width - 1 && column.w > 240 && column.h > 80;
  return bothPanelsOpen ? column : full;
}

/** The square the HUD itself occupies, centred inside the stage. */
export function hudBox(stage) {
  const shortSide = Math.min(stage.w, stage.h);
  const size = Math.max(0, Math.round(shortSide * (stage.full ? HUD_SCALE.windowed : HUD_SCALE.column)));
  return {
    x: Math.round(stage.x + (stage.w - size) / 2),
    y: Math.round(stage.y + (stage.h - size) / 2),
    size,
  };
}

/** Where the return capsule parks: inside the message area's bottom-right. */
export function capsuleBox(stage, capsuleSize) {
  const width = clampInt(capsuleSize?.width, 132);
  const height = clampInt(capsuleSize?.height, 34);
  return {
    x: Math.max(stage.x + 8, stage.x + stage.w - width - CAPSULE_INSET.right),
    y: Math.max(stage.y + 8, stage.y + stage.h - height - CAPSULE_INSET.bottom),
    width,
    height,
  };
}

/** Ring radii for one HUD size. */
export function ringGeometry(size) {
  const shortSide = Math.max(1, size);
  return {
    size: shortSide,
    cx: shortSide / 2,
    cy: shortSide / 2,
    material: shortSide * RINGS.material,
    agent: shortSide * RINGS.agent,
    /** type scale, 1 at the 560px reference size used by the demo. */
    k: shortSide / 560,
  };
}

/** Even seat angles on a ring, starting at 12 o'clock (deterministic order). */
export function seatAngles(count) {
  const total = Math.max(0, Math.round(count));
  if (total === 0) return [];
  const step = (Math.PI * 2) / total;
  return Array.from({ length: total }, (_, index) => -Math.PI / 2 + index * step);
}

/** The eight-slot ladder of §1.1: one angle per slot, 45° apart from 12 o'clock. */
export const SEAT_STEP = Math.PI / 4;
export const SEAT_START = -Math.PI / 2;

/**
 * The fixed angle of one material's seat, or `null` when it has no slot.
 *
 * §1.1: a material the table does not know still needs a home, and inventing a
 * new angle would move every other node. It falls back to the 其它 slot.
 */
export function seatAngleFor(materialId) {
  const index = seatIndexOf(materialId);
  if (index < 0) return null;
  return SEAT_START + index * SEAT_STEP;
}

/** A point on a ring. */
export function seatPoint(geometry, angle, radius) {
  return { x: geometry.cx + Math.cos(angle) * radius, y: geometry.cy + Math.sin(angle) * radius };
}

/** Text anchor that keeps labels away from the ring they belong to. */
export function labelAnchor(angle) {
  const cos = Math.cos(angle);
  if (Math.abs(cos) < 0.3) return 'center';
  return cos > 0 ? 'left' : 'right';
}

function rgba(hex, alpha) {
  const value = typeof hex === 'string' && hex.startsWith('#') ? hex.slice(1) : '96aac3';
  const normalized = value.length === 3 ? value.split('').map(ch => ch + ch).join('') : value.padEnd(6, '0');
  const r = parseInt(normalized.slice(0, 2), 16) || 0;
  const g = parseInt(normalized.slice(2, 4), 16) || 0;
  const b = parseInt(normalized.slice(4, 6), 16) || 0;
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha))})`;
}

function glow(context, x, y, radius, hex, alpha) {
  if (alpha <= 0.004) return;
  const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
  gradient.addColorStop(0, rgba(hex, alpha));
  gradient.addColorStop(1, rgba(hex, 0));
  context.fillStyle = gradient;
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fill();
}

function breathing(now, speed, phase) {
  return 0.5 + 0.5 * Math.sin((now / 1000) * speed + phase);
}

/**
 * Draw one frame.
 *
 * @param context - a 2D context already scaled for the device pixel ratio.
 * @param view - the model view (mutated elsewhere; read-only here).
 * @param geometry - from {@link ringGeometry}.
 * @param now - milliseconds; the only clock the drawing uses.
 * @param options.centerAlpha - 0..1 for the centre text (the caller animates swaps).
 */
export function drawField(context, view, geometry, now, options = {}) {
  const { size, cx, cy, k } = geometry;
  const centerAlpha = Number.isFinite(options.centerAlpha) ? options.centerAlpha : 1;
  // The host's own surface decides the palette: the same drawing is illegible on
  // a bright window. Unknown names fall back to dark (§11).
  const theme = options.theme === 'light' ? 'light' : 'dark';
  const palette = paletteOf(theme);
  const accent = colorOf('running', theme);
  context.clearRect(0, 0, size, size);

  const materials = [...view.materials.values()].filter(node => node.alpha > 0.01);
  // The inner ring exists only for a multi-agent run; the root agent is the
  // centre, not a seat (§1).
  const agents = view.agents.size > 1
    ? [...view.agents.values()].filter(node => node.role !== 'root' && node.alpha > 0.01)
    : [];
  // §1.1: seats are fixed by material, never by how many nodes are visible.
  // An unseated material borrows the 其它 slot instead of inventing an angle.
  const materialAngles = new Map();
  const otherAngle = seatAngleFor('other');
  for (const node of materials) {
    const angle = seatAngleFor(node.id);
    materialAngles.set(node.id, angle === null ? otherAngle : angle);
  }
  const agentSeats = seatAngles(agents.length).map((angle, index) => [agents[index].id, angle]);

  // §5 halo: a whisper of presence behind the centre, so 「思考中」/「计划中」 is
  // not a word floating in a void. Peak alpha ≈0.06 — read as a vignette, never
  // as a shape; it is drawn first, so every node sits on top of it.
  const heart = Number.isFinite(view.heart) ? view.heart : 0;
  if (heart > 0.01) {
    const heat = materials.reduce((most, node) => Math.max(most, node.heat), 0);
    const base = Math.min(0.07, (0.04 * heart + 0.02 * heat) * (0.75 + 0.25 * breathing(now, 1.1, 0)));
    glow(context, cx, cy, 0.28 * size, palette.halo, base * palette.haloAlpha);
  }

  // Material <-> agent tether: only for pairs that were active together.
  if (agents.length > 0) {
    for (const [agentId, angle] of agentSeats) {
      const agent = view.agents.get(agentId);
      const from = seatPoint(geometry, angle, geometry.agent);
      for (const node of materials) {
        const nodeAngle = materialAngles.get(node.id);
        if (nodeAngle === undefined) continue;
        if (Math.abs(node.lastAt - agent.lastAt) > 2600) continue;
        const to = seatPoint(geometry, nodeAngle, geometry.material);
        context.beginPath();
        context.moveTo(from.x, from.y);
        context.lineTo(to.x, to.y);
        context.strokeStyle = rgba(accent, Math.min(agent.alpha, node.alpha) * 0.12 * palette.lineScale);
        context.lineWidth = 1;
        context.stroke();
      }
    }
  }

  // §3: arcs are drawn before the nodes, so each node's stroke hides the seam.
  // They live in an event window (`linkTtlMs`), never in the nodes' visibility.
  for (const link of view.links) {
    const age = now - link.at;
    if (age < 0 || age >= TIMING.linkTtlMs) continue;
    const from = materialAngles.get(link.a);
    const to = materialAngles.get(link.b);
    if (from === undefined || to === undefined) continue;
    let lo = Math.min(from, to);
    let hi = Math.max(from, to);
    if (hi - lo > Math.PI) {
      // the pair straddles 12 o'clock: take the short way round
      lo += Math.PI * 2;
      [lo, hi] = [hi, lo];
    }
    const trim = Math.asin(Math.min(1, (22 * k) / Math.max(1, geometry.material)));
    const rise = age < TIMING.linkRiseMs ? age / TIMING.linkRiseMs : 1;
    const fall = age < 620 ? 1 : Math.max(0, 1 - (age - 620) / Math.max(1, TIMING.linkTtlMs - 620));
    const alpha = 0.16 * Math.min(rise, fall) * palette.lineScale;
    if (alpha <= 0.004) continue;
    context.beginPath();
    context.arc(cx, cy, geometry.material, lo + trim, hi - trim);
    context.strokeStyle = rgba(accent, alpha);
    context.lineWidth = Math.max(1, k);
    context.stroke();
  }

  // Pulses: a dot travels from the centre (or an agent seat) to its material.
  for (const pulse of view.pulses) {
    const age = now - pulse.at;
    const life = TIMING.pulseFlightMs;
    if (age < 0 || age > life) continue;
    const progress = age / life;
    const eased = 1 - Math.pow(1 - progress, 2.2);
    const targetAngle = pulse.to === null ? undefined : materialAngles.get(pulse.to);
    if (targetAngle === undefined) {
      // a delegation: centre -> agent seat
      const seat = agentSeats.find(([id]) => id === pulse.agentId);
      if (seat === undefined) continue;
      const to = seatPoint(geometry, seat[1], geometry.agent);
      const x = cx + (to.x - cx) * eased;
      const y = cy + (to.y - cy) * eased;
      glow(context, x, y, 16 * k, accent, 0.5 * (1 - progress * 0.4) * palette.glowScale);
      context.beginPath();
      context.arc(x, y, 2.4 * k, 0, Math.PI * 2);
      context.fillStyle = rgba(accent, 0.95);
      context.fill();
      continue;
    }
    const to = seatPoint(geometry, targetAngle, geometry.material);
    const x = cx + (to.x - cx) * eased;
    const y = cy + (to.y - cy) * eased;
    glow(context, x, y, 16 * k, accent, 0.5 * (1 - progress * 0.4) * palette.glowScale);
    context.beginPath();
    context.arc(x, y, 2.4 * k, 0, Math.PI * 2);
    context.fillStyle = rgba(accent, 0.95);
    context.fill();
  }

  // Sub-agents: inner ring, labelled AGENT, colour follows their own state.
  for (const [agentId, angle] of agentSeats) {
    const node = view.agents.get(agentId);
    if (node === undefined) continue;
    const point = seatPoint(geometry, angle, geometry.agent);
    const tone = colorOf(node.state, theme);
    const working = node.state === 'running';
    const breath = working ? breathing(now, 1.9, node.phase) : 0;
    const strength = Math.min(1, (working ? 0.34 + breath * 0.26 : 0.14) + node.heat * 0.5);
    const radius = 30 * k;
    context.save();
    context.globalAlpha = node.alpha;
    glow(context, point.x, point.y, (radius + 22 * k) * 1.4, tone, 0.17 * strength);
    context.beginPath();
    context.arc(point.x, point.y, radius, 0, Math.PI * 2);
    context.strokeStyle = rgba(tone, 0.16 + strength * 0.5);
    context.lineWidth = 1.2 * k;
    // §2.1: `stalled` is the producer's word, drawn as a dashed halo.
    if (node.stalled === true) context.setLineDash([3 * k, 3 * k]);
    context.stroke();
    context.setLineDash([]);
    if (node.stalled === true) {
      context.beginPath();
      context.arc(point.x, point.y, radius + 5 * k, 0, Math.PI * 2);
      context.strokeStyle = rgba(tone, 0.28);
      context.lineWidth = k;
      context.setLineDash([2 * k, 4 * k]);
      context.stroke();
      context.setLineDash([]);
    }
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.font = `600 ${9 * k}px -apple-system,"Segoe UI",Arial,sans-serif`;
    context.fillStyle = rgba(tone, 0.45 + strength * 0.45);
    context.fillText('AGENT', point.x, point.y + 0.5 * k);
    drawNodeLabel(context, {
      angle,
      point,
      offset: 52 * k,
      label: node.label,
      sub: node.state === 'idle' ? '' : stateLabel(node.state, view.locale),
      tone,
      ink: palette.labelInk,
      k,
      labelSize: 13,
    });
    context.restore();
  }

  // Materials: outer ring, one fixed seat each.
  for (const node of materials) {
    const angle = materialAngles.get(node.id);
    if (angle === undefined) continue;
    const point = seatPoint(geometry, angle, geometry.material);
    const pinned = node.state === 'waiting-human' || node.state === 'failed';
    // 产品回调（2026-11-13）：完成态重新变绿——那一刻的绿色反馈是有价值的。
    // 它仍然停止呼吸，所以"在跑"和"做完了"除了颜色还有动效可以区分。
    const settled = node.state === 'done';
    const tone = colorOf(node.state, theme);
    const breath = node.state === 'running' && !pinned ? breathing(now, 1.6, node.phase) : 0;
    const base = node.state === 'idle' ? 0.12 : 0.3 + breath * 0.28;
    const strength = Math.min(1, base + node.heat * 0.5);
    const radius = 22 * k;
    context.save();
    context.globalAlpha = node.alpha;

    // §6.2: one settle ripple on `running -> done`, alongside the colour change.
    const rippleAge = now - node.doneAt;
    if (settled && node.doneAt > 0 && rippleAge >= 0 && rippleAge < TIMING.rippleMs) {
      const t = rippleAge / TIMING.rippleMs;
      context.beginPath();
      context.arc(point.x, point.y, radius * (1 + 0.5 * t), 0, Math.PI * 2);
      context.strokeStyle = rgba(tone, 0.5 * (1 - t));
      context.lineWidth = k;
      context.stroke();
    }

    glow(context, point.x, point.y, (radius + 20 * k) * 1.5, tone, 0.18 * strength);
    context.beginPath();
    context.arc(point.x, point.y, radius, 0, Math.PI * 2);
    context.strokeStyle = rgba(tone, 0.18 + strength * 0.55);
    context.lineWidth = (node.state === 'waiting-human' ? 1.8 : 1) * k;
    context.stroke();
    if (node.state === 'waiting-human') {
      context.beginPath();
      context.arc(point.x, point.y, radius + 6 * k, 0, Math.PI * 2);
      context.strokeStyle = rgba(colorOf('waiting-human', theme), 0.18);
      context.lineWidth = k;
      context.stroke();
    }
    context.beginPath();
    context.arc(point.x, point.y, 2 * k + strength * 1.2 * k, 0, Math.PI * 2);
    context.fillStyle = rgba(tone, 0.35 + strength * 0.6);
    context.fill();
    drawNodeLabel(context, {
      angle,
      point,
      offset: 42 * k,
      label: node.label || materialLabel(node.id, view.locale),
      // §4: the second line is a state word — the verb while it runs, the one
      // settled word afterwards (materials never fail; see the spec's §4.1 note).
      sub: node.state === 'idle'
        ? ''
        : (node.state === 'running'
          ? (node.verb || stateLabel('running', view.locale))
          : materialDoneLabel(view.locale)),
      tone,
      ink: palette.labelInk,
      k,
      labelSize: 14,
    });
    context.restore();
  }

  // Centre: the conclusion, always on (§4.3).
  const center = centerText(view);
  const alpha = centerAlpha * (view.state === 'idle' ? 0.38 : 1);
  if (alpha > 0.01) {
    context.save();
    context.globalAlpha = alpha;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    const terminal = view.state === 'done' || view.state === 'failed';
    if (terminal) {
      const tone = colorOf(view.state, theme);
      try {
        context.letterSpacing = `${3 * k}px`;
      } catch {
        // older engines ignore letterSpacing; the word still reads
      }
      context.font = `600 ${30 * k}px -apple-system,"Segoe UI",Arial,sans-serif`;
      context.fillStyle = rgba(tone, 0.96);
      context.fillText(center.main, cx, cy - 8 * k);
      try {
        context.letterSpacing = '0px';
      } catch {
        // same
      }
      context.font = `400 ${12 * k}px -apple-system,"Segoe UI","Microsoft YaHei",sans-serif`;
      context.fillStyle = view.state === 'failed' ? palette.failedSub : palette.doneSub;
      context.fillText(center.sub, cx, cy + 20 * k);
      context.beginPath();
      context.arc(cx, cy, 52 * k, 0, Math.PI * 2);
      context.strokeStyle = rgba(tone, 0.15);
      context.lineWidth = k;
      context.stroke();
    } else {
      // §5: one state word, one size, always the same baseline. The centre is a
      // reading, not a sentence — so it can change word without changing shape.
      context.font = `600 ${26 * k}px -apple-system,"Segoe UI","Microsoft YaHei",sans-serif`;
      context.fillStyle = view.state === 'waiting-human' ? rgba(colorOf('waiting-human', theme), 0.96) : palette.ink;
      context.fillText(center.main, cx, cy - 8 * k);
      if (center.sub !== '') {
        context.font = `400 ${12 * k}px -apple-system,"Segoe UI","Microsoft YaHei",sans-serif`;
        context.fillStyle = palette.subInk;
        context.fillText(center.sub, cx, cy + 20 * k);
      }
    }
    context.restore();
  }
}

function drawNodeLabel(context, options) {
  const { angle, point, offset, label, sub, tone, k, labelSize } = options;
  const ink = typeof options.ink === 'string' ? options.ink : 'rgba(232,242,255,.92)';
  const anchor = labelAnchor(angle);
  const x = point.x + Math.cos(angle) * offset;
  const y = point.y + Math.sin(angle) * offset;
  context.textAlign = anchor;
  context.font = `600 ${labelSize * k}px -apple-system,"Segoe UI","Microsoft YaHei",sans-serif`;
  context.fillStyle = ink;
  context.fillText(label, x, y - 5 * k);
  if (sub !== '') {
    context.font = `400 ${10.5 * k}px -apple-system,"Segoe UI","Microsoft YaHei",sans-serif`;
    context.fillStyle = rgba(tone, 0.8);
    context.fillText(sub, x, y + 9 * k);
  }
}

/**
 * The canvas component. It owns the animation frame loop and nothing else; the
 * caller supplies stable getters so a 60 fps field never re-renders React.
 *
 * @param React - the host's React module.
 */
export function createFieldCanvas(React) {
  return function FieldCanvas(props) {
    const { getView, getStage, getTheme } = props;
    const canvasRef = React.useRef(null);
    const alphaRef = React.useRef(1);
    const lastMainRef = React.useRef('');
    const rafRef = React.useRef(0);

    React.useEffect(() => {
      const canvas = canvasRef.current;
      if (canvas === null) return undefined;
      let disposed = false;
      const frame = () => {
        if (disposed) return;
        const stage = getStage();
        const view = getView();
        const now = globalThis.performance?.now?.() ?? Date.now();
        stepLifecycle(view, now);
        const size = Math.max(1, Math.round(Math.min(stage.w, stage.h) * (stage.full ? HUD_SCALE.windowed : HUD_SCALE.column)));
        const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
        if (canvas.width !== Math.round(size * dpr) || canvas.height !== Math.round(size * dpr)) {
          canvas.width = Math.round(size * dpr);
          canvas.height = Math.round(size * dpr);
          canvas.style.width = `${size}px`;
          canvas.style.height = `${size}px`;
        }
        const context = canvas.getContext('2d');
        if (context !== null) {
          context.setTransform(dpr, 0, 0, dpr, 0, 0);
          // Centre text swap: fade out on a new conclusion, then back in.
          const main = centerText(view).main;
          if (main !== lastMainRef.current) {
            lastMainRef.current = main;
            alphaRef.current = 0;
          }
          alphaRef.current = Math.min(1, alphaRef.current + 0.06);
          const theme = typeof getTheme === 'function' ? getTheme() : 'dark';
          drawField(context, view, ringGeometry(size), now, { centerAlpha: alphaRef.current, theme });
        }
        rafRef.current = globalThis.requestAnimationFrame(frame);
      };
      rafRef.current = globalThis.requestAnimationFrame(frame);
      return () => {
        disposed = true;
        globalThis.cancelAnimationFrame(rafRef.current);
      };
    }, [getView, getStage, getTheme]);

    return React.createElement('canvas', {
      ref: canvasRef,
      'aria-hidden': true,
      style: { display: 'block', width: '100%', height: '100%', pointerEvents: 'none' },
    });
  };
}
