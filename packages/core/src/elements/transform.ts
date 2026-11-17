import type { ConnectorElement, ConnectorEnd } from '../connectors/types';
import { isShape, type BoardElement, type ElementPatch, type ShapeElement } from './element';
import type { TextBlock } from '../text/text-block';
import type { Box, Vec2 } from '../geometry/math';

/**
 * Transforming the selection like in Figma/Miro: an oriented frame around it with resize
 * handles, rotation around its center. Pure functions: the UI feeds pointer positions in,
 * gets patches out (applied in one batch per pointer move).
 */

/** An oriented box: center, size, rotation (radians, around the center). */
export interface Frame {
  cx: number;
  cy: number;
  w: number;
  h: number;
  rotation: number;
}

export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

/** Which side each handle moves: -1 left/top, 1 right/bottom, 0 that axis stays. */
export const HANDLE_SIGNS: Readonly<Record<ResizeHandle, readonly [number, number]>> = {
  nw: [-1, -1],
  n: [0, -1],
  ne: [1, -1],
  e: [1, 0],
  se: [1, 1],
  s: [0, 1],
  sw: [-1, 1],
  w: [-1, 0],
};

export const CORNER_HANDLES: readonly ResizeHandle[] = ['nw', 'ne', 'se', 'sw'];
export const EDGE_HANDLES: readonly ResizeHandle[] = ['n', 'e', 's', 'w'];

/** The frame of one shape: its own box and rotation. */
export function shapeFrame(el: {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
}): Frame {
  return { cx: el.x + el.w / 2, cy: el.y + el.h / 2, w: el.w, h: el.h, rotation: el.rotation };
}

/** An axis-aligned frame, e.g. around a multi-selection. */
export function boxFrame(b: Box): Frame {
  return {
    cx: (b.minX + b.maxX) / 2,
    cy: (b.minY + b.maxY) / 2,
    w: b.maxX - b.minX,
    h: b.maxY - b.minY,
    rotation: 0,
  };
}

/** Frame-local point (centered, unrotated) → world. */
export function frameToWorld(f: Frame, p: Vec2): Vec2 {
  const c = Math.cos(f.rotation);
  const s = Math.sin(f.rotation);
  return { x: f.cx + p.x * c - p.y * s, y: f.cy + p.x * s + p.y * c };
}

