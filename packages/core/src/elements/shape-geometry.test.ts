import { describe, expect, it } from 'vitest';
import { anchorPoint, resolveConnector, type ConnectorElement } from '../connectors';
import { textArea, type ShapeElement } from './element';
import { validateElement } from './validation';
import { hitTestElement } from './hit-test';
import {
  closestOutlinePoint,
  effectiveRadius,
  maxCornerRadius,
  outlineAlongRay,
  polygonVertices,
  radiusAfterDrag,
  radiusHandleLocal,
  shapeSdf,
} from './shape-geometry';
import { makeRect } from '../test-utils';

const triangle = (patch: Partial<ShapeElement> = {}): ShapeElement =>
  makeRect('t', { type: 'polygon', sides: 3, w: 200, h: 200, ...patch });

/** World → local (centered, unrotated) for an unrotated shape at its default position. */
const local = (s: ShapeElement, p: { x: number; y: number }) => ({
  x: p.x - (s.x + s.w / 2),
  y: p.y - (s.y + s.h / 2),
});

describe('polygon geometry', () => {
  it('stretches the polygon to fill its box: apex top middle, base on the bottom edge', () => {
    const v = polygonVertices(200, 100, 3);
    expect(v[0]!.x).toBeCloseTo(0);
    expect(v[0]!.y).toBeCloseTo(-50);
    expect(v[1]).toEqual({ x: expect.closeTo(100), y: expect.closeTo(50) });
    expect(v[2]).toEqual({ x: expect.closeTo(-100), y: expect.closeTo(50) });
    const hexagon = polygonVertices(120, 80, 6);
    expect(Math.max(...hexagon.map((p) => p.x))).toBeCloseTo(60);
    expect(Math.min(...hexagon.map((p) => p.y))).toBeCloseTo(-40);
  });

  it('hit tests the triangle, not its box', () => {
    const t = triangle();
    expect(hitTestElement(t, { x: 100, y: 120 })).toBe(true);
    expect(hitTestElement(t, { x: 5, y: 5 })).toBe(false); // box corner, outside the triangle
    expect(hitTestElement(t, { x: 100, y: 1 })).toBe(true); // just below the apex
  });

  it('caps the radius where the corner arcs meet (the incircle for a triangle)', () => {
    const t = triangle();
    // Isosceles triangle 200×200: legs √(100² + 200²), base 200, area 20000.
    const leg = Math.hypot(100, 200);
    const inradius = 20000 / ((200 + 2 * leg) / 2);
    expect(maxCornerRadius(t)).toBeCloseTo(inradius * 0.999, 3);
    expect(effectiveRadius(triangle({ radius: 1e6 }))).toBeCloseTo(maxCornerRadius(t));
  });

  it('rounding pulls the apex inward and keeps the middle of the edges', () => {
    const sharp = triangle();
    const round = triangle({ radius: 30 });
    const apex = { x: 0, y: -99 };
    expect(shapeSdf(sharp, apex)).toBeLessThan(0);
    expect(shapeSdf(round, apex)).toBeGreaterThan(0);
    const baseMid = { x: 0, y: 100 };
    expect(shapeSdf(round, baseMid)).toBeCloseTo(0, 6);
  });

  it('keeps text inside the triangle', () => {
    const t = triangle();
    const a = textArea(t);
    for (const [x, y] of [
      [a.minX, a.minY],
      [a.maxX, a.minY],
      [a.minX, a.maxY],
      [a.maxX, a.maxY],
    ] as const) {
      expect(shapeSdf(t, { x: x - 100, y: y - 100 })).toBeLessThan(0);
    }
  });

  it('validates the corner count and radius', () => {
    expect(validateElement(triangle())).toBeNull();
    expect(validateElement(triangle({ sides: 2 }))).toMatch(/sides/);
    expect(validateElement(triangle({ sides: 3.5 }))).toMatch(/sides/);
    expect(validateElement(makeRect('r', { radius: -1 }))).toMatch(/radius/);
  });
});

