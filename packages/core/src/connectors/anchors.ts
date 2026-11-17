import type { ShapeElement } from '../elements/element';
import type { Vec2 } from '../geometry/math';
import { anchorLocal, projectToOutline, toLocal, toWorld } from './local-geometry';

// Anchors: fixed attachment points of connector ends, in 0..1 box coordinates of a shape.

/** Middles of the four sides, in 0..1 box coords: the magnets for connector ends. */
export const SIDE_MIDPOINTS: readonly Vec2[] = [
  { x: 0.5, y: 0 },
  { x: 1, y: 0.5 },
  { x: 0.5, y: 1 },
  { x: 0, y: 0.5 },
];

export const isSideMidpoint = (a: Vec2): boolean =>
  SIDE_MIDPOINTS.some((m) => m.x === a.x && m.y === a.y);

/** Along a side, the midpoint magnet reaches at least this share of the side's length. */
const MAGNET_ALONG_SHARE = 0.2;

/**
 * Anchor (0..1 box coords) for a world point on/near a shape:
 * - a side midpoint wins when the point is within `snap` world units across that side
 *   and within `snap` or 20% of the side's length along it (a strip, not a circle:
 *   aiming "roughly at the middle of the edge" is enough);
 * - otherwise a point within `edge` units of the outline is projected onto it;
 * - otherwise (deep inside) undefined, i.e. floating.
 */
export function anchorAt(s: ShapeElement, world: Vec2, snap: number, edge = 0): Vec2 | undefined {
  const local = toLocal(s, world);
  let best: Vec2 | undefined;
  let bestDist = Infinity;
  for (const a of SIDE_MIDPOINTS) {
    const lx = (a.x - 0.5) * s.w;
    const ly = (a.y - 0.5) * s.h;
    const horizontalSide = a.x === 0.5; // top or bottom
    const along = horizontalSide ? Math.abs(local.x - lx) : Math.abs(local.y - ly);
    const across = horizontalSide ? Math.abs(local.y - ly) : Math.abs(local.x - lx);
    const reach = Math.max(snap, (horizontalSide ? s.w : s.h) * MAGNET_ALONG_SHARE);
    if (across > snap || along > reach) continue;
    const d = Math.hypot(along, across);
    if (d < bestDist) {
      bestDist = d;
      best = a;
    }
  }
  if (best) return best;
  if (edge <= 0) return undefined;
  const proj = projectToOutline(s, local);
  if (Math.hypot(local.x - proj.x, local.y - proj.y) > edge) return undefined;
  return { x: proj.x / (s.w || 1) + 0.5, y: proj.y / (s.h || 1) + 0.5 };
}

/** Exact anchor (0..1 box coords) of a world point, no snapping. Values snap to 0/0.5/1 within float noise. */
export function anchorOf(s: ShapeElement, world: Vec2): Vec2 {
  const local = toLocal(s, world);
  const clean = (v: number) => {
    for (const k of [0, 0.5, 1]) if (Math.abs(v - k) < 1e-6) return k;
    return v;
  };
  return { x: clean(local.x / (s.w || 1) + 0.5), y: clean(local.y / (s.h || 1) + 0.5) };
}

/** World position of a fixed anchor, e.g. to draw snap handles. */
export function anchorPoint(s: ShapeElement, anchor: Vec2): Vec2 {
  return toWorld(s, anchorLocal(s, anchor));
}
