import type { Box } from './math';

/**
 * Snapping while moving and resizing, like Figma's smart guides: edges and centers of
 * the moving box stick to edges and centers of other elements within a threshold, and
 * the alignment is shown as guide lines. Where no element is near, the box snaps to the
 * board grid.
 */

/** Spacing of the board grid at zoom 1, world units. */
export const GRID_BASE = 24;
/** Finer grid levels are hidden below this on-screen spacing, px. */
export const GRID_MIN_PX = 12;

/** Spacing of the finest visible grid level at a zoom (4× coarser per level, like the drawn grid). */
export function gridStep(zoom: number): number {
  let spacing = GRID_BASE;
  if (!(zoom > 0) || !Number.isFinite(zoom)) return spacing;
  for (let i = 0; i < 64 && spacing * zoom < GRID_MIN_PX; i++) spacing *= 4;
  return spacing;
}

/**
 * A guide line: vertical (`axis: 'x'`, the line x = `at` from y = `from` to `to`) or
 * horizontal (`axis: 'y'`, y = `at` from x = `from` to `to`). `marks` are the aligned
 * points along it (drawn as small crosses).
 */
export interface SnapGuide {
  axis: 'x' | 'y';
  at: number;
  from: number;
  to: number;
  marks: number[];
}

/**
 * Equal spacing (Figma's distance guides): the gaps along `axis` that are all
 * `distance` wide. Each segment runs across a gap from `from` to `to` (along the axis)
 * at `at` on the other axis.
 */
export interface SpacingGuide {
  axis: 'x' | 'y';
  distance: number;
  segments: { from: number; to: number; at: number }[];
}

export interface SnapOptions {
  /** How close counts as aligned, world units (usually a few screen px / zoom). */
  threshold: number;
  /** Grid step to fall back to (world units); 0 or absent: no grid snapping. */
  grid?: number;
  /** Which edges of the box move: all (a move), or the dragged sides of a resize. */
  edges?: { x: readonly ('min' | 'center' | 'max')[]; y: readonly ('min' | 'center' | 'max')[] };
  /** Axes that must not change (Shift's axis lock, a resize along one side). */
  lockX?: boolean;
  lockY?: boolean;
}

export interface SnapResult {
  /** Correction to add to the box's position (or to the dragged edges). */
  dx: number;
  dy: number;
  guides: SnapGuide[];
  /** Equal gaps the box now forms with its neighbours (moves only). */
  spacing: SpacingGuide[];
}

const ALL_EDGES = ['min', 'center', 'max'] as const;
const EPS = 1e-6;
/** Gaps that differ by less than this count as equal (world units). */
const GAP_EPS = 0.01;

type Edge = 'min' | 'center' | 'max';
const lineOf = (b: Box, axis: 'x' | 'y', edge: Edge): number => {
  const min = axis === 'x' ? b.minX : b.minY;
  const max = axis === 'x' ? b.maxX : b.maxY;
  return edge === 'min' ? min : edge === 'max' ? max : (min + max) / 2;
};

const minOf = (b: Box, axis: 'x' | 'y') => (axis === 'x' ? b.minX : b.minY);
const maxOf = (b: Box, axis: 'x' | 'y') => (axis === 'x' ? b.maxX : b.maxY);
const other = (axis: 'x' | 'y'): 'x' | 'y' => (axis === 'x' ? 'y' : 'x');

/** Boxes in the same row (`axis` x) or column (y) as `box`: they overlap it across the axis. */
const rowOf = (box: Box, targets: readonly Box[], axis: 'x' | 'y'): Box[] => {
  const c = other(axis);
  return targets.filter((t) => minOf(t, c) < maxOf(box, c) && maxOf(t, c) > minOf(box, c));
};

/** Nearest box of `row` entirely before `box` along the axis (largest end), or null. */
const before = (box: Box, row: readonly Box[], axis: 'x' | 'y'): Box | null => {
  let out: Box | null = null;
  for (const t of row) {
    if (t === box || maxOf(t, axis) > minOf(box, axis) + EPS) continue;
    if (!out || maxOf(t, axis) > maxOf(out, axis)) out = t;
  }
  return out;
};
/** Nearest box of `row` entirely after `box` along the axis (smallest start), or null. */
const after = (box: Box, row: readonly Box[], axis: 'x' | 'y'): Box | null => {
  let out: Box | null = null;
  for (const t of row) {
    if (t === box || minOf(t, axis) < maxOf(box, axis) - EPS) continue;
    if (!out || minOf(t, axis) < minOf(out, axis)) out = t;
  }
  return out;
};

