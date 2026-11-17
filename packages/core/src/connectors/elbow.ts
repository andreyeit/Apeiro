import type { Box, Vec2 } from '../geometry/math';
import { axis, ELBOW_STUB, type ResolvedEnd, sub } from './local-geometry';
import { dirOf, routeOrthogonal } from './orthogonal-router';
import type { ConnectorHandle } from './types';

// Elbow (orthogonal) routes: the default layout between two ends, and detours around
// other shapes.

/** What the elbow's bend handle moves: one coordinate, as a fraction between `from` and `to`. */
interface ElbowBend {
  axis: 'x' | 'y';
  from: number;
  to: number;
}

interface ElbowLayout {
  points: Vec2[];
  handle: ConnectorHandle | null;
  bend: ElbowBend | null;
}

const transpose = (v: Vec2): Vec2 => ({ x: v.y, y: v.x });
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Orthogonal route. Every case keeps two invariants: the line leaves each shape
 * along its side normal, and it never runs back over itself.
 *
 * Written for a horizontal first end; a vertical first end is handled by
 * transposing x/y in and out.
 */
export function elbowLayout(a: ResolvedEnd, b: ResolvedEnd, at = 0.5): ElbowLayout {
  const n0 = axis(a.normal ?? sub(b.p, a.p));
  if (n0.x === 0) {
    const t = elbowLayout(
      { p: transpose(a.p), normal: a.normal && transpose(a.normal) },
      { p: transpose(b.p), normal: b.normal && transpose(b.normal) },
      at,
    );
    return {
      points: t.points.map(transpose),
      handle: t.handle && {
        ...t.handle,
        point: transpose(t.handle.point),
        axis: t.handle.axis === 'x' ? 'y' : 'x',
      },
      bend: t.bend && { ...t.bend, axis: t.bend.axis === 'x' ? 'y' : 'x' },
    };
  }
  const n1 = axis(b.normal ?? sub(a.p, b.p));
  const stub0 = a.normal ? ELBOW_STUB : 0;
  const stub1 = b.normal ? ELBOW_STUB : 0;
  const out = (end: ResolvedEnd, n: Vec2, len: number): Vec2 => ({
    x: end.p.x + n.x * len,
    y: end.p.y + n.y * len,
  });

  if (n1.x !== 0) {
    // Both ends horizontal.
    if (n0.x === -n1.x && n0.x * (b.p.x - a.p.x) > 0) {
      // Facing each other with a gap: a Z through the middle. Stubs shrink to fit the gap,
      // otherwise in a narrow gap they would cross and the line would run backwards.
      const gap = Math.abs(b.p.x - a.p.x) / 2;
      const p = out(a, n0, Math.min(stub0, gap));
      const q = out(b, n1, Math.min(stub1, gap));
      // Clamped: a middle segment outside the gap would run back over the stubs.
      const mx = lerp(p.x, q.x, Math.min(1, Math.max(0, at)));
      const handle: ConnectorHandle | null =
        Math.abs(q.y - p.y) >= 1
          ? { point: { x: mx, y: (p.y + q.y) / 2 }, kind: 'elbow', axis: 'x' }
          : null;
      return {
        points: [a.p, p, { x: mx, y: p.y }, { x: mx, y: q.y }, q, b.p],
        handle,
        bend: handle && { axis: 'x', from: p.x, to: q.x },
      };
    }
    const p = out(a, n0, stub0);
    const q = out(b, n1, stub1);
    if (n0.x === n1.x) {
      // Same direction (e.g. both from right sides): go out past both, then across.
      const x = n0.x > 0 ? Math.max(p.x, q.x) : Math.min(p.x, q.x);
      return { points: [a.p, p, { x, y: p.y }, { x, y: q.y }, q, b.p], handle: null, bend: null };
    }
    // Facing, but each is behind the other: step out, cross over between them, step in.
    // On the same level the crossing would run back over the stubs, so detour above.
    const from = p.y;
    const to = Math.abs(q.y - p.y) < 1 ? p.y - ELBOW_STUB * 4 : q.y;
    const my = lerp(from, to, at);
    return {
      points: [a.p, p, { x: p.x, y: my }, { x: q.x, y: my }, q, b.p],
      handle: { point: { x: (p.x + q.x) / 2, y: my }, kind: 'elbow', axis: 'y' },
      bend: { axis: 'y', from, to },
    };
  }

  // First end horizontal, second vertical: an L if its corner lies in front of both ends.
  const inFront = (corner: Vec2, from0: Vec2, from1: Vec2) =>
    (corner.x - from0.x) * n0.x >= 0 && (corner.y - from1.y) * n1.y >= 0;
  const p = out(a, n0, stub0);
  const q = out(b, n1, stub1);
  const corner = { x: q.x, y: p.y };
  if (inFront(corner, p, q)) return { points: [a.p, p, corner, q, b.p], handle: null, bend: null };
  const tight = { x: b.p.x, y: a.p.y }; // without stubs, for shapes that are close
  if (inFront(tight, a.p, b.p)) return { points: [a.p, tight, b.p], handle: null, bend: null };
  // Otherwise: out of the first, along to the second's stub level, across, into the second.
  return {
    points: [a.p, p, { x: p.x, y: q.y }, q, b.p],
    handle: null,
    bend: null,
  };
}

