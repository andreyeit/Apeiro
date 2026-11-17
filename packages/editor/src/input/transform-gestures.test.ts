import { describe, expect, it } from 'vitest';
import { dragStep, resizeStep, type SnapContext } from './transform-gestures';

const k = (over: Partial<SnapContext> = {}): SnapContext => ({
  zoom: 1,
  snapping: true,
  shift: false,
  alt: false,
  deep: false,
  ...over,
});
const box = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
const target = { minX: 300, minY: 0, maxX: 400, maxY: 100 };

describe('dragStep', () => {
  it('follows the pointer, Shift keeping the dominant axis', () => {
    expect(dragStep({ x: 0, y: 0 }, { x: 30, y: 10 }, box, [], true, k())).toMatchObject({
      dx: 30,
      dy: 10,
    });
    expect(
      dragStep(
        { x: 0, y: 0 },
        { x: 30, y: 10 },
        box,
        [],
        true,
        k({ shift: true, snapping: false }),
      ),
    ).toMatchObject({ dx: 30, dy: 0 });
  });

  it('snaps to a nearby edge once moved, never with Ctrl/⌘', () => {
    // Right edge at 297 is 3px from the target's left edge (300).
    const at = { x: 197, y: 0 };
    expect(dragStep({ x: 0, y: 0 }, at, box, [target], true, k()).dx).toBe(200);
    expect(dragStep({ x: 0, y: 0 }, at, box, [target], false, k()).dx).toBe(197);
    expect(dragStep({ x: 0, y: 0 }, at, box, [target], true, k({ deep: true })).dx).toBe(197);
  });
});

describe('resizeStep', () => {
  it('scales the elements into the dragged frame and labels the size', () => {
    const rect = {
      id: 'a',
      type: 'rect' as const,
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      rotation: 0,
      z: 0,
      fill: 0,
      stroke: 0,
      strokeWidth: 0,
      radius: 0,
    };
    const step = resizeStep(
      {
        handle: 'e',
        frame: { cx: 50, cy: 50, w: 100, h: 100, rotation: 0 },
        originals: [rect],
        start: { x: 50, y: 0 },
        lockAspect: false,
        scaleText: false,
        targets: [],
      },
      { x: 100, y: 0 },
      k(),
    );
    expect(step.badge).toBe('150 × 100');
    expect(step.patches.get('a')).toMatchObject({ w: 150 });
  });
});
