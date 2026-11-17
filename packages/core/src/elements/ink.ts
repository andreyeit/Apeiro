import type { ShapeElement } from './element';
import type { Vec2 } from '../geometry/math';

/**
 * Freehand pen strokes (`ink` elements). The polyline is stored as fractions of the box,
 * so the usual move / resize / rotate of the box reshapes the stroke for free; these
 * helpers convert between that form and world points.
 */

/** Box of a stroke this thin in one direction still gets this size (world units). */
const MIN_EXTENT = 1e-3;

/** World points of an ink stroke (rotation included). */
export function inkWorldPoints(el: ShapeElement): Vec2[] {
  const pts = el.points ?? [];
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  const c = Math.cos(el.rotation);
  const s = Math.sin(el.rotation);
  const out: Vec2[] = [];
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const lx = (pts[i]! - 0.5) * el.w;
    const ly = (pts[i + 1]! - 0.5) * el.h;
    out.push({ x: cx + lx * c - ly * s, y: cy + lx * s + ly * c });
  }
  return out;
}

/** Box and normalized points of an unrotated stroke through world points `pts`. */
export function inkGeometry(
  pts: readonly Vec2[],
): Pick<ShapeElement, 'x' | 'y' | 'w' | 'h'> & { points: number[] } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (pts.length === 0) return { x: 0, y: 0, w: MIN_EXTENT, h: MIN_EXTENT, points: [] };
  const w = Math.max(maxX - minX, MIN_EXTENT);
  const h = Math.max(maxY - minY, MIN_EXTENT);
  // A straight horizontal (or vertical) stroke has no height: center it in the minimal box.
  const x = maxX - minX < MIN_EXTENT ? minX - w / 2 : minX;
  const y = maxY - minY < MIN_EXTENT ? minY - h / 2 : minY;
  const points: number[] = [];
  for (const p of pts) points.push((p.x - x) / w, (p.y - y) / h);
  return { x, y, w, h, points };
}

/**
 * Ramer–Douglas–Peucker: drops points closer than `tolerance` to the line through
 * their neighbours. Keeps the first and last point.
 */
export function simplifyStroke(pts: readonly Vec2[], tolerance: number): Vec2[] {
  if (pts.length <= 2) return [...pts];
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let worstDist = tolerance;
    for (let i = a + 1; i < b; i++) {
      const d = segmentDistance(pts[i]!, pts[a]!, pts[b]!);
      if (d > worstDist) {
        worstDist = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return pts.filter((_, i) => keep[i] === 1);
}

/** Distance from `p` to the segment a–b. */
export function segmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

/** Distance from a world point to the stroke's center line. */
export function inkDistance(el: ShapeElement, p: Vec2): number {
  const pts = inkWorldPoints(el);
  if (pts.length === 1) return Math.hypot(p.x - pts[0]!.x, p.y - pts[0]!.y);
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const d = segmentDistance(p, pts[i]!, pts[i + 1]!);
    if (d < best) best = d;
  }
  return best;
}

/** Most pieces a stroke segment is split into when smoothed. */
const MAX_SMOOTH_STEPS = 24;

/**
 * A smooth curve through the stroke's points (centripetal Catmull–Rom: no loops or
 * overshoot at sharp turns), as a polyline with pieces about `step` long. The points
 * themselves stay on the curve, so it looks like the hand drew it, without the kinks of
 * a straight line from point to point.
 */
export function smoothStroke(pts: readonly Vec2[], step: number): Vec2[] {
  if (pts.length < 3) return [...pts];
  const out: Vec2[] = [pts[0]!];
  const n = pts.length;
  for (let i = 0; i + 1 < n; i++) {
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    // Mirrored neighbours at the ends, so the curve starts and ends along the stroke.
    const p0 = pts[i - 1] ?? { x: 2 * p1.x - p2.x, y: 2 * p1.y - p2.y };
    const p3 = pts[i + 2] ?? { x: 2 * p2.x - p1.x, y: 2 * p2.y - p1.y };
    const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const k = Math.min(MAX_SMOOTH_STEPS, Math.max(1, Math.ceil(len / Math.max(step, 1e-6))));
    for (let j = 1; j <= k; j++) out.push(catmullRom(p0, p1, p2, p3, j / k));
  }
  return out;
}

/** Centripetal Catmull–Rom between p1 and p2 at t in 0..1 (Barry–Goldman). */
function catmullRom(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 {
  const knot = (a: Vec2, b: Vec2) => Math.max(Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)), 1e-6);
  const t0 = 0;
  const t1 = t0 + knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const u = t1 + (t2 - t1) * t;
  const lerp = (a: Vec2, b: Vec2, ta: number, tb: number): Vec2 => {
    const w = (u - ta) / (tb - ta);
    return { x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w };
  };
  const a1 = lerp(p0, p1, t0, t1);
  const a2 = lerp(p1, p2, t1, t2);
  const a3 = lerp(p2, p3, t2, t3);
  const b1 = lerp(a1, a2, t0, t2);
  const b2 = lerp(a2, a3, t1, t3);
  return lerp(b1, b2, t1, t2);
}

