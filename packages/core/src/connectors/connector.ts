import { elementBounds, type ShapeElement } from '../elements/element';
import type { Box, Vec2 } from '../geometry/math';
import { autoControls, bendPoint, bezierMid, chord, curvePoints } from './curve';
import { elbowLayout, elbowPoints, type ObstacleQuery, routeCrossesAny, simplify } from './elbow';
import { clearBorder, isFloating, resolveEnd, resolveEnds } from './ends';
import { anchorOf } from './anchors';
import { norm, projectToOutline, sub, toLocal, toWorld, type ResolvedEnd } from './local-geometry';
import { type ConnectorArc, roundCornersWithArcs } from './rounding';
import {
  capSize,
  type ConnectorElement,
  type ConnectorEnd,
  type ConnectorGeometry,
  type ConnectorHandle,
} from './types';

/**
 * Computes a connector's polyline from its ends. Returns null if an attached shape
 * is missing (e.g. deleted concurrently): such connectors are not drawn.
 */
export function resolveConnector(
  c: ConnectorElement,
  getShape: (id: string) => ShapeElement | undefined,
  /** Other shapes to route elbows around; without it only the connected shapes are avoided. */
  findObstacles?: ObstacleQuery,
): ConnectorGeometry | null {
  const ends = resolveEnds(c, getShape);
  if (!ends) return null;
  const [a, b] = ends;

  let points: Vec2[];
  let handle: ConnectorHandle | null;
  let routed = false;
  let path: Vec2[] | undefined;
  let arcs: ConnectorArc[] = [];
  if (c.route === 'elbow') {
    const box = (end: ConnectorEnd) => {
      const s = end.kind === 'element' ? getShape(end.id) : undefined;
      return s && elementBounds(s);
    };
    ({ points, handle, routed } = elbowPoints(
      a,
      b,
      c.elbowAt,
      box(c.start),
      box(c.end),
      findObstacles,
    ));
    if ((c.cornerRadius ?? 0) > 0) {
      path = points;
      ({ points, arcs } = roundCornersWithArcs(points, c.cornerRadius!));
    }
  } else if (c.route === 'curve') {
    if (c.curve) {
      // The bend point is defined against the unbent ends; then floating ends slide
      // along their outlines to face it, so the line bulges as one smooth arc.
      const m = bendPoint(a, b, c.curve);
      const slide = (end: ConnectorEnd, fallback: ResolvedEnd) => {
        const r = resolveEnd(end, m, 'curve', getShape);
        return r ? clearBorder(c, end, r, getShape) : fallback;
      };
      const a2 = isFloating(c.start) ? slide(c.start, a) : a;
      const b2 = isFloating(c.end) ? slide(c.end, b) : b;
      points = curvePoints(a2, b2, m);
      handle = { point: m, kind: 'curve' };
    } else {
      points = curvePoints(a, b);
      handle = { point: bendPoint(a, b), kind: 'curve' };
    }
  } else {
    points = simplify([a.p, b.p]);
    // Dragging the middle of a straight line turns it into a curve.
    handle = { point: { x: (a.p.x + b.p.x) / 2, y: (a.p.y + b.p.y) / 2 }, kind: 'curve' };
  }

  const first = points[0]!;
  const last = points[points.length - 1]!;
  const startDir = norm(sub(first, points[1]!));
  const endDir = norm(sub(last, points[points.length - 2]!));

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const pad = Math.max(
    c.strokeWidth / 2,
    c.startCap !== 'none' || c.endCap !== 'none' ? capSize(c.strokeWidth) : 0,
  );
  return {
    points,
    startDir,
    endDir,
    bounds: { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad },
    handle,
    routed,
    ...(path ? { path } : {}),
    ...(arcs.length > 0 ? { arcs } : {}),
  };
}

/** Whether a resolved connector's line runs through a box (e.g. a shape that just moved). */
export function connectorCrossesBox(g: ConnectorGeometry, box: Box): boolean {
  return routeCrossesAny(g.path ?? g.points, [box]);
}

/**
 * Patch that reshapes a connector so its bend handle is at `world`:
 * curves (and straight lines, which become curves) pass through the point,
 * elbows move their middle segment. Returns null if the route has no handle.
 */