/** True if an axis-aligned segment runs through the inside of a box (edges don't count). */
function segmentCrossesBox(p: Vec2, q: Vec2, b: Box): boolean {
  const e = 0.5;
  if (Math.abs(p.y - q.y) < 1e-6) {
    return (
      p.y > b.minY + e &&
      p.y < b.maxY - e &&
      Math.max(p.x, q.x) > b.minX + e &&
      Math.min(p.x, q.x) < b.maxX - e
    );
  }
  return (
    p.x > b.minX + e &&
    p.x < b.maxX - e &&
    Math.max(p.y, q.y) > b.minY + e &&
    Math.min(p.y, q.y) < b.maxY - e
  );
}

/**
 * Whether a route cuts through the shapes it connects. The first/last segments are
 * skipped: they leave/enter the shape by construction (and for points on rounded
 * outlines they necessarily clip the box corner).
 */
function routeCrossesEnds(points: Vec2[], startBox?: Box, endBox?: Box): boolean {
  for (let i = 0; i + 1 < points.length; i++) {
    const p = points[i]!;
    const q = points[i + 1]!;
    if (startBox && i > 0 && segmentCrossesBox(p, q, startBox)) return true;
    if (endBox && i < points.length - 2 && segmentCrossesBox(p, q, endBox)) return true;
  }
  return false;
}

const inflate = (b: Box, m: number): Box => ({
  minX: b.minX - m,
  minY: b.minY - m,
  maxX: b.maxX + m,
  maxY: b.maxY + m,
});

/** Moves from `p` along axis direction `n` until outside `box` (and at least `min` away). */
function exitPoint(p: Vec2, n: Vec2, min: number, box?: Box): Vec2 {
  let t = min;
  if (box) {
    if (n.x > 0) t = Math.max(t, box.maxX - p.x);
    else if (n.x < 0) t = Math.max(t, p.x - box.minX);
    else if (n.y > 0) t = Math.max(t, box.maxY - p.y);
    else t = Math.max(t, p.y - box.minY);
  }
  return { x: p.x + n.x * t, y: p.y + n.y * t };
}

/**
 * Finds shapes (other than the connected ones) whose boxes intersect `area`:
 * the obstacles an elbow route should go around. Provided by the scene's spatial index.
 */
export type ObstacleQuery = (area: Box) => Box[];

/** Clearance around other shapes; smaller than the stub so lines fit between close shapes. */
const OBSTACLE_MARGIN = 12;
/** Re-route at most this many times when a detour runs into shapes it didn't know about. */
const MAX_ROUTE_PASSES = 3;
/** Obstacles per search: keeps one route in the low milliseconds on any board. */
const MAX_OBSTACLES = 48;

export function routeCrossesAny(points: Vec2[], boxes: Box[]): boolean {
  // Every segment counts here (a straight line is a single segment); only the connected
  // shapes get the exemption for the segments leaving/entering them.
  for (let i = 0; i + 1 < points.length; i++) {
    for (const b of boxes) if (segmentCrossesBox(points[i]!, points[i + 1]!, b)) return true;
  }
  return false;
}

function pointsBounds(points: Vec2[], pad: number): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

const boxKey = (b: Box) => `${b.minX},${b.minY},${b.maxX},${b.maxY}`;

/** Distance between a box and an axis-aligned segment (0 if they touch). */
function boxSegmentDistance(b: Box, p: Vec2, q: Vec2): number {
  const dx = Math.max(b.minX - Math.max(p.x, q.x), Math.min(p.x, q.x) - b.maxX, 0);
  const dy = Math.max(b.minY - Math.max(p.y, q.y), Math.min(p.y, q.y) - b.maxY, 0);
  return Math.hypot(dx, dy);
}

