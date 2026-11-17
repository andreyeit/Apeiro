import type { ShapeElement } from './element';
import type { Vec2 } from '../geometry/math';

/**
 * Outline geometry of shapes in their local frame: centered at the box center, unrotated,
 * y down. Shared by hit testing, connector attachment and overlays. The fragment shader
 * (`shaders.ts`) implements the same formulas, so what you click is what is drawn.
 *
 * Corner rounding works like in Figma: every corner of a rect or polygon is replaced by
 * a circular arc of the given radius, tangent to both edges. The radius is capped where
 * the arcs meet, so a square at the maximum radius is a circle, a regular polygon its
 * incircle.
 */

export const MIN_POLYGON_SIDES = 3;
export const MAX_POLYGON_SIDES = 12;
/** Keeps the eroded polygon from degenerating to a point at the maximum radius. */
const RADIUS_CAP = 0.999;

/** Shapes whose corners can be rounded by the user. */
export const hasCornerRadius = (el: ShapeElement): boolean =>
  el.type === 'rect' || el.type === 'polygon' || el.type === 'image';

export const polygonSides = (el: Pick<ShapeElement, 'sides'>): number =>
  Math.min(MAX_POLYGON_SIDES, Math.max(MIN_POLYGON_SIDES, Math.round(el.sides ?? 3)));

/**
 * Vertices of a regular polygon with `sides` corners, the first one at the top, clockwise
 * on screen, stretched so that the polygon's bounding box is exactly the w × h box
 * (a triangle has its apex at the top middle and its base on the bottom edge).
 */
