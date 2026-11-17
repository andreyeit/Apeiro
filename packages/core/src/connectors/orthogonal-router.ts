import type { Box, Vec2 } from '../geometry/math';

/**
 * Orthogonal routing around obstacles on a sparse grid.
 *
 * Grid lines ("rulers") are the edges of the obstacles (already inflated by a margin),
 * the two stub points, the middles of gaps between the connected shapes and an outer
 * frame. A Dijkstra search over (node, heading) states finds the cheapest path with a
 * penalty per turn, never reversing and never entering an obstacle.
 *
 * Blocked nodes and edges are precomputed per obstacle from ruler index ranges, and the
 * search uses a binary heap, so dozens of obstacles stay in the low milliseconds.
 */

type Dir = 0 | 1 | 2 | 3; // +x, +y, -x, -y
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

export const dirOf = (v: Vec2): Dir =>
  Math.abs(v.x) >= Math.abs(v.y) ? (v.x >= 0 ? 0 : 2) : v.y >= 0 ? 1 : 3;

const opposite = (d: Dir): Dir => ((d + 2) % 4) as Dir;

export interface RouteRequest {
  /** Stub ends: the path starts at `from` heading `fromDir` and must end at `to`. */
  from: Vec2;
  fromDir: Dir;
  to: Vec2;
  /** Direction the path must be heading when it reaches `to` (toward the shape). */
  toDir: Dir;
  /**
   * Obstacles: the path may run along their (inflated) edges but not inside. If an end
   * lies in an obstacle's clearance, the clearance is dropped for it (the path may pass
   * close); if an end lies inside the obstacle itself, the obstacle is ignored.
   */
  obstacles: Array<{ box: Box; margin: number }>;
  /** Boxes whose mutual gaps get a centre line (the connected shapes), for tidy routes. */
  centered?: Box[];
  /** Cost of one turn, in world units of length. */
  bendCost: number;
  /** Margin for the outer frame that lets the path go around everything. */
  margin: number;
}

const EPS = 1e-6;
/** Largest search grid (rulers x × rulers y); ~100 obstacles with random coordinates. */
export const MAX_GRID_NODES = 250 * 250;
const strictlyInside = (b: Box, x: number, y: number) =>
  x > b.minX + EPS && x < b.maxX - EPS && y > b.minY + EPS && y < b.maxY - EPS;

function uniqueSorted(values: number[]): number[] {
  const sorted = values.slice().sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) if (out.length === 0 || v - out[out.length - 1]! > EPS) out.push(v);
  return out;
}

/** First index with arr[i] > v + EPS. */
function upperBound(arr: number[], v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! > v + EPS) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** First index with arr[i] >= v - EPS. */
function lowerBound(arr: number[], v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! >= v - EPS) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Minimal binary heap of (cost, state). */
class Heap {
  private costs: number[] = [];
  private items: number[] = [];
  get size() {
    return this.items.length;
  }
  push(cost: number, item: number) {
    const c = this.costs;
    const it = this.items;
    let i = it.length;
    c.push(cost);
    it.push(item);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (c[p]! <= cost) break;
      c[i] = c[p]!;
      it[i] = it[p]!;
      i = p;
    }
    c[i] = cost;
    it[i] = item;
  }
  pop(): [number, number] {
    const c = this.costs;
    const it = this.items;
    const topCost = c[0]!;
    const top = it[0]!;
    const lastCost = c.pop()!;
    const last = it.pop()!;
    const n = it.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        if (l >= n) break;
        const r = l + 1;
        const m = r < n && c[r]! < c[l]! ? r : l;
        if (c[m]! >= lastCost) break;
        c[i] = c[m]!;
        it[i] = it[m]!;
        i = m;
      }
      c[i] = lastCost;
      it[i] = last;
    }
    return [topCost, top];
  }
}