describe('rounded rectangles', () => {
  it('a square at the maximum radius is a circle', () => {
    const s = makeRect('s', { w: 100, h: 100, radius: 1000 });
    expect(effectiveRadius(s)).toBe(50);
    for (let a = 0; a < Math.PI * 2; a += 0.3) {
      const p = { x: Math.cos(a) * 50, y: Math.sin(a) * 50 };
      expect(shapeSdf(s, p)).toBeCloseTo(0, 6);
    }
    expect(hitTestElement(s, { x: 3, y: 3 })).toBe(false); // the box corner is cut off
    expect(hitTestElement(s, { x: 50, y: 3 })).toBe(true);
  });

  it('the radius handle sits on the corner arc center and dragging it changes the radius', () => {
    const s = makeRect('s', { w: 100, h: 100, radius: 20 });
    expect(radiusHandleLocal(s, 5)).toEqual({ x: -30, y: -30 });
    // Below the minimum offset it stays put so it can still be grabbed.
    expect(radiusHandleLocal(makeRect('z', { radius: 0 }), 14)).toEqual({
      x: expect.closeTo(-50 + 14 * Math.SQRT1_2),
      y: expect.closeTo(-50 + 14 * Math.SQRT1_2),
    });
    // 10 units along the diagonal = 10 / √2 more radius; clamped to [0, max].
    expect(radiusAfterDrag(s, 20, 10 * Math.SQRT2)).toBeCloseTo(30);
    expect(radiusAfterDrag(s, 20, -1000)).toBe(0);
    expect(radiusAfterDrag(s, 20, 1000)).toBe(50);
  });
});

describe('connectors on rounded and polygonal outlines', () => {
  const line = (patch: Partial<ConnectorElement>): ConnectorElement => ({
    id: 'c',
    type: 'connector',
    z: 1,
    start: { kind: 'element', id: 't' },
    end: { kind: 'point', x: 600, y: 100 },
    route: 'straight',
    stroke: 0,
    strokeWidth: 0, // hairline: the end lands exactly on the outline
    dash: 'solid',
    startCap: 'none',
    endCap: 'arrow',
    ...patch,
  });

  it('puts side magnets of a triangle on its outline', () => {
    const t = triangle();
    for (const anchor of [
      { x: 0, y: 0.5 },
      { x: 1, y: 0.5 },
      { x: 0.5, y: 0 },
      { x: 0.5, y: 1 },
    ]) {
      expect(shapeSdf(t, local(t, anchorPoint(t, anchor)))).toBeCloseTo(0, 5);
    }
  });

  it('starts a floating line on the outline of a rounded or polygonal shape', () => {
    for (const shape of [triangle({ radius: 25 }), makeRect('t', { radius: 40 })]) {
      const g = resolveConnector(line({}), (id) => (id === 't' ? shape : undefined))!;
      expect(shapeSdf(shape, local(shape, g.points[0]!))).toBeCloseTo(0, 4);
    }
    // Diagonal ray onto a fully rounded square: on the circle, not the box corner.
    const circleish = makeRect('t', { radius: 50 });
    const p = outlineAlongRay(circleish, { x: 1, y: 1 });
    expect(Math.hypot(p.x, p.y)).toBeCloseTo(50, 4);
  });

  it('projects points onto the outline', () => {
    const t = triangle({ radius: 10 });
    const q = closestOutlinePoint(t, { x: 80, y: 0 });
    expect(shapeSdf(t, q)).toBeCloseTo(0, 6);
  });

  it('routes elbows from a triangle without crossing it', () => {
    const t = triangle();
    const g = resolveConnector(
      line({ route: 'elbow', end: { kind: 'point', x: 600, y: 500 } }),
      (id) => (id === 't' ? t : undefined),
    )!;
    expect(shapeSdf(t, local(t, g.points[0]!))).toBeCloseTo(0, 4);
    // Every later point lies outside (or on) the triangle.
    for (const p of g.points.slice(1)) expect(shapeSdf(t, local(t, p))).toBeGreaterThan(-1e-6);
  });
});