/**
 * Positions (the box's start along the axis) where it would make equal gaps, as in
 * Figma: centered between its two neighbours, or continuing the gap of the pair next to it.
 */
function spacingCandidates(moving: Box, targets: readonly Box[], axis: 'x' | 'y'): number[] {
  const row = rowOf(moving, targets, axis);
  if (row.length === 0) return [];
  const size = maxOf(moving, axis) - minOf(moving, axis);
  // Neighbours relative to the box's center, so they don't flip while it is snapped.
  const mid = (minOf(moving, axis) + maxOf(moving, axis)) / 2;
  const probe: Box =
    axis === 'x'
      ? { minX: mid, maxX: mid, minY: moving.minY, maxY: moving.maxY }
      : { minY: mid, maxY: mid, minX: moving.minX, maxX: moving.maxX };
  const left = before(probe, row, axis);
  const right = after(probe, row, axis);
  const out: number[] = [];
  if (left && right) {
    const room = minOf(right, axis) - maxOf(left, axis) - size;
    if (room > 0) out.push(maxOf(left, axis) + room / 2);
  }
  if (left) {
    const prev = before(left, row, axis);
    const gap = prev ? minOf(left, axis) - maxOf(prev, axis) : 0;
    if (gap > 0) out.push(maxOf(left, axis) + gap);
  }
  if (right) {
    const next = after(right, row, axis);
    const gap = next ? minOf(next, axis) - maxOf(right, axis) : 0;
    if (gap > 0) out.push(minOf(right, axis) - gap - size);
  }
  return out;
}

/** Segment across the gap between `a` and `b` (a before b), in the middle of their overlap. */
const segment = (a: Box, b: Box, axis: 'x' | 'y') => {
  const c = other(axis);
  const lo = Math.max(minOf(a, c), minOf(b, c));
  const hi = Math.min(maxOf(a, c), maxOf(b, c));
  return { from: maxOf(a, axis), to: minOf(b, axis), at: (lo + hi) / 2 };
};

/** Equal gaps around the (snapped) box: chains of neighbours spaced like its own gaps. */
function spacingGuides(box: Box, targets: readonly Box[], axis: 'x' | 'y'): SpacingGuide[] {
  const row = [...rowOf(box, targets, axis), box];
  const chain = (gap: number, dir: 'before' | 'after') => {
    const segs = [];
    let cur = box;
    for (let i = 0; i < 64; i++) {
      const nb = dir === 'before' ? before(cur, row, axis) : after(cur, row, axis);
      if (!nb) break;
      const g =
        dir === 'before' ? minOf(cur, axis) - maxOf(nb, axis) : minOf(nb, axis) - maxOf(cur, axis);
      if (Math.abs(g - gap) > GAP_EPS) break;
      segs.push(dir === 'before' ? segment(nb, cur, axis) : segment(cur, nb, axis));
      cur = nb;
    }
    return segs;
  };
  const left = before(box, row, axis);
  const right = after(box, row, axis);
  const gapL = left ? minOf(box, axis) - maxOf(left, axis) : -1;
  const gapR = right ? minOf(right, axis) - maxOf(box, axis) : -1;
  const out: SpacingGuide[] = [];
  if (gapL > 0 && gapR > 0 && Math.abs(gapL - gapR) <= GAP_EPS) {
    out.push({
      axis,
      distance: gapL,
      segments: [...chain(gapL, 'before'), ...chain(gapR, 'after')],
    });
    return out;
  }
  for (const [gap, dir] of [
    [gapL, 'before'],
    [gapR, 'after'],
  ] as const) {
    if (gap <= 0) continue;
    const segs = chain(gap, dir);
    if (segs.length >= 2) out.push({ axis, distance: gap, segments: segs });
  }
  return out;
}

