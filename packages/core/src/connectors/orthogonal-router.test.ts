import { describe, expect, it } from 'vitest';
import { routeOrthogonal } from './orthogonal-router';
import type { Box, Vec2 } from '../geometry/math';

const box = (minX: number, minY: number, maxX: number, maxY: number): Box => ({
  minX,
  minY,
  maxX,
  maxY,
});

function inside(b: Box, p: Vec2) {
  return p.x > b.minX && p.x < b.maxX && p.y > b.minY && p.y < b.maxY;
}

describe('routeOrthogonal', () => {
  it('goes straight when nothing is in the way', () => {
    const path = routeOrthogonal({
      from: { x: 0, y: 0 },
      fromDir: 0,
      to: { x: 100, y: 0 },
      toDir: 0,
      obstacles: [],
      bendCost: 50,
      margin: 20,
    });
    expect(path).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]);
  });

  it('goes around an obstacle between the ends, along its edges', () => {
    const wall = box(40, -50, 60, 50);
    const path = routeOrthogonal({
      from: { x: 0, y: 0 },
      fromDir: 0,
      to: { x: 100, y: 0 },
      toDir: 0,
      obstacles: [{ box: wall, margin: 0 }],
      bendCost: 50,
      margin: 20,
    })!;
    expect(path[0]).toEqual({ x: 0, y: 0 });
    expect(path[path.length - 1]).toEqual({ x: 100, y: 0 });
    for (let i = 0; i + 1 < path.length; i++) {
      const p = path[i]!;
      const q = path[i + 1]!;
      expect(p.x === q.x || p.y === q.y).toBe(true);
      expect(inside(wall, { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 })).toBe(false);
    }
  });

  it('prefers fewer turns at equal length', () => {
    const path = routeOrthogonal({
      from: { x: 0, y: 0 },
      fromDir: 0,
      to: { x: 100, y: 100 },
      toDir: 1,
      obstacles: [],
      bendCost: 50,
      margin: 20,
    })!;
    // One corner: right, then down.
    expect(path.length).toBeLessThanOrEqual(4);
  });

  it('ignores an obstacle that contains an end (it cannot be avoided anyway)', () => {
    const path = routeOrthogonal({
      from: { x: 0, y: 0 },
      fromDir: 0,
      to: { x: 100, y: 0 },
      toDir: 0,
      obstacles: [{ box: box(-10, -10, 10, 10), margin: 0 }],
      bendCost: 50,
      margin: 20,
    });
    expect(path).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]);
  });

  it('drops only the clearance of an obstacle whose clearance holds an end', () => {
    // The end at x=95 is 5 units from the wall (clearance 12): the path may pass close,
    // but still not through the wall itself.
    const wall = box(60, -50, 90, 50);
    const path = routeOrthogonal({
      from: { x: 0, y: 0 },
      fromDir: 0,
      to: { x: 95, y: 0 },
      toDir: 0,
      obstacles: [{ box: wall, margin: 12 }],
      bendCost: 50,
      margin: 20,
    })!;
    for (let i = 0; i + 1 < path.length; i++) {
      const mid = { x: (path[i]!.x + path[i + 1]!.x) / 2, y: (path[i]!.y + path[i + 1]!.y) / 2 };
      expect(inside(wall, mid)).toBe(false);
    }
  });

  it('finds a way through a field of obstacles quickly', () => {
    const obstacles: Box[] = [];
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        if ((i + j) % 3 === 0) continue;
        obstacles.push(box(100 + i * 60, -240 + j * 60, 140 + i * 60, -200 + j * 60));
      }
    }
    const t0 = performance.now();
    const path = routeOrthogonal({
      from: { x: 0, y: 0 },
      fromDir: 0,
      to: { x: 700, y: 0 },
      toDir: 0,
      obstacles: obstacles.map((b) => ({ box: b, margin: 0 })),
      bendCost: 50,
      margin: 20,
    })!;
    expect(performance.now() - t0).toBeLessThan(50);
    for (let i = 0; i + 1 < path.length; i++) {
      const mid = { x: (path[i]!.x + path[i + 1]!.x) / 2, y: (path[i]!.y + path[i + 1]!.y) / 2 };
      for (const o of obstacles) expect(inside(o, mid)).toBe(false);
    }
  });
});
