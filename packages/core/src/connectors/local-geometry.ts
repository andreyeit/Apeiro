import type { ShapeElement } from '../elements/element';
import { closestOutlinePoint, hasCustomOutline, outlineAlongRay } from '../elements/shape-geometry';
import type { Vec2 } from '../geometry/math';

// Shape-local geometry shared by the connector modules: points in a shape's centered,
// unrotated frame, and where rays and sides meet its outline.

export const ELBOW_STUB = 24;

export interface ResolvedEnd {
  p: Vec2;
  /** Outward direction at the attachment, or null for a free point. */
  normal: Vec2 | null;
}

export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const len = (v: Vec2) => Math.hypot(v.x, v.y);
export const norm = (v: Vec2): Vec2 => {
  const l = len(v);
  return l > 1e-9 ? { x: v.x / l, y: v.y / l } : { x: 1, y: 0 };
};

export function center(s: ShapeElement): Vec2 {
  return { x: s.x + s.w / 2, y: s.y + s.h / 2 };
}

export function toWorld(s: ShapeElement, local: Vec2): Vec2 {
  const c = Math.cos(s.rotation);
  const sn = Math.sin(s.rotation);
  const o = center(s);
  return { x: o.x + local.x * c - local.y * sn, y: o.y + local.x * sn + local.y * c };
}

export function toLocal(s: ShapeElement, world: Vec2): Vec2 {
  const c = Math.cos(-s.rotation);
  const sn = Math.sin(-s.rotation);
  const d = sub(world, center(s));
  return { x: d.x * c - d.y * sn, y: d.x * sn + d.y * c };
}

export function rotate(v: Vec2, angle: number): Vec2 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/** Outward normal of the closest box side to a local point, snapped to an axis. */
export function sideNormal(s: ShapeElement, local: Vec2): Vec2 {
  const nx = local.x / Math.max(s.w / 2, 1e-6);
  const ny = local.y / Math.max(s.h / 2, 1e-6);
  return Math.abs(nx) >= Math.abs(ny)
    ? { x: Math.sign(nx) || 1, y: 0 }
    : { x: 0, y: Math.sign(ny) || 1 };
}

/** Where a ray from the shape center in local direction `d` leaves its outline (local coords). */
export function outlinePoint(s: ShapeElement, d: Vec2): Vec2 {
  if (hasCustomOutline(s)) return outlineAlongRay(s, d);
  const hw = s.w / 2;
  const hh = s.h / 2;
  let t: number;
  if (s.type === 'ellipse') {
    t = 1 / Math.sqrt((d.x * d.x) / (hw * hw || 1e-9) + (d.y * d.y) / (hh * hh || 1e-9));
  } else {
    t = Math.min(
      Math.abs(d.x) > 1e-9 ? hw / Math.abs(d.x) : Infinity,
      Math.abs(d.y) > 1e-9 ? hh / Math.abs(d.y) : Infinity,
    );
  }
  return { x: d.x * t, y: d.y * t };
}

/** Snaps a direction to the closest axis. */
export function axis(v: Vec2): Vec2 {
  return Math.abs(v.x) >= Math.abs(v.y)
    ? { x: Math.sign(v.x) || 1, y: 0 }
    : { x: 0, y: Math.sign(v.y) || 1 };
}

/**
 * Local point of an anchor. On a rounded or polygonal outline a box point (e.g. the
 * middle of a triangle's left side, or a rounded-off corner) may lie outside the shape:
 * it is pulled along the ray from the center onto the outline.
 */
export function anchorLocal(s: ShapeElement, anchor: Vec2): Vec2 {
  const local = { x: (anchor.x - 0.5) * s.w, y: (anchor.y - 0.5) * s.h };
  if (!hasCustomOutline(s) || Math.hypot(local.x, local.y) < 1e-9) return local;
  return outlineAlongRay(s, local);
}

/** Closest point on the (local, unrotated) outline. Radial for ellipses. */
export function projectToOutline(s: ShapeElement, local: Vec2): Vec2 {
  if (hasCustomOutline(s)) return closestOutlinePoint(s, local);
  const hw = s.w / 2;
  const hh = s.h / 2;
  if (s.type === 'ellipse') return outlinePoint(s, norm(local));
  const cx = Math.max(-hw, Math.min(hw, local.x));
  const cy = Math.max(-hh, Math.min(hh, local.y));
  // Outside the box, clamping lands on the outline (an edge or a corner).
  if (cx !== local.x || cy !== local.y) return { x: cx, y: cy };
  // Inside: push to the nearest side.
  return hw - Math.abs(local.x) < hh - Math.abs(local.y)
    ? { x: Math.sign(local.x || 1) * hw, y: local.y }
    : { x: local.x, y: Math.sign(local.y || 1) * hh };
}
