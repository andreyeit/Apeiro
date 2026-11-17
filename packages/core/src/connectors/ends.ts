import type { ShapeElement } from '../elements/element';
import {
  closestOutlinePoint,
  hasCustomOutline,
  outlineAlongRay,
  outlineNormal,
} from '../elements/shape-geometry';
import type { Vec2 } from '../geometry/math';
import {
  anchorLocal,
  axis,
  center,
  norm,
  outlinePoint,
  rotate,
  sideNormal,
  toLocal,
  toWorld,
  type ResolvedEnd,
} from './local-geometry';
import type { ConnectorElement, ConnectorEnd, ConnectorRoute } from './types';

// Where a connector's ends are: on a shape's outline (floating or at an anchor), at a
// free point, moved clear of the shape's border.

function referencePoint(
  end: ConnectorEnd,
  getShape: (id: string) => ShapeElement | undefined,
): Vec2 | null {
  if (end.kind === 'point') return { x: end.x, y: end.y };
  const s = getShape(end.id);
  if (!s) return null;
  return end.anchor
    ? toWorld(s, { x: (end.anchor.x - 0.5) * s.w, y: (end.anchor.y - 0.5) * s.h })
    : center(s);
}

export function resolveEnd(
  end: ConnectorEnd,
  toward: Vec2,
  route: ConnectorRoute,
  getShape: (id: string) => ShapeElement | undefined,
): ResolvedEnd | null {
  if (end.kind === 'point') return { p: { x: end.x, y: end.y }, normal: null };
  const s = getShape(end.id);
  if (!s) return null;
  const custom = hasCustomOutline(s);
  if (end.anchor) {
    const local = anchorLocal(s, end.anchor);
    const n =
      route === 'elbow'
        ? sideNormal(s, local)
        : s.type === 'ellipse'
          ? norm({ x: local.x / (s.w * s.w || 1), y: local.y / (s.h * s.h || 1) })
          : custom
            ? outlineNormal(s, local)
            : sideNormal(s, local);
    return { p: toWorld(s, local), normal: rotate(n, s.rotation) };
  }
  const dir = toLocal(s, toward);
  if (route === 'elbow') {
    // Orthogonal routes leave from the middle of the side facing the other end
    // (for polygons: where the outline crosses the line to that side's middle).
    const n = sideNormal(s, dir);
    const mid = { x: (n.x * s.w) / 2, y: (n.y * s.h) / 2 };
    const local = s.type === 'polygon' ? outlineAlongRay(s, mid) : mid;
    return { p: toWorld(s, local), normal: rotate(n, s.rotation) };
  }
  const local = outlinePoint(s, norm(dir));
  const n =
    s.type === 'ellipse'
      ? norm({ x: local.x / (s.w * s.w || 1), y: local.y / (s.h * s.h || 1) })
      : custom
        ? outlineNormal(s, local)
        : norm(local);
  return { p: toWorld(s, local), normal: rotate(n, s.rotation) };
}

/** Point on a shape's (unrotated) outline at the given side, moved along that side to `along`. */
function sidePointAt(s: ShapeElement, normal: Vec2, along: number): Vec2 {
  const cx = s.x + s.w / 2;
  const cy = s.y + s.h / 2;
  const hw = s.w / 2;
  const hh = s.h / 2;
  let p: Vec2;
  if (normal.x !== 0) {
    const t = (along - cy) / hh;
    const x = s.type === 'ellipse' ? hw * Math.sqrt(Math.max(0, 1 - t * t)) : hw;
    p = { x: cx + normal.x * x, y: along };
  } else {
    const t = (along - cx) / hw;
    const y = s.type === 'ellipse' ? hh * Math.sqrt(Math.max(0, 1 - t * t)) : hh;
    p = { x: along, y: cy + normal.y * y };
  }
  if (s.type === 'ellipse' || !hasCustomOutline(s)) return p;
  // Rounded corners: the box side point may be off the outline near the corner.
  const q = closestOutlinePoint(s, { x: p.x - cx, y: p.y - cy });
  return { x: cx + q.x, y: cy + q.y };
}

/**
 * Elbow lines between two floating ends on facing sides: if the sides overlap,
 * attach both at the middle of the overlap so the line is straight instead of
 * making a tiny Z-step (what Miro does). Only for unrotated shapes.
 */
function alignFacingEnds(
  c: ConnectorElement,
  a: ResolvedEnd,
  b: ResolvedEnd,
  getShape: (id: string) => ShapeElement | undefined,
): void {
  if (c.start.kind !== 'element' || c.end.kind !== 'element' || c.start.anchor || c.end.anchor)
    return;
  const s0 = getShape(c.start.id);
  const s1 = getShape(c.end.id);
  if (!s0 || !s1 || s0.rotation !== 0 || s1.rotation !== 0 || !a.normal || !b.normal) return;
  if (s0.type === 'polygon' || s1.type === 'polygon') return; // sides aren't the box sides
  const n0 = axis(a.normal);
  const n1 = axis(b.normal);
  if (n0.x + n1.x !== 0 || n0.y + n1.y !== 0) return; // not facing each other
  const horizontal = n0.x !== 0;
  const lo = horizontal ? Math.max(s0.y, s1.y) : Math.max(s0.x, s1.x);
  const hi = horizontal ? Math.min(s0.y + s0.h, s1.y + s1.h) : Math.min(s0.x + s0.w, s1.x + s1.w);
  if (hi - lo < 1) return;
  const mid = (lo + hi) / 2;
  a.p = sidePointAt(s0, n0, mid);
  b.p = sidePointAt(s1, n1, mid);
}

export const isFloating = (end: ConnectorEnd): boolean => end.kind === 'element' && !end.anchor;

export function resolveEnds(
  c: ConnectorElement,
  getShape: (id: string) => ShapeElement | undefined,
): [ResolvedEnd, ResolvedEnd] | null {
  const r0 = referencePoint(c.start, getShape);
  const r1 = referencePoint(c.end, getShape);
  if (!r0 || !r1) return null;
  const a = resolveEnd(c.start, r1, c.route, getShape);
  const b = resolveEnd(c.end, r0, c.route, getShape);
  if (!a || !b) return null;
  if (c.route === 'elbow') alignFacingEnds(c, a, b, getShape);
  return [clearBorder(c, c.start, a, getShape), clearBorder(c, c.end, b, getShape)];
}

/**
 * Moves an attached end out of the shape, as in Miro: the line (and its arrow tip) stops
 * against the outer edge of the shape's border instead of running into it. The outline
 * point is the middle of the border, so the end moves out by half the border plus half
 * the line's own width (its rounded end reaches that far past the point).
 */
export function clearBorder(
  c: ConnectorElement,
  end: ConnectorEnd,
  r: ResolvedEnd,
  getShape: (id: string) => ShapeElement | undefined,
): ResolvedEnd {
  if (end.kind !== 'element') return r;
  const s = getShape(end.id);
  if (!s) return r;
  const d = s.strokeWidth / 2 + c.strokeWidth / 2;
  if (!(d > 0)) return r;
  // Straight out of the border at that point (a side of a box, the normal of a curve).
  const local = toLocal(s, r.p);
  const n =
    s.type === 'ellipse'
      ? norm({ x: local.x / (s.w * s.w || 1), y: local.y / (s.h * s.h || 1) })
      : hasCustomOutline(s)
        ? outlineNormal(s, local)
        : sideNormal(s, local);
  const out = rotate(n, s.rotation);
  return { p: { x: r.p.x + out.x * d, y: r.p.y + out.y * d }, normal: r.normal };
}
