import type { Vec2 } from '../geometry/math';
import { len, norm, type ResolvedEnd, sub } from './local-geometry';
import type { ConnectorElement } from './types';

// Curved connectors: cubic Bézier segments through an optional bend point.

/** Control points of the automatic cubic curve between two ends. */
export function autoControls(a: ResolvedEnd, b: ResolvedEnd): [Vec2, Vec2] {
  const d = len(sub(b.p, a.p));
  const k = Math.min(Math.max(d * 0.4, 20), 240);
  const n0 = a.normal ?? norm(sub(b.p, a.p));
  const n1 = b.normal ?? norm(sub(a.p, b.p));
  return [
    { x: a.p.x + n0.x * k, y: a.p.y + n0.y * k },
    { x: b.p.x + n1.x * k, y: b.p.y + n1.y * k },
  ];
}

/** Midpoint (t = 0.5) of a cubic Bézier. */
export const bezierMid = (p0: Vec2, c0: Vec2, c1: Vec2, p1: Vec2): Vec2 => ({
  x: (p0.x + 3 * c0.x + 3 * c1.x + p1.x) / 8,
  y: (p0.y + 3 * c0.y + 3 * c1.y + p1.y) / 8,
});

/** Chord frame: unit direction start → end, its left normal and length. */
export function chord(a: ResolvedEnd, b: ResolvedEnd) {
  const d = sub(b.p, a.p);
  const length = Math.max(len(d), 1);
  const t = norm(d);
  return { t, n: { x: -t.y, y: t.x }, length };
}

/** Where a curve passes at its middle: the automatic curve's midpoint, moved by the bend. */
export function bendPoint(a: ResolvedEnd, b: ResolvedEnd, bend?: ConnectorElement['curve']): Vec2 {
  const [c0, c1] = autoControls(a, b);
  const mid = bezierMid(a.p, c0, c1, b.p);
  if (!bend) return mid;
  const { t, n, length } = chord(a, b);
  return {
    x: mid.x + (t.x * bend.along + n.x * bend.across) * length,
    y: mid.y + (t.y * bend.along + n.y * bend.across) * length,
  };
}

function cubic(p0: Vec2, c0: Vec2, c1: Vec2, p1: Vec2, out: Vec2[], skipFirst: boolean): void {
  const length = len(sub(c0, p0)) + len(sub(c1, c0)) + len(sub(p1, c1));
  // ~8 world units per segment: smooth up to a few hundred percent zoom.
  const segments = Math.min(96, Math.max(8, Math.ceil(length / 8)));
  for (let i = skipFirst ? 1 : 0; i <= segments; i++) {
    const t = i / segments;
    const u = 1 - t;
    const w0 = u * u * u;
    const w1 = 3 * u * u * t;
    const w2 = 3 * u * t * t;
    const w3 = t * t * t;
    out.push({
      x: w0 * p0.x + w1 * c0.x + w2 * c1.x + w3 * p1.x,
      y: w0 * p0.y + w1 * c0.y + w2 * c1.y + w3 * p1.y,
    });
  }
}

/**
 * Without a bend: one cubic leaving each end along its normal.
 * With a bend: two cubics joined smoothly at the bend point, with the tangent there
 * parallel to the chord, so even strong bends stay round instead of turning into a cusp.
 */
export function curvePoints(a: ResolvedEnd, b: ResolvedEnd, m?: Vec2): Vec2[] {
  const out: Vec2[] = [];
  if (!m) {
    const [c0, c1] = autoControls(a, b);
    cubic(a.p, c0, c1, b.p, out, false);
    return out;
  }
  const { t } = chord(a, b);
  const toM0 = norm(sub(m, a.p));
  const toM1 = norm(sub(m, b.p));
  // Leave each end between its side normal and the bend point: pure normals overshoot
  // (and loop) when the ends are close and the bend is large.
  const n0 = a.normal ? norm({ x: toM0.x + a.normal.x * 0.5, y: toM0.y + a.normal.y * 0.5 }) : toM0;
  const n1 = b.normal ? norm({ x: toM1.x + b.normal.x * 0.5, y: toM1.y + b.normal.y * 0.5 }) : toM1;
  const k0 = Math.min(Math.max(len(sub(m, a.p)) * 0.4, 8), 240);
  const k1 = Math.min(Math.max(len(sub(b.p, m)) * 0.4, 8), 240);
  cubic(
    a.p,
    { x: a.p.x + n0.x * k0, y: a.p.y + n0.y * k0 },
    { x: m.x - t.x * k0, y: m.y - t.y * k0 },
    m,
    out,
    false,
  );
  cubic(
    m,
    { x: m.x + t.x * k1, y: m.y + t.y * k1 },
    { x: b.p.x + n1.x * k1, y: b.p.y + n1.y * k1 },
    b.p,
    out,
    true,
  );
  return out;
}
