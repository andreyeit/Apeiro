import { describe, expect, it } from 'vitest';
import { eraseStroke, smoothStroke } from './ink';

describe('smoothStroke', () => {
  it('passes through every point, with more points in between', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 40, y: 30 },
      { x: 80, y: 0 },
    ];
    const s = smoothStroke(pts, 4);
    expect(s.length).toBeGreaterThan(10);
    for (const p of pts) expect(s.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 1e-9)).toBe(true);
  });

  it('bends smoothly: no sharp turn left at the middle point', () => {
    const s = smoothStroke(
      [
        { x: 0, y: 0 },
        { x: 40, y: 30 },
        { x: 80, y: 0 },
      ],
      2,
    );
    let worst = 0;
    for (let i = 1; i + 1 < s.length; i++) {
      const a = Math.atan2(s[i]!.y - s[i - 1]!.y, s[i]!.x - s[i - 1]!.x);
      const b = Math.atan2(s[i + 1]!.y - s[i]!.y, s[i + 1]!.x - s[i]!.x);
      worst = Math.max(worst, Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a))));
    }
    expect(worst).toBeLessThan(0.3); // radians per piece; the raw polyline turns ~1.3 at once
  });

  it('leaves short strokes as they are', () => {
    expect(
      smoothStroke(
        [
          { x: 0, y: 0 },
          { x: 5, y: 5 },
        ],
        1,
      ),
    ).toHaveLength(2);
  });
});

describe('eraseStroke', () => {
  const line = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ];

  it('cuts the part under the eraser out, exactly at its edge', () => {
    const pieces = eraseStroke(line, { x: 50, y: 0 }, 10)!;
    expect(pieces).toHaveLength(2);
    expect(pieces[0]!.at(-1)!.x).toBeCloseTo(40);
    expect(pieces[1]![0]!.x).toBeCloseTo(60);
    expect(pieces[0]![0]).toEqual({ x: 0, y: 0 });
    expect(pieces[1]!.at(-1)).toEqual({ x: 100, y: 0 });
  });

  it('shortens a stroke from its end, and erases one that is covered completely', () => {
    const end = eraseStroke(line, { x: 100, y: 0 }, 10)!;
    expect(end).toHaveLength(1);
    expect(end[0]!.at(-1)!.x).toBeCloseTo(90);
    expect(eraseStroke(line, { x: 50, y: 0 }, 80)).toEqual([]);
  });

  it('leaves strokes it does not touch alone (null)', () => {
    expect(eraseStroke(line, { x: 50, y: 30 }, 10)).toBeNull();
  });

  it('catches a long segment crossing the eraser between its points', () => {
    expect(
      eraseStroke(
        [
          { x: 0, y: 0 },
          { x: 1000, y: 0 },
        ],
        { x: 500, y: 2 },
        5,
      ),
    ).toHaveLength(2);
  });
});