export function bendConnector(
  c: ConnectorElement,
  world: Vec2,
  getShape: (id: string) => ShapeElement | undefined,
): Partial<Pick<ConnectorElement, 'route' | 'curve' | 'elbowAt'>> | null {
  const route = c.route === 'straight' ? 'curve' : c.route;
  const ends = resolveEnds({ ...c, route }, getShape);
  if (!ends) return null;
  const [a, b] = ends;
  if (route === 'curve') {
    const [c0, c1] = autoControls(a, b);
    const mid = bezierMid(a.p, c0, c1, b.p);
    const { t, n, length } = chord(a, b);
    const d = sub(world, mid);
    return {
      route,
      curve: { along: (d.x * t.x + d.y * t.y) / length, across: (d.x * n.x + d.y * n.y) / length },
    };
  }
  const { bend } = elbowLayout(a, b, c.elbowAt);
  if (!bend || Math.abs(bend.to - bend.from) < 1e-6) return null;
  const at = (world[bend.axis] - bend.from) / (bend.to - bend.from);
  return { elbowAt: Math.min(4, Math.max(-3, at)) };
}

/** Patch that removes a manual bend. */
export const resetBend = (): Pick<ConnectorElement, 'curve' | 'elbowAt'> => ({
  curve: undefined,
  elbowAt: undefined,
});

/** Patch that swaps start and end (caps stay, so arrows point the other way); the bend keeps its shape. */
export function reverseConnector(
  c: ConnectorElement,
): Pick<ConnectorElement, 'start' | 'end' | 'curve' | 'elbowAt'> {
  return {
    start: c.end,
    end: c.start,
    curve: c.curve && { along: -c.curve.along, across: -c.curve.across },
    elbowAt: c.elbowAt === undefined ? undefined : 1 - c.elbowAt,
  };
}

function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const l2 = abx * abx + aby * aby;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / l2)) : 0;
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
}

/** Distance from a point to the connector's line (not counting stroke width). */
export function distanceToConnector(g: ConnectorGeometry, p: Vec2): number {
  let best = Infinity;
  for (let i = 0; i + 1 < g.points.length; i++) {
    best = Math.min(best, distToSegment(p, g.points[i]!, g.points[i + 1]!));
  }
  return best;
}

export function hitTestConnector(
  c: ConnectorElement,
  g: ConnectorGeometry,
  p: Vec2,
  tolerance = 0,
): boolean {
  if (distanceToConnector(g, p) <= c.strokeWidth / 2 + tolerance) return true;
  // Caps are wider than the line: count clicks inside their box too.
  const size = capSize(c.strokeWidth);
  const inCap = (tip: Vec2, dir: Vec2) => {
    const dx = p.x - tip.x;
    const dy = p.y - tip.y;
    const back = -(dx * dir.x + dy * dir.y); // distance behind the tip
    const side = Math.abs(dx * dir.y - dy * dir.x);
    return back >= -tolerance && back <= size + tolerance && side <= size / 2 + tolerance;
  };
  if (c.startCap !== 'none' && inCap(g.points[0]!, g.startDir)) return true;
  return c.endCap !== 'none' && inCap(g.points[g.points.length - 1]!, g.endDir);
}

/** Ids of shapes a connector is attached to. */
export function attachedIds(c: ConnectorElement): string[] {
  const out: string[] = [];
  if (c.start.kind === 'element') out.push(c.start.id);
  if (c.end.kind === 'element' && !(c.start.kind === 'element' && c.start.id === c.end.id))
    out.push(c.end.id);
  return out;
}

/**
 * Turns floating ends into fixed anchors at the outline points they resolve to right now.
 * The line doesn't change, but from then on its ends stay put on the shapes instead of
 * sliding along the outline when shapes move or the line is bent.
 * Returns null if nothing is floating (or the connector can't be resolved).
 */
export function freezeConnectorEnds(
  c: ConnectorElement,
  getShape: (id: string) => ShapeElement | undefined,
): Pick<ConnectorElement, 'start' | 'end'> | null {
  if (!isFloating(c.start) && !isFloating(c.end)) return null;
  const g = resolveConnector(c, getShape);
  if (!g) return null;
  const freeze = (end: ConnectorEnd, at: Vec2): ConnectorEnd => {
    if (end.kind !== 'element' || end.anchor) return end;
    const s = getShape(end.id);
    if (!s) return end;
    // The end sits just outside the border: anchor at the outline point under it.
    const local = projectToOutline(s, toLocal(s, at));
    return { kind: 'element', id: end.id, anchor: anchorOf(s, toWorld(s, local)) };
  };
  return {
    start: freeze(c.start, g.points[0]!),
    end: freeze(c.end, g.points[g.points.length - 1]!),
  };
}
