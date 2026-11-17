import { describe, expect, it } from 'vitest';
import type { ShapeElement } from './element';
import { validateElement } from './validation';
import { hitTestElement } from './hit-test';
import { inkGeometry, inkWorldPoints, simplifyStroke } from './ink';

const ink = (pts: Array<{ x: number; y: number }>, patch: Partial<ShapeElement> = {}) =>
  ({
    id: 'i',
    type: 'ink',
    ...inkGeometry(pts),
    rotation: 0,
    z: 0,
    fill: 0,
    stroke: 0x000000ff,
    strokeWidth: 4,
    radius: 0,
    ...patch,
  }) as ShapeElement;

describe('ink strokes', () => {
  it('stores points as fractions of the box and gives them back in world space', () => {
    const pts = [
      { x: 10, y: 20 },
      { x: 110, y: 70 },
      { x: 60, y: 20 },
    ];
    const el = ink(pts);
    expect([el.x, el.y, el.w, el.h]).toEqual([10, 20, 100, 50]);
    expect(el.points).toEqual([0, 0, 1, 1, 0.5, 0]);
    const back = inkWorldPoints(el);
    back.forEach((p, i) => {
      expect(p.x).toBeCloseTo(pts[i]!.x);
      expect(p.y).toBeCloseTo(pts[i]!.y);
    });
  });

  it('a straight or single-point stroke gets a tiny box centered on it', () => {
    const line = ink([
      { x: 0, y: 5 },
      { x: 50, y: 5 },
    ]);
    expect(line.w).toBe(50);
    expect(line.h).toBeGreaterThan(0);
    expect(inkWorldPoints(line)[1]!.y).toBeCloseTo(5);
    const dot = ink([{ x: 7, y: 9 }]);
    expect(inkWorldPoints(dot)[0]!.x).toBeCloseTo(7);
    expect(inkWorldPoints(dot)[0]!.y).toBeCloseTo(9);
  });

  it('follows the box when it is rotated and resized', () => {
    const el = ink([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ]);
    const turned = { ...el, rotation: Math.PI / 2 };
    const [a] = inkWorldPoints(turned);
    // Top-left corner turned a quarter around the center (50, 50) lands top-right.
    expect(a!.x).toBeCloseTo(100);
    expect(a!.y).toBeCloseTo(0);
    // Resizing is a box change only: the points stay the same array.
    const scaled = { ...el, w: 200, h: 50 };
    const c = inkWorldPoints(scaled)[2]!;
    expect(c.x).toBeCloseTo(200);
    expect(c.y).toBeCloseTo(50);
  });

  it('is hit near its line only', () => {
    const el = ink([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ]);
    expect(hitTestElement(el, { x: 50, y: 1 })).toBe(true);
    expect(hitTestElement(el, { x: 101, y: 60 })).toBe(true);
    expect(hitTestElement(el, { x: 40, y: 40 })).toBe(false); // inside the box, off the line
    expect(hitTestElement(el, { x: 40, y: 10 }, 9)).toBe(true); // within the tolerance
  });

  it('simplification keeps corners and drops points on straight runs', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 10, y: 0.1 },
      { x: 20, y: 0 },
      { x: 20, y: 10 },
      { x: 20, y: 20 },
    ];
    expect(simplifyStroke(pts, 0.5)).toEqual([pts[0], pts[2], pts[4]]);
  });

  it('validation requires finite point pairs', () => {
    expect(validateElement(ink([{ x: 0, y: 0 }]))).toBeNull();
    expect(validateElement({ ...ink([{ x: 0, y: 0 }]), points: [] })).toMatch(/at least one/);
    expect(validateElement({ ...ink([{ x: 0, y: 0 }]), points: [0, 1, 2] })).toMatch(/pairs/);
    expect(validateElement({ ...ink([{ x: 0, y: 0 }]), points: [0, NaN] })).toMatch(/finite/);
  });
});