/** Best correction along one axis: to an element line within the threshold, else the grid. */
function snapAxis(
  moving: Box,
  targets: readonly Box[],
  axis: 'x' | 'y',
  edges: readonly Edge[],
  threshold: number,
  grid: number,
  spacing: boolean,
): { delta: number; matched: boolean } {
  let best = Infinity;
  if (spacing) {
    const lo = lineOf(moving, axis, 'min');
    for (const pos of spacingCandidates(moving, targets, axis)) {
      const d = pos - lo;
      if (Math.abs(d) <= threshold && Math.abs(d) < Math.abs(best)) best = d;
    }
  }
  for (const edge of edges) {
    const m = lineOf(moving, axis, edge);
    for (const t of targets) {
      for (const te of ALL_EDGES) {
        const d = lineOf(t, axis, te) - m;
        if (Math.abs(d) <= threshold && Math.abs(d) < Math.abs(best)) best = d;
      }
    }
  }
  if (best !== Infinity) return { delta: best, matched: true };
  if (grid > 0) {
    // The first moving edge (the box's corner for a move, the dragged side for a resize).
    const m = lineOf(moving, axis, edges[0]!);
    return { delta: Math.round(m / grid) * grid - m, matched: false };
  }
  return { delta: 0, matched: false };
}

/** Guide lines for the element lines the (already snapped) box now lines up with. */
function guidesFor(
  box: Box,
  targets: readonly Box[],
  axis: 'x' | 'y',
  edges: readonly Edge[],
): SnapGuide[] {
  const cross = axis === 'x' ? 'y' : 'x';
  const byLine = new Map<number, SnapGuide>();
  for (const edge of edges) {
    const at = lineOf(box, axis, edge);
    for (const t of targets) {
      if (!ALL_EDGES.some((te) => Math.abs(lineOf(t, axis, te) - at) < EPS)) continue;
      const key = Math.round(at * 1e4) / 1e4;
      let g = byLine.get(key);
      if (!g) {
        const lo = lineOf(box, cross, 'min');
        const hi = lineOf(box, cross, 'max');
        g = { axis, at, from: lo, to: hi, marks: [lo, hi] };
        byLine.set(key, g);
      }
      const lo = lineOf(t, cross, 'min');
      const hi = lineOf(t, cross, 'max');
      g.from = Math.min(g.from, lo);
      g.to = Math.max(g.to, hi);
      g.marks.push(lo, hi);
    }
  }
  return [...byLine.values()];
}

/**
 * Snaps a box being moved or resized. `moving` is where the pointer would put it,
 * `targets` the boxes of the other elements nearby. Returns the correction and the guides
 * to draw.
 */
export function snapBox(moving: Box, targets: readonly Box[], options: SnapOptions): SnapResult {
  const grid = options.grid ?? 0;
  const ex = options.edges?.x ?? ALL_EDGES;
  const ey = options.edges?.y ?? ALL_EDGES;
  const x =
    options.lockX || ex.length === 0
      ? { delta: 0, matched: false }
      : snapAxis(moving, targets, 'x', ex, options.threshold, grid, !options.edges);
  const y =
    options.lockY || ey.length === 0
      ? { delta: 0, matched: false }
      : snapAxis(moving, targets, 'y', ey, options.threshold, grid, !options.edges);
  // Guides are computed on the box after both corrections, so their extents are final.
  const shift = (lo: number, hi: number, d: number, edges: readonly Edge[], edge: Edge) =>
    edges.includes(edge) ? (edge === 'min' ? lo + d : hi + d) : edge === 'min' ? lo : hi;
  const resize = !!options.edges;
  const snapped: Box = resize
    ? {
        minX: shift(moving.minX, moving.maxX, x.delta, ex, 'min'),
        maxX: shift(moving.minX, moving.maxX, x.delta, ex, 'max'),
        minY: shift(moving.minY, moving.maxY, y.delta, ey, 'min'),
        maxY: shift(moving.minY, moving.maxY, y.delta, ey, 'max'),
      }
    : {
        minX: moving.minX + x.delta,
        maxX: moving.maxX + x.delta,
        minY: moving.minY + y.delta,
        maxY: moving.maxY + y.delta,
      };
  const guides = [
    ...(x.matched ? guidesFor(snapped, targets, 'x', ex) : []),
    ...(y.matched ? guidesFor(snapped, targets, 'y', ey) : []),
  ];
  const spacing = resize
    ? []
    : [
        ...(x.matched ? spacingGuides(snapped, targets, 'x') : []),
        ...(y.matched ? spacingGuides(snapped, targets, 'y') : []),
      ];
  return { dx: x.delta, dy: y.delta, guides, spacing };
}
