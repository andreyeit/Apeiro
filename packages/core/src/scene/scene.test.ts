import type { ShapeElement } from '../elements/element';
import { describe, expect, it, vi } from 'vitest';
import { Scene, type SceneChanges } from './scene';
import { hitTestElement } from '../elements/hit-test';
import { hexColor, rgba } from '../elements/color';
import { elementBounds } from '../elements/element';
import { makeRect } from '../test-utils';
import { rotateAround } from '../geometry/math';

function record(scene: Scene) {
  const events: SceneChanges[] = [];
  scene.subscribe((c) => events.push(c));
  return events;
}

describe('Scene changes', () => {
  it('emits one batch per transaction', () => {
    const scene = new Scene();
    const events = record(scene);
    scene.transact(() => {
      scene.add(makeRect('a'));
      scene.add(makeRect('b'));
      scene.update('a', { x: 10 });
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.added.map((e) => e.id).sort()).toEqual(['a', 'b']);
    expect((events[0]!.added.find((e) => e.id === 'a')! as ShapeElement).x).toBe(10);
    expect(events[0]!.updated).toEqual([]);
    expect(events[0]!.orderChanged).toBe(false);
  });

  it('drops elements added and removed within one batch', () => {
    const scene = new Scene();
    const events = record(scene);
    scene.transact(() => {
      scene.add(makeRect('tmp'));
      scene.remove('tmp');
    });
    expect(events).toHaveLength(0);
  });

  it('reports remove+re-add in one batch as an update', () => {
    const scene = new Scene();
    scene.add(makeRect('a'));
    const events = record(scene);
    scene.transact(() => {
      scene.remove('a');
      scene.add(makeRect('a', { x: 5 }));
    });
    expect(events[0]!.updated.map((e) => e.id)).toEqual(['a']);
    expect(events[0]!.removed).toEqual([]);
  });

  it('replaces element objects on update (immutable snapshots)', () => {
    const scene = new Scene();
    scene.add(makeRect('a'));
    const before = scene.get('a');
    scene.update('a', { x: 1 });
    expect(scene.get('a')).not.toBe(before);
    expect((before as ShapeElement).x).toBe(0);
  });

  it('flags order changes only when z changes', () => {
    const scene = new Scene();
    scene.add(makeRect('a'));
    const events = record(scene);
    scene.update('a', { x: 1 });
    scene.update('a', { z: 5 });
    expect(events.map((e) => e.orderChanged)).toEqual([false, true]);
  });

  it('ignores updates and removals of unknown ids', () => {
    const scene = new Scene();
    const spy = vi.fn();
    scene.subscribe(spy);
    expect(scene.update('ghost', { x: 1 })).toBe(false);
    expect(scene.remove('ghost')).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects duplicate ids', () => {
    const scene = new Scene();
    scene.add(makeRect('a'));
    expect(() => scene.add(makeRect('a'))).toThrow();
  });
});

describe('Scene queries', () => {
  it('combines bounds without exposing the index box to mutation', () => {
    const scene = new Scene();
    expect(scene.bounds()).toBeNull();
    scene.add(makeRect('a', { x: -100, y: 20, strokeWidth: 4 }));
    scene.add(makeRect('b', { x: 300, y: 100 }));
    expect(scene.bounds()).toEqual({ minX: -102, minY: 18, maxX: 400, maxY: 200 });
    expect(scene.bounds(['missing'])).toBeNull();
    const selected = scene.bounds(['missing', 'a'])!;
    expect(selected).toEqual(scene.getBounds('a'));
    selected.minX = 999;
    expect(scene.getBounds('a')!.minX).toBe(-102);
  });

  it('hit-tests the topmost element', () => {
    const scene = new Scene();
    scene.add(makeRect('bottom', { z: 1 }));
    scene.add(makeRect('top', { z: 2, x: 50, y: 50 }));
    expect(scene.hitTest({ x: 75, y: 75 })?.id).toBe('top');
    expect(scene.hitTest({ x: 25, y: 25 })?.id).toBe('bottom');
    expect(scene.hitTest({ x: 500, y: 500 })).toBeUndefined();
  });

  it('breaks z ties deterministically by id', () => {
    const scene = new Scene();
    scene.add(makeRect('b'));
    scene.add(makeRect('a'));
    expect(scene.sortedByZ().map((e) => e.id)).toEqual(['a', 'b']);
    expect(scene.hitTest({ x: 1, y: 1 })?.id).toBe('b');
  });

  it('tracks moved elements in the index', () => {
    const scene = new Scene();
    scene.add(makeRect('a'));
    scene.update('a', { x: 1000, y: 1000 });
    expect(scene.hitTest({ x: 50, y: 50 })).toBeUndefined();
    expect(scene.hitTest({ x: 1050, y: 1050 })?.id).toBe('a');
  });

  it('supports intersect and contain box queries', () => {
    const scene = new Scene();
    scene.add(makeRect('inside', { x: 10, y: 10, w: 20, h: 20 }));
    scene.add(makeRect('partial', { x: 90, y: 90, w: 50, h: 50 }));
    const box = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    expect(
      scene
        .queryBox(box)
        .map((e) => e.id)
        .sort(),
    ).toEqual(['inside', 'partial']);
    expect(scene.queryBox(box, 'contain').map((e) => e.id)).toEqual(['inside']);
  });
});

describe('hitTestElement', () => {
  it('computes rotated bounds matching the corner geometry across angles and sizes', () => {
    for (const w of [0, 10, 200])
      for (const h of [0, 30, 100]) {
        for (let i = -12; i <= 12; i++) {
          const el = makeRect('a', {
            x: -150,
            y: 50,
            w,
            h,
            rotation: (i * Math.PI) / 12,
            strokeWidth: 4,
          });
          const center = { x: el.x + w / 2, y: el.y + h / 2 };
          const corners = [
            { x: el.x, y: el.y },
            { x: el.x + w, y: el.y },
            { x: el.x, y: el.y + h },
            { x: el.x + w, y: el.y + h },
          ].map((point) => rotateAround(point, center, el.rotation));
          const bounds = elementBounds(el);
          expect(bounds.minX).toBeCloseTo(Math.min(...corners.map((p) => p.x)) - 2);
          expect(bounds.maxX).toBeCloseTo(Math.max(...corners.map((p) => p.x)) + 2);
          expect(bounds.minY).toBeCloseTo(Math.min(...corners.map((p) => p.y)) - 2);
          expect(bounds.maxY).toBeCloseTo(Math.max(...corners.map((p) => p.y)) + 2);
        }
      }
  });

  it('respects ellipse shape', () => {
    const el = makeRect('e', { type: 'ellipse', w: 100, h: 50 });
    expect(hitTestElement(el, { x: 50, y: 25 })).toBe(true);
    expect(hitTestElement(el, { x: 2, y: 2 })).toBe(false); // corner of the bounding box
    expect(hitTestElement(el, { x: 99, y: 25 })).toBe(true);
  });

  it('respects rounded corners', () => {
    const el = makeRect('r', { radius: 20 });
    expect(hitTestElement(el, { x: 1, y: 1 })).toBe(false);
    expect(hitTestElement(el, { x: 1, y: 50 })).toBe(true);
  });

  it('respects rotation', () => {
    const el = makeRect('r', { w: 200, h: 20, rotation: Math.PI / 2 });
    // Rotated 90° around (100, 10): now spans x 90..110, y -90..110.
    expect(hitTestElement(el, { x: 100, y: -80 })).toBe(true);
    expect(hitTestElement(el, { x: 180, y: 10 })).toBe(false);
    const b = elementBounds(el);
    expect(b.minX).toBeCloseTo(90);
    expect(b.maxY).toBeCloseTo(110);
  });

  it('expands by tolerance and stroke', () => {
    const el = makeRect('r', { strokeWidth: 4 });
    expect(hitTestElement(el, { x: -1.5, y: 50 })).toBe(true);
    expect(hitTestElement(el, { x: -5, y: 50 })).toBe(false);
    expect(hitTestElement(el, { x: -5, y: 50 }, 4)).toBe(true);
  });
});

describe('colors', () => {
  it('packs and parses RGBA', () => {
    expect(rgba(255, 0, 128)).toBe(hexColor('#ff0080'));
    expect(hexColor('#fff')).toBe(0xffffffff);
    expect(hexColor('#11223344')).toBe(0x11223344);
    expect(() => hexColor('#zz')).toThrow();
  });
});