export function polygonVertices(w: number, h: number, sides: number): Vec2[] {
  const unit: Vec2[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < sides; i++) {
    const a = (2 * Math.PI * i) / sides;
    const p = { x: Math.sin(a), y: -Math.cos(a) };
    unit.push(p);
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const sx = w / (maxX - minX);
  const sy = h / (maxY - minY);
  const mx = (minX + maxX) / 2;
  const my = (minY + maxY) / 2;
  return unit.map((p) => ({ x: (p.x - mx) * sx, y: (p.y - my) * sy }));
}

/** Outward unit normal of edge i (v[i] → v[i+1]) for clockwise-on-screen vertices. */
function edgeNormals(v: Vec2[]): Vec2[] {
  return v.map((p, i) => {
    const q = v[(i + 1) % v.length]!;
    const ex = q.x - p.x;
    const ey = q.y - p.y;
    const l = Math.hypot(ex, ey) || 1;
    return { x: ey / l, y: -ex / l };
  });
}

/** For each vertex: how much a rounding of radius 1 eats into each adjacent edge (cot of half the angle). */
function cornerCuts(normals: Vec2[]): number[] {
  const n = normals.length;
  return normals.map((cur, i) => {
    const prev = normals[(i + n - 1) % n]!;
    const cross = Math.abs(prev.x * cur.y - prev.y * cur.x);
    return cross / (1 + prev.x * cur.x + prev.y * cur.y);
  });
}

/** Largest corner radius before the arcs of two corners meet on some edge. */
function polygonMaxRadius(v: Vec2[], cuts: number[]): number {
  let max = Infinity;
  for (let i = 0; i < v.length; i++) {
    const j = (i + 1) % v.length;
    const len = Math.hypot(v[j]!.x - v[i]!.x, v[j]!.y - v[i]!.y);
    const k = cuts[i]! + cuts[j]!;
    if (k > 0) max = Math.min(max, len / k);
  }
  return Number.isFinite(max) ? max * RADIUS_CAP : 0;
}

/** Largest useful corner radius of a shape (a square at this radius is a circle). */
export function maxCornerRadius(el: ShapeElement): number {
  if (el.type === 'ellipse' || el.type === 'audio') return 0;
  if (el.type === 'polygon') {
    const v = polygonVertices(el.w, el.h, polygonSides(el));
    return polygonMaxRadius(v, cornerCuts(edgeNormals(v)));
  }
  return Math.min(el.w, el.h) / 2;
}

/** Radius actually drawn: the requested one, capped by the shape's size. */
export function effectiveRadius(el: ShapeElement): number {
  if (el.type === 'ellipse' || el.type === 'audio') return 0;
  return Math.max(0, Math.min(el.radius, maxCornerRadius(el)));
}

/** Exact signed distance to a polygon (negative inside); after Inigo Quilez. */
function sdPolygon(p: Vec2, v: Vec2[]): number {
  let d = (p.x - v[0]!.x) ** 2 + (p.y - v[0]!.y) ** 2;
  let s = 1;
  for (let i = 0, j = v.length - 1; i < v.length; j = i, i++) {
    const vi = v[i]!;
    const vj = v[j]!;
    const ex = vj.x - vi.x;
    const ey = vj.y - vi.y;
    const wx = p.x - vi.x;
    const wy = p.y - vi.y;
    const ee = ex * ex + ey * ey;
    const t = ee > 0 ? Math.max(0, Math.min(1, (wx * ex + wy * ey) / ee)) : 0;
    const bx = wx - ex * t;
    const by = wy - ey * t;
    d = Math.min(d, bx * bx + by * by);
    const c1 = p.y >= vi.y;
    const c2 = p.y < vj.y;
    const c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * Math.sqrt(d);
}

/** Polygon with every corner rounded by `r`: the polygon shrunk by r, then grown back by r. */
export function roundedPolygonSdf(p: Vec2, v: Vec2[], r: number): number {
  if (r <= 0) return sdPolygon(p, v);
  const normals = edgeNormals(v);
  const n = v.length;
  const eroded = v.map((q, i) => {
    const a = normals[(i + n - 1) % n]!;
    const b = normals[i]!;
    const k = r / (1 + a.x * b.x + a.y * b.y);
    return { x: q.x - (a.x + b.x) * k, y: q.y - (a.y + b.y) * k };
  });
  return sdPolygon(p, eroded) - r;
}

/** Signed distance from a local point to the shape's outline (negative inside, stroke ignored). */
export function shapeSdf(el: ShapeElement, p: Vec2): number {
  const hw = el.w / 2;
  const hh = el.h / 2;
  if (el.type === 'ellipse') {
    // Same approximation as the shader: exact on the axes, good near the outline.
    const k1 = Math.hypot(p.x / (hw * hw || 1e-9), p.y / (hh * hh || 1e-9));
    if (k1 < 1e-9) return -Math.min(hw, hh);
    const k0 = Math.hypot(p.x / (hw || 1e-9), p.y / (hh || 1e-9));
    return (k0 * (k0 - 1)) / k1;
  }
  const r = effectiveRadius(el);
  if (el.type === 'polygon') {
    return roundedPolygonSdf(p, polygonVertices(el.w, el.h, polygonSides(el)), r);
  }
  const qx = Math.abs(p.x) - (hw - r);
  const qy = Math.abs(p.y) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** True when the outline isn't the plain box (or ellipse): attachment points must follow it. */
export const hasCustomOutline = (el: ShapeElement): boolean =>
  el.type === 'polygon' || (el.type !== 'ellipse' && effectiveRadius(el) > 0);

/** Outward unit normal of the outline near a local point (gradient of the distance). */
export function outlineNormal(el: ShapeElement, p: Vec2): Vec2 {
  const e = Math.max(el.w, el.h, 1) * 1e-4;
  const gx = shapeSdf(el, { x: p.x + e, y: p.y }) - shapeSdf(el, { x: p.x - e, y: p.y });
  const gy = shapeSdf(el, { x: p.x, y: p.y + e }) - shapeSdf(el, { x: p.x, y: p.y - e });
  const l = Math.hypot(gx, gy);
  return l > 1e-12 ? { x: gx / l, y: gy / l } : { x: 1, y: 0 };
}

/** Where a ray from the center along local direction `d` leaves the outline. */
export function outlineAlongRay(el: ShapeElement, d: Vec2): Vec2 {
  const l = Math.hypot(d.x, d.y) || 1;
  const ux = d.x / l;
  const uy = d.y / l;
  let lo = 0;
  let hi = Math.hypot(el.w, el.h) / 2 + 1;
  if (shapeSdf(el, { x: 0, y: 0 }) >= 0) return { x: ux * hi, y: uy * hi }; // degenerate shape
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (shapeSdf(el, { x: ux * mid, y: uy * mid }) < 0) lo = mid;
    else hi = mid;
  }
  const t = (lo + hi) / 2;
  return { x: ux * t, y: uy * t };
}

/** Closest outline point to a local point. */
export function closestOutlinePoint(el: ShapeElement, p: Vec2): Vec2 {
  let q = p;
  for (let i = 0; i < 6; i++) {
    const d = shapeSdf(el, q);
    if (Math.abs(d) < 1e-9) break;
    const n = outlineNormal(el, q);
    q = { x: q.x - n.x * d, y: q.y - n.y * d };
  }
  return q;
}

/**
 * The corner whose rounding the on-canvas handle controls (top-left for boxes, the top
 * vertex for polygons), in local coordinates: the vertex, the unit bisector pointing into
 * the shape, and sin of half the corner angle (the arc center is r / sin away from the vertex).
 */
export function radiusCorner(el: ShapeElement): { vertex: Vec2; inward: Vec2; sinHalf: number } {
  if (el.type === 'polygon') {
    const v = polygonVertices(el.w, el.h, polygonSides(el));
    const normals = edgeNormals(v);
    const a = normals[normals.length - 1]!;
    const b = normals[0]!;
    const bx = -(a.x + b.x);
    const by = -(a.y + b.y);
    const l = Math.hypot(bx, by) || 1;
    const dot = a.x * b.x + a.y * b.y;
    return { vertex: v[0]!, inward: { x: bx / l, y: by / l }, sinHalf: Math.sqrt((1 + dot) / 2) };
  }
  return {
    vertex: { x: -el.w / 2, y: -el.h / 2 },
    inward: { x: Math.SQRT1_2, y: Math.SQRT1_2 },
    sinHalf: Math.SQRT1_2,
  };
}

/**
 * Local position of the radius handle: the center of the corner arc, but never closer to
 * the vertex than `minOffset` (so it can be grabbed at radius 0, like in Figma).
 */
export function radiusHandleLocal(el: ShapeElement, minOffset: number): Vec2 {
  const c = radiusCorner(el);
  const dist = Math.max(effectiveRadius(el) / c.sinHalf, minOffset);
  return { x: c.vertex.x + c.inward.x * dist, y: c.vertex.y + c.inward.y * dist };
}

/** Radius for a handle dragged by `along` local units toward the inside from where it was grabbed. */
export function radiusAfterDrag(el: ShapeElement, startRadius: number, along: number): number {
  const c = radiusCorner(el);
  return Math.max(0, Math.min(maxCornerRadius(el), startRadius + along * c.sinHalf));
}

/** Text box inside a polygon, as fractions of the shape's box. */
export function polygonTextBox(sides: number): { x0: number; y0: number; x1: number; y1: number } {
  if (sides === 3) return { x0: 0.25, y0: 0.45, x1: 0.75, y1: 0.92 };
  if (sides === 4) return { x0: 0.25, y0: 0.25, x1: 0.75, y1: 0.75 };
  const k = (1 - Math.SQRT1_2) / 2;
  return { x0: k, y0: k, x1: 1 - k, y1: 1 - k };
}
