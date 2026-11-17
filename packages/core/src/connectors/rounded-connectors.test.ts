import { describe, expect, it } from 'vitest';
import { connectorCrossesBox, resolveConnector, roundCorners, type ConnectorElement } from '.';
import type { ShapeElement } from '../elements/element';
import { validateElement } from '../elements/validation';
import { makeRect } from '../test-utils';

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

describe('roundCorners', () => {
  it('replaces a right-angle bend with a quarter circle tangent to both segments', () => {
    const pts = roundCorners(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ],
      20,
    );
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[pts.length - 1]).toEqual({ x: 100, y: 100 });
    const arc = pts.slice(1, -1);
    expect(arc[0]!.x).toBeCloseTo(80); // leaves the first segment 20 before the corner
    expect(arc[0]!.y).toBeCloseTo(0);
    expect(arc[arc.length - 1]!.x).toBeCloseTo(100);
    expect(arc[arc.length - 1]!.y).toBeCloseTo(20);
    for (const p of arc) expect(dist(p, { x: 80, y: 20 })).toBeCloseTo(20); // on the circle
  });

  it('shrinks the radius on short segments so neighbouring arcs never overlap', () => {
    const pts = roundCorners(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 10 }, // a 10-long step: each arc gets at most 5 of it
        { x: 200, y: 10 },
      ],
      50,
    );
    const xs = pts.map((p) => p.x);
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThanOrEqual(xs[i - 1]! - 1e-9);
    expect(pts.every((p) => p.y >= -1e-9 && p.y <= 10 + 1e-9)).toBe(true);
  });

  it('leaves straight runs and two-point lines alone', () => {
    const line = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
    ];
    expect(roundCorners(line, 10)).toBe(line);
    expect(
      roundCorners(
        [
          { x: 0, y: 0 },
          { x: 5, y: 0 },
          { x: 9, y: 0 },
        ],
        10,
      ),
    ).toHaveLength(3);
  });
});

describe('rounded elbow connectors', () => {
  const shapes = new Map<string, ShapeElement>([
    ['a', makeRect('a', { x: 0, y: 0 })],
    ['b', makeRect('b', { x: 300, y: 300 })],
  ]);
  const elbow = (cornerRadius?: number): ConnectorElement => ({
    id: 'c',
    type: 'connector',
    z: 1,
    start: { kind: 'element', id: 'a' },
    end: { kind: 'element', id: 'b' },
    route: 'elbow',
    stroke: 0,
    strokeWidth: 2,
    dash: 'solid',
    startCap: 'none',
    endCap: 'arrow',
    ...(cornerRadius !== undefined ? { cornerRadius } : {}),
  });

  it('rounds the bends, keeps the ends and the orthogonal path for obstacle checks', () => {
    const sharp = resolveConnector(elbow(), (id) => shapes.get(id))!;
    const round = resolveConnector(elbow(16), (id) => shapes.get(id))!;
    expect(sharp.path).toBeUndefined();
    expect(round.path).toEqual(sharp.points);
    expect(round.points.length).toBeGreaterThan(sharp.points.length);
    expect(round.points[0]).toEqual(sharp.points[0]);
    expect(round.points.at(-1)).toEqual(sharp.points.at(-1));
    expect(round.endDir).toEqual(sharp.endDir); // arrowheads point the same way
    // A box the orthogonal path runs through is still detected (arcs are not axis-aligned).
    const p = sharp.points;
    const mid = { x: (p[2]!.x + p[3]!.x) / 2, y: (p[2]!.y + p[3]!.y) / 2 };
    const box = { minX: mid.x - 5, minY: mid.y - 5, maxX: mid.x + 5, maxY: mid.y + 5 };
    expect(connectorCrossesBox(round, box)).toBe(connectorCrossesBox(sharp, box));
  });

  it('validates the corner radius and the border style', () => {
    expect(validateElement(elbow(-1))).toMatch(/cornerRadius/);
    expect(validateElement(makeRect('r', { strokeStyle: 'wavy' as never }))).toMatch(/strokeStyle/);
    expect(validateElement(makeRect('r', { strokeStyle: 'dotted' }))).toBeNull();
  });
});
