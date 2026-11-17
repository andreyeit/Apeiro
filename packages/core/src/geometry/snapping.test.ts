import { describe, expect, it } from 'vitest';
import { gridStep, snapBox } from './snapping';

const box = (x: number, y: number, w = 100, h = 50) => ({
  minX: x,
  minY: y,
  maxX: x + w,
  maxY: y + h,
});

describe('gridStep', () => {
  it('follows the drawn grid: 24 at zoom 1, 4× coarser per hidden level', () => {
    expect(gridStep(1)).toBe(24);
    expect(gridStep(0.5)).toBe(24); // 12px on screen: still visible
    expect(gridStep(0.4)).toBe(96);
    expect(gridStep(0.05)).toBe(384);
  });
});

describe('snapBox', () => {
  it('snaps edges to edges of another element and reports a guide', () => {
    const target = box(200, 0);
    // Left edge at 203: 3 units from the target's left edge (threshold 5).
    const r = snapBox(box(203, 120), [target], { threshold: 5 });
    expect(r.dx).toBeCloseTo(-3);
    // Same width: left, center and right all line up — one guide each, like Figma.
    expect(r.guides.map((g) => g.at).sort()).toEqual([200, 250, 300]);
    for (const g of r.guides) {
      expect(g.axis).toBe('x');
      expect(g.from).toBe(0); // spans from the target's top...
      expect(g.to).toBe(170); // ...to the moving box's bottom
    }
  });

  it('snaps centers to centers', () => {
    const target = box(0, 0, 200, 50); // center x = 100
    const r = snapBox(box(52, 200, 100, 50), [target], { threshold: 4 }); // center 102
    expect(r.dx).toBeCloseTo(-2);
    expect(r.guides.some((g) => g.axis === 'x' && g.at === 100)).toBe(true);
  });

  it('picks the closest line and falls back to the grid on the other axis', () => {
    const r = snapBox(box(97, 30), [box(0, 500)], { threshold: 4, grid: 24 });
    expect(r.dx).toBeCloseTo(3); // right edge 197 → no; left 97 → target max 100
    expect(r.dy).toBeCloseTo(-6); // no element near on y: top 30 → grid 24
    expect(r.guides.every((g) => g.axis === 'x')).toBe(true);
  });

  it('respects the axis locks', () => {
    const r = snapBox(box(203, 3), [box(200, 0)], { threshold: 5, lockY: true });
    expect(r.dx).toBeCloseTo(-3);
    expect(r.dy).toBe(0);
  });

  it('a resize snaps only the dragged edge', () => {
    // Dragging the right edge (at 297) near the target's right edge (300).
    const r = snapBox(box(0, 100, 297, 50), [box(150, 0, 150, 50)], {
      threshold: 5,
      edges: { x: ['max'], y: [] },
    });
    expect(r.dx).toBeCloseTo(3);
    expect(r.dy).toBe(0);
    expect(r.guides[0]).toMatchObject({ axis: 'x', at: 300 });
  });

  it('does nothing without targets or grid', () => {
    expect(snapBox(box(13, 17), [], { threshold: 5 })).toEqual({
      dx: 0,
      dy: 0,
      guides: [],
      spacing: [],
    });
  });
});

describe('equal spacing (Figma distance guides)', () => {
  // A row: boxes 100 wide at y 0..50.
  const A = box(0, 0);
  const B = box(300, 0);

  it('centers the box between two neighbours with equal gaps', () => {
    // 60 wide between A (ends at 100) and B (starts at 300): centered at 170..230.
    const r = snapBox(box(173, 0, 60, 50), [A, B], { threshold: 5, lockY: true });
    expect(r.dx).toBeCloseTo(-3);
    expect(r.spacing).toHaveLength(1);
    const g = r.spacing[0]!;
    expect(g).toMatchObject({ axis: 'x', distance: 70 });
    expect(g.segments).toEqual([
      { from: 100, to: 170, at: 25 },
      { from: 230, to: 300, at: 25 },
    ]);
  });

  it('continues the gap of the pair next to it, on either side', () => {
    // Gap A→B is 200; after B (ends 400) the next box goes at 600.
    let r = snapBox(box(597, 10), [A, B], { threshold: 5, lockY: true });
    expect(r.dx).toBeCloseTo(3);
    expect(r.spacing[0]).toMatchObject({ axis: 'x', distance: 200 });
    expect(r.spacing[0]!.segments.map((s) => [s.from, s.to])).toEqual([
      [400, 600],
      [100, 300],
    ]);
    // Before A: ends at -200.
    r = snapBox(box(-302, 0), [A, B], { threshold: 5, lockY: true });
    expect(r.dx).toBeCloseTo(2);
    expect(r.spacing[0]!.distance).toBeCloseTo(200);
  });

  it('works vertically, in a column', () => {
    const top = box(0, 0, 100, 40);
    const mid = box(0, 100, 100, 40); // gap 60
    const r = snapBox(box(5, 203, 100, 40), [top, mid], { threshold: 5, lockX: true });
    expect(r.dy).toBeCloseTo(-3); // 140 + 60 = 200
    expect(r.spacing[0]).toMatchObject({ axis: 'y', distance: 60 });
  });

  it('ignores boxes outside the row', () => {
    const far = box(300, 500); // not overlapping the row's y range
    const r = snapBox(box(597, 0), [A, far], { threshold: 5, lockY: true });
    expect(r.spacing).toEqual([]);
  });

  it('a resize makes no spacing guides', () => {
    const r = snapBox(box(173, 0, 60, 50), [A, B], {
      threshold: 5,
      edges: { x: ['max'], y: [] },
    });
    expect(r.spacing).toEqual([]);
  });
});