/** Returns the corner points of the path from `from` to `to` (both included), or null. */
export function routeOrthogonal(r: RouteRequest): Vec2[] | null {
  const { from, to, margin } = r;
  const containsEnd = (b: Box) =>
    strictlyInside(b, from.x, from.y) || strictlyInside(b, to.x, to.y);
  const obstacles: Box[] = [];
  for (const { box, margin: clearance } of r.obstacles) {
    const inflated = {
      minX: box.minX - clearance,
      minY: box.minY - clearance,
      maxX: box.maxX + clearance,
      maxY: box.maxY + clearance,
    };
    if (!containsEnd(inflated)) obstacles.push(inflated);
    else if (!containsEnd(box)) obstacles.push(box);
  }

  const xs: number[] = [from.x, to.x];
  const ys: number[] = [from.y, to.y];
  let minX = Math.min(from.x, to.x);
  let maxX = Math.max(from.x, to.x);
  let minY = Math.min(from.y, to.y);
  let maxY = Math.max(from.y, to.y);
  for (const o of obstacles) {
    xs.push(o.minX, o.maxX);
    ys.push(o.minY, o.maxY);
    minX = Math.min(minX, o.minX);
    maxX = Math.max(maxX, o.maxX);
    minY = Math.min(minY, o.minY);
    maxY = Math.max(maxY, o.maxY);
  }
  const centered = r.centered ?? [];
  for (const a of centered) {
    for (const b of centered) {
      if (a.maxX < b.minX) xs.push((a.maxX + b.minX) / 2);
      if (a.maxY < b.minY) ys.push((a.maxY + b.minY) / 2);
    }
  }
  xs.push(minX - margin, maxX + margin);
  ys.push(minY - margin, maxY + margin);

  const gx = uniqueSorted(xs);
  const gy = uniqueSorted(ys);
  const W = gx.length;
  const H = gy.length;
  // Memory and time grow with W × H: refuse instead of freezing (callers fall back).
  if (W * H > MAX_GRID_NODES) return null;

  // Precompute blocked nodes and edges from each obstacle's ruler index ranges.
  const nodeBlocked = new Uint8Array(W * H);
  const hBlocked = new Uint8Array(W * H); // edge (i, j) → (i + 1, j)
  const vBlocked = new Uint8Array(W * H); // edge (i, j) → (i, j + 1)
  for (const o of obstacles) {
    // Rulers strictly inside the obstacle on each axis.
    const ix0 = upperBound(gx, o.minX);
    const ix1 = lowerBound(gx, o.maxX) - 1;
    const iy0 = upperBound(gy, o.minY);
    const iy1 = lowerBound(gy, o.maxY) - 1;
    // Rulers on or inside the edges (edge intervals between them are inside the box).
    const ex0 = lowerBound(gx, o.minX);
    const ex1 = upperBound(gx, o.maxX) - 1;
    const ey0 = lowerBound(gy, o.minY);
    const ey1 = upperBound(gy, o.maxY) - 1;
    for (let j = iy0; j <= iy1; j++) {
      for (let i = ix0; i <= ix1; i++) nodeBlocked[j * W + i] = 1;
      for (let i = ex0; i < ex1; i++) hBlocked[j * W + i] = 1;
    }
    for (let i = ix0; i <= ix1; i++) {
      for (let j = ey0; j < ey1; j++) vBlocked[j * W + i] = 1;
    }
  }
  const passable = (i: number, j: number, d: Dir): boolean => {
    const i2 = i + DX[d]!;
    const j2 = j + DY[d]!;
    if (i2 < 0 || i2 >= W || j2 < 0 || j2 >= H || nodeBlocked[j2 * W + i2]) return false;
    if (d === 0) return !hBlocked[j * W + i];
    if (d === 2) return !hBlocked[j * W + i2];
    if (d === 1) return !vBlocked[j * W + i];
    return !vBlocked[j2 * W + i];
  };

  const si = lowerBound(gx, from.x);
  const sj = lowerBound(gy, from.y);
  const ti = lowerBound(gx, to.x);
  const tj = lowerBound(gy, to.y);

  const N = W * H * 4;
  const dist = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const heap = new Heap();
  const start = (sj * W + si) * 4 + r.fromDir;
  dist[start] = 0;
  heap.push(0, start);

  let goal = -1;
  let goalCost = Infinity;
  while (heap.size > 0) {
    const [cost, s] = heap.pop();
    if (cost > dist[s]! || cost >= goalCost) continue;
    const d = (s % 4) as Dir;
    const node = (s - d) / 4;
    const i = node % W;
    const j = (node - i) / W;
    if (i === ti && j === tj && d !== opposite(r.toDir)) {
      // Arriving heading the wrong way costs a final turn (reversing is not allowed at all).
      const total = cost + (d === r.toDir ? 0 : r.bendCost);
      if (total < goalCost) {
        goalCost = total;
        goal = s;
      }
    }
    for (let nd = 0 as Dir; nd < 4; nd = (nd + 1) as Dir) {
      if (nd === opposite(d) || !passable(i, j, nd)) continue;
      const i2 = i + DX[nd]!;
      const j2 = j + DY[nd]!;
      const next =
        cost +
        Math.abs(gx[i2]! - gx[i]!) +
        Math.abs(gy[j2]! - gy[j]!) +
        (nd === d ? 0 : r.bendCost);
      const s2 = (j2 * W + i2) * 4 + nd;
      if (next < dist[s2]!) {
        dist[s2] = next;
        prev[s2] = s;
        heap.push(next, s2);
      }
    }
  }
  if (goal < 0) return null;

  const path: Vec2[] = [];
  for (let s = goal; s >= 0; s = prev[s]!) {
    const node = (s - (s % 4)) / 4;
    const i = node % W;
    path.push({ x: gx[i]!, y: gy[(node - i) / W]! });
  }
  return path.reverse();
}
