import { describe, expect, it } from 'vitest';
import { compareZ, Scene } from './scene';
import { makeRect } from '../test-utils';

const fresh = (scene: Scene) => [...scene.all()].sort(compareZ);

describe('Scene.sortedByZ cache', () => {
  it('stays equal to a fresh sort through edits, reorders, adds, removes and re-adds', () => {
    const scene = new Scene();
    scene.transact(() => {
      for (let i = 0; i < 50; i++) scene.add(makeRect(`r${i}`, { z: (i * 7) % 13, x: i }));
    });
    // A deterministic pseudo-random walk over every kind of change.
    let seed = 1;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    let next = 50;
    for (let step = 0; step < 400; step++) {
      expect(scene.sortedByZ()).toEqual(fresh(scene));
      const ids = [...scene.all()].map((el) => el.id);
      const id = ids[rand(ids.length)]!;
      switch (rand(6)) {
        case 0:
          scene.update(id, { x: rand(1000) });
          break;
        case 1:
          scene.update(id, { z: rand(20) });
          break;
        case 2:
          scene.add(makeRect(`r${next++}`, { z: rand(20) }));
          break;
        case 3:
          scene.remove(id);
          break;
        case 4:
          // Removed and added back in one batch: reported as updated.
          scene.transact(() => {
            const el = scene.get(id)!;
            scene.remove(id);
            scene.add({ ...(el as ReturnType<typeof makeRect>), fill: rand(255) });
          });
          break;
        default:
          scene.transact(() => {
            for (const other of ids.slice(0, 5)) scene.update(other, { y: rand(100) });
          });
      }
    }
    expect(scene.sortedByZ()).toEqual(fresh(scene));
  });

  it('returns a copy the caller may change', () => {
    const scene = new Scene();
    scene.add(makeRect('a'));
    scene.add(makeRect('b', { z: 1 }));
    const first = scene.sortedByZ();
    first.reverse();
    expect(scene.sortedByZ().map((el) => el.id)).toEqual(['a', 'b']);
  });

  it('gives the current version of an element changed in place', () => {
    const scene = new Scene();
    scene.add(makeRect('a'));
    scene.sortedByZ();
    scene.update('a', { x: 77 });
    expect(scene.sortedByZ()[0]).toBe(scene.get('a'));
  });
});