/**
 * Erases the part of a stroke (world points) inside the circle `center`, `radius`: the
 * stroke is cut exactly at the circle and falls apart into the pieces left outside it.
 * Returns those pieces (empty: nothing is left), or null if the circle doesn't touch it.
 */
export function eraseStroke(pts: readonly Vec2[], center: Vec2, radius: number): Vec2[][] | null {
  const inside = (p: Vec2) => Math.hypot(p.x - center.x, p.y - center.y) <= radius;
  if (pts.length === 1) return inside(pts[0]!) ? [] : null;
  // Fine enough that no stretch of the stroke can cross the circle unseen.
  const dense = densify(pts, radius / 2);
  if (!dense.some(inside)) return null;
  const pieces: Vec2[][] = [];
  let cur: Vec2[] = [];
  for (let i = 0; i < dense.length; i++) {
    const p = dense[i]!;
    const prev = dense[i - 1];
    if (!inside(p)) {
      // Leaving the circle: start the piece right on it.
      if (cur.length === 0 && prev && inside(prev))
        cur.push(circleCrossing(prev, p, center, radius));
      cur.push(p);
    } else if (cur.length > 0) {
      // Entering it: end the piece right on it.
      cur.push(circleCrossing(prev!, p, center, radius));
      pieces.push(cur);
      cur = [];
    }
  }
  if (cur.length > 0) pieces.push(cur);
  return pieces.filter((piece) => piece.length >= 2);
}

/** The stroke with extra points so no segment is longer than `step`. */
function densify(pts: readonly Vec2[], step: number): Vec2[] {
  const out: Vec2[] = [pts[0]!];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const k = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / Math.max(step, 1e-6)));
    for (let j = 1; j <= k; j++)
      out.push({ x: a.x + ((b.x - a.x) * j) / k, y: a.y + ((b.y - a.y) * j) / k });
  }
  return out;
}

/** Where the segment a–b (one end inside the circle, one outside) crosses the circle. */
function circleCrossing(a: Vec2, b: Vec2, c: Vec2, r: number): Vec2 {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const fx = a.x - c.x;
  const fy = a.y - c.y;
  const A = dx * dx + dy * dy;
  const B = 2 * (fx * dx + fy * dy);
  const C = fx * fx + fy * fy - r * r;
  const disc = Math.sqrt(Math.max(0, B * B - 4 * A * C));
  // The root within the segment.
  let t = (-B - disc) / (2 * A || 1);
  if (t < 0 || t > 1) t = (-B + disc) / (2 * A || 1);
  t = Math.min(1, Math.max(0, t));
  return { x: a.x + dx * t, y: a.y + dy * t };
}
