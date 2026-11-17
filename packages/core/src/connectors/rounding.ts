import type { Vec2 } from '../geometry/math';
import { len, norm, sub } from './local-geometry';

// Rounded bends of elbow lines: arcs at the corners of a polyline.

/**
 * How far (world units) the flattened arc may stray from the true circle. Only hit testing
 * and bounds use the flattened points: renderers draw `arcs` exactly.
 */
const ARC_TOLERANCE = 0.05;

/**
 * A rounded bend: a circular arc, and which points of the polyline approximate it
 * (`from`..`to`, inclusive). Renderers draw the arc itself, so it stays smooth at any zoom.
 */
export interface ConnectorArc {
  cx: number;
  cy: number;
  r: number;
  /** Angle of the arc's start, radians (atan2 convention, y down). */
  start: number;
  /** Signed angle from start to end. */
  sweep: number;
  from: number;
  to: number;
}

/**
 * Replaces every bend of a polyline with a circular arc of radius `r` tangent to both
 * segments (Miro's rounded elbows). The radius shrinks where a segment is too short for it:
 * each arc takes at most half of either adjacent segment, so arcs never overlap.
 */
export function roundCorners(points: Vec2[], r: number): Vec2[] {
  return roundCornersWithArcs(points, r).points;
}

/** `roundCorners`, plus the exact arcs (for drawing) and where they sit in the polyline. */
export function roundCornersWithArcs(
  points: Vec2[],
  r: number,
): { points: Vec2[]; arcs: ConnectorArc[] } {
  if (points.length < 3 || r <= 0) return { points, arcs: [] };
  const arcs: ConnectorArc[] = [];
  const out: Vec2[] = [points[0]!];
  for (let i = 1; i + 1 < points.length; i++) {
    const prev = points[i - 1]!;
    const p = points[i]!;
    const next = points[i + 1]!;
    const l1 = len(sub(p, prev));
    const l2 = len(sub(next, p));
    const d1 = norm(sub(p, prev));
    const d2 = norm(sub(next, p));
    const cos = Math.max(-1, Math.min(1, d1.x * d2.x + d1.y * d2.y));
    const turn = Math.acos(cos);
    if (l1 < 1e-9 || l2 < 1e-9 || turn < 1e-3 || turn > Math.PI - 1e-3) {
      out.push(p);
      continue;
    }
    // Distance from the corner to where the arc touches each segment.
    const tanHalf = Math.tan(turn / 2);
    const t = Math.min(r * tanHalf, l1 / 2, l2 / 2);
    const radius = t / tanHalf;
    const a = { x: p.x - d1.x * t, y: p.y - d1.y * t };
    const b = { x: p.x + d2.x * t, y: p.y + d2.y * t };
    // Center: from `a`, perpendicular to the incoming segment, toward the turn.
    const n = norm({ x: d2.x - d1.x * cos, y: d2.y - d1.y * cos });
    const c = { x: a.x + n.x * radius, y: a.y + n.y * radius };
    const a0 = Math.atan2(a.y - c.y, a.x - c.x);
    let sweep = Math.atan2(b.y - c.y, b.x - c.x) - a0;
    if (sweep > Math.PI) sweep -= Math.PI * 2;
    if (sweep < -Math.PI) sweep += Math.PI * 2;
    // Chord sagitta ≈ radius · step² / 8: enough steps to stay within the tolerance.
    const maxStep = Math.sqrt((8 * ARC_TOLERANCE) / Math.max(radius, 1e-9));
    const steps = Math.min(64, Math.max(4, Math.ceil(Math.abs(sweep) / maxStep)));
    const from = out.length;
    for (let k = 0; k <= steps; k++) {
      const ang = a0 + (sweep * k) / steps;
      out.push({ x: c.x + Math.cos(ang) * radius, y: c.y + Math.sin(ang) * radius });
    }
    arcs.push({ cx: c.x, cy: c.y, r: radius, start: a0, sweep, from, to: out.length - 1 });
  }
  out.push(points[points.length - 1]!);
  return { points: out, arcs };
}