/** World point → frame-local (centered, unrotated). */
export function worldToFrame(f: Frame, p: Vec2): Vec2 {
  const c = Math.cos(-f.rotation);
  const s = Math.sin(-f.rotation);
  const dx = p.x - f.cx;
  const dy = p.y - f.cy;
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

/** World position of a resize handle. */
export function handlePoint(f: Frame, handle: ResizeHandle): Vec2 {
  const [sx, sy] = HANDLE_SIGNS[handle];
  return frameToWorld(f, { x: (sx * f.w) / 2, y: (sy * f.h) / 2 });
}

export interface ResizeOptions {
  /** Keep the width/height ratio (Shift in Figma). */
  keepAspect?: boolean;
  /** Resize symmetrically around the center (Alt in Figma). */
  fromCenter?: boolean;
  /** Smallest width/height, world units. */
  minSize?: number;
}

/**
 * The frame after dragging `handle` by `delta` (frame-local units: the pointer movement
 * since the grab, rotated into the frame). The opposite handle stays put, or the center
 * with `fromCenter`. The size never goes below `minSize` (no flipping).
 */
export function resizeFrame(
  f: Frame,
  handle: ResizeHandle,
  delta: Vec2,
  options: ResizeOptions = {},
): Frame {
  const [sx, sy] = HANDLE_SIGNS[handle];
  const min = Math.max(options.minSize ?? 1, 1e-6);
  const hx = f.w / 2;
  const hy = f.h / 2;
  const px = sx * hx + delta.x; // where the dragged handle is now (frame-local)
  const py = sy * hy + delta.y;
  let w = f.w;
  let h = f.h;
  // Distance from the fixed side (or twice the distance from the center).
  if (sx !== 0) w = options.fromCenter ? 2 * sx * px : sx * px + hx;
  if (sy !== 0) h = options.fromCenter ? 2 * sy * py : sy * py + hy;
  w = Math.max(min, w);
  h = Math.max(min, h);
  if (options.keepAspect && f.w > 0 && f.h > 0) {
    if (sx !== 0 && sy !== 0) {
      // Corners follow whichever axis the pointer pulled further, like Figma.
      const k = Math.max(w / f.w, h / f.h);
      w = f.w * k;
      h = f.h * k;
    } else if (sx !== 0) {
      h = (w * f.h) / f.w;
    } else {
      w = (h * f.w) / f.h;
    }
    const grow = Math.max(1, min / w, min / h);
    w *= grow;
    h *= grow;
  }
  let cx = 0;
  let cy = 0;
  if (!options.fromCenter) {
    if (sx !== 0) cx = -sx * hx + (sx * w) / 2;
    if (sy !== 0) cy = -sy * hy + (sy * h) / 2;
  }
  const c = frameToWorld(f, { x: cx, y: cy });
  return { cx: c.x, cy: c.y, w, h, rotation: f.rotation };
}

const mapEnd = (end: ConnectorEnd, map: (p: Vec2) => Vec2): ConnectorEnd => {
  if (end.kind !== 'point') return end; // attached ends follow their shapes
  const p = map(end);
  return { kind: 'point', x: p.x, y: p.y };
};

/**
 * Patches that move `originals` (the elements as they were when the gesture started)
 * from frame `from` to frame `to`.
 *
 * One shape in its own frame gets exactly the new box. Several elements (an axis-aligned
 * group frame) are scaled around it: centers and free connector ends move proportionally,
 * and each shape's size scales along its own axes (exact for unrotated shapes).
 */
export function scaleElements(
  originals: readonly BoardElement[],
  from: Frame,
  to: Frame,
  options: ScaleOptions = {},
): Map<string, ElementPatch> {
  const out = scaleBoxes(originals, from, to);
  for (const el of originals) {
    if (!isShape(el) || el.type !== 'text' || !el.text) continue;
    const p = out.get(el.id)!;
    const text = textAfterScale(el, p.w ?? el.w, p.h ?? el.h, options.scaleText ?? false);
    if (text !== el.text) p.text = text;
  }
  return out;
}

export interface ScaleOptions {
  /**
   * Scale the font of `text` elements with their box (Miro's corner handles). Otherwise
   * their text rewraps: a width change turns auto-width text into auto-height, a height
   * change makes the box fixed (Figma).
   */
  scaleText?: boolean;
}

function textAfterScale(el: ShapeElement, w: number, h: number, scaleText: boolean): TextBlock {
  const block = el.text!;
  if (scaleText) {
    const k = el.w > 0 && el.h > 0 ? Math.sqrt((w / el.w) * (h / el.h)) : 1;
    return Math.abs(k - 1) < 1e-9 ? block : { ...block, fontSize: block.fontSize * k };
  }
  const sizing = block.sizing ?? 'fixed';
  const eps = 1e-6;
  if (sizing !== 'fixed' && Math.abs(h - el.h) > eps) return { ...block, sizing: 'fixed' };
  if (sizing === 'auto-width' && Math.abs(w - el.w) > eps)
    return { ...block, sizing: 'auto-height' };
  return block;
}

function scaleBoxes(
  originals: readonly BoardElement[],
  from: Frame,
  to: Frame,
): Map<string, ElementPatch> {
  const out = new Map<string, ElementPatch>();
  const only = originals.length === 1 ? originals[0]! : null;
  if (only && isShape(only) && only.rotation === from.rotation) {
    out.set(only.id, { x: to.cx - to.w / 2, y: to.cy - to.h / 2, w: to.w, h: to.h });
    return out;
  }
  const sx = from.w > 0 ? to.w / from.w : 1;
  const sy = from.h > 0 ? to.h / from.h : 1;
  // Group frames are axis-aligned; map world points through the frame anyway.
  const map = (p: Vec2): Vec2 => {
    const l = worldToFrame(from, p);
    return frameToWorld(to, { x: l.x * sx, y: l.y * sy });
  };
  for (const el of originals) {
    if (isShape(el)) {
      const c = map({ x: el.x + el.w / 2, y: el.y + el.h / 2 });
      const rel = el.rotation - from.rotation;
      const cos = Math.cos(rel);
      const sin = Math.sin(rel);
      const w = el.w * Math.hypot(sx * cos, sy * sin);
      const h = el.h * Math.hypot(sx * sin, sy * cos);
      out.set(el.id, { x: c.x - w / 2, y: c.y - h / 2, w, h });
    } else {
      out.set(el.id, connectorPatch(el, map));
    }
  }
  return out;
}

function connectorPatch(c: ConnectorElement, map: (p: Vec2) => Vec2): ElementPatch {
  return { start: mapEnd(c.start, map), end: mapEnd(c.end, map) };
}

/** Angle in (-π, π]. */
export function normalizeAngle(a: number): number {
  const t = Math.PI * 2;
  let r = ((a % t) + t) % t;
  if (r > Math.PI) r -= t;
  return r;
}

/** Rounds an angle to the nearest multiple of `step` (radians). */
export const snapAngle = (a: number, step: number): number => Math.round(a / step) * step;

/** Patches that rotate `originals` by `angle` around `center`. */
export function rotateElements(
  originals: readonly BoardElement[],
  center: Vec2,
  angle: number,
): Map<string, ElementPatch> {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const map = (p: Vec2): Vec2 => {
    const dx = p.x - center.x;
    const dy = p.y - center.y;
    return { x: center.x + dx * c - dy * s, y: center.y + dx * s + dy * c };
  };
  const out = new Map<string, ElementPatch>();
  for (const el of originals) {
    if (isShape(el)) {
      const m = map({ x: el.x + el.w / 2, y: el.y + el.h / 2 });
      out.set(el.id, {
        x: m.x - el.w / 2,
        y: m.y - el.h / 2,
        rotation: normalizeAngle(el.rotation + angle),
      });
    } else {
      out.set(el.id, connectorPatch(el, map));
    }
  }
  return out;
}

/** Patches that move `originals` by (dx, dy). */
export function translateElements(
  originals: readonly BoardElement[],
  dx: number,
  dy: number,
): Map<string, ElementPatch> {
  const out = new Map<string, ElementPatch>();
  const map = (p: Vec2): Vec2 => ({ x: p.x + dx, y: p.y + dy });
  for (const el of originals) {
    if (isShape(el)) out.set(el.id, { x: el.x + dx, y: el.y + dy });
    else out.set(el.id, connectorPatch(el, map));
  }
  return out;
}

/**
 * CSS resize cursor for a handle of a frame rotated by `rotation`: the handle's direction
 * snapped to the four cursor axes.
 */
export function resizeCursor(handle: ResizeHandle, rotation: number): string {
  const [sx, sy] = HANDLE_SIGNS[handle];
  const deg = (((((Math.atan2(sy, sx) + rotation) * 180) / Math.PI) % 180) + 180) % 180;
  const names = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'];
  return names[Math.round(deg / 45) % 4]!;
}