/** Up to `limit` boxes closest to any of the polylines (all of them if there are few). */
function closestBoxes(boxes: Box[], paths: Vec2[][], limit: number): Box[] {
  if (boxes.length <= limit) return boxes;
  const scored = boxes.map((box) => {
    let d = Infinity;
    for (const path of paths)
      for (let i = 0; i + 1 < path.length; i++)
        d = Math.min(d, boxSegmentDistance(box, path[i]!, path[i + 1]!));
    return { box, d };
  });
  scored.sort((x, y) => x.d - y.d);
  return scored.slice(0, limit).map((s) => s.box);
}

/** Orthogonal path around the connected shapes and `others`, or null if there is none. */
function routeAround(
  a: ResolvedEnd,
  b: ResolvedEnd,
  startBox: Box | undefined,
  endBox: Box | undefined,
  others: Box[],
): Vec2[] | null {
  const n0 = axis(a.normal ?? sub(b.p, a.p));
  const n1 = axis(b.normal ?? sub(a.p, b.p));
  const m = ELBOW_STUB;
  const s0 = startBox && inflate(startBox, m);
  const s1 = endBox && inflate(endBox, m);
  const from = exitPoint(a.p, n0, a.normal ? m : 0, s0);
  const to = exitPoint(b.p, n1, b.normal ? m : 0, s1);
  const ends = [startBox, endBox].filter((o): o is Box => !!o);
  const path = routeOrthogonal({
    from,
    fromDir: dirOf(n0),
    to,
    toDir: dirOf({ x: -n1.x, y: -n1.y }),
    obstacles: [
      ...ends.map((box) => ({ box, margin: m })),
      ...others.map((box) => ({ box, margin: OBSTACLE_MARGIN })),
    ],
    centered: [s0, s1].filter((o): o is Box => !!o),
    bendCost: m * 2,
    margin: m,
  });
  return path && simplify([a.p, ...path, b.p]);
}

export function elbowPoints(
  a: ResolvedEnd,
  b: ResolvedEnd,
  at = 0.5,
  startBox?: Box,
  endBox?: Box,
  findObstacles?: ObstacleQuery,
): { points: Vec2[]; handle: ConnectorHandle | null; routed: boolean } {
  const layout = elbowLayout(a, b, at);
  const simple = simplify(layout.points);
  const known = new Map<string, Box>();
  const discover = (points: Vec2[]): Box[] => {
    if (!findObstacles) return [];
    const fresh: Box[] = [];
    for (const box of findObstacles(pointsBounds(points, OBSTACLE_MARGIN))) {
      const key = boxKey(box);
      if (!known.has(key)) {
        known.set(key, box);
        fresh.push(box);
      }
    }
    return fresh;
  };
  const nearby = discover(simple);
  if (!routeCrossesEnds(simple, startBox, endBox) && !routeCrossesAny(simple, nearby)) {
    return { points: simple, handle: layout.handle, routed: false };
  }
  // The template route cuts through a shape: search a path around everything in the way.
  // A detour can reach shapes outside the first search area, so look again along it.
  // The search grid grows with the square of the obstacle count, so on a dense board only
  // the shapes closest to the paths tried so far take part (those it crosses come first).
  let best: Vec2[] | null = null;
  const tried = [simple];
  for (let pass = 0; pass < MAX_ROUTE_PASSES; pass++) {
    const obstacles = closestBoxes([...known.values()], tried, MAX_OBSTACLES);
    const routed = routeAround(a, b, startBox, endBox, obstacles);
    if (!routed) break;
    best = routed;
    tried.push(routed);
    const more = discover(routed);
    if (!routeCrossesAny(routed, more)) break;
  }
  return best
    ? { points: best, handle: null, routed: true }
    : { points: simple, handle: layout.handle, routed: false };
}

/** Drops duplicate and collinear points (keeps the ends). */
export function simplify(points: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const pt of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - pt.x) < 1e-6 && Math.abs(last.y - pt.y) < 1e-6) continue;
    if (out.length >= 2) {
      const prev = out[out.length - 2]!;
      const cross = (last!.x - prev.x) * (pt.y - prev.y) - (last!.y - prev.y) * (pt.x - prev.x);
      const dot = (last!.x - prev.x) * (pt.x - last!.x) + (last!.y - prev.y) * (pt.y - last!.y);
      if (Math.abs(cross) < 1e-6 && dot >= 0) out[out.length - 1] = pt;
      else out.push(pt);
    } else out.push(pt);
  }
  if (out.length === 1) out.push({ ...out[0]! });
  return out;
}
