import { describe, expect, it } from 'vitest';
import type { BoardElement } from '../elements/element';
import { History } from './history';
import { applyChanges } from './remote-changes';
import { Scene, type SceneChanges } from './scene';
import { makeRect } from '../test-utils';

describe('applyChanges', () => {
  it('adds, replaces whole and removes elements in one remote batch', () => {
    const scene = new Scene();
    scene.add(makeRect('a', { strokeStyle: 'dashed' }));
    scene.add(makeRect('gone'));
    const seen: SceneChanges[] = [];
    scene.subscribe((c) => seen.push(c));
    const skipped = applyChanges(scene, {
      added: [makeRect('b', { x: 5 })],
      // Without strokeStyle: the field is gone afterwards, not merged.
      updated: [makeRect('a', { x: 9 })],
      removed: ['gone', 'never-existed'],
    });
    expect(skipped).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.origin).toBe('remote');
    expect(seen[0]!.updated.map((e) => e.id)).toEqual(['a']);
    expect(seen[0]!.added.map((e) => e.id)).toEqual(['b']);
    expect(seen[0]!.removed).toEqual(['gone']);
    expect(scene.get('a')).toMatchObject({ x: 9 });
    expect('strokeStyle' in scene.get('a')!).toBe(false);
  });

  it('skips invalid elements and reports why', () => {
    const scene = new Scene();
    const bad = { ...makeRect('x'), w: Number.NaN } as BoardElement;
    const skipped = applyChanges(scene, {
      added: [bad, makeRect('ok'), null as unknown as BoardElement],
    });
    expect(skipped.map((s) => s.id)).toEqual(['x', 'undefined']);
    expect(scene.has('ok')).toBe(true);
    expect(scene.has('x')).toBe(false);
  });

  it('is not recorded by the undo history', () => {
    const scene = new Scene();
    const history = new History(scene);
    scene.add(makeRect('mine'));
    applyChanges(scene, { added: [makeRect('theirs')] });
    history.undo();
    expect(scene.has('mine')).toBe(false);
    expect(scene.has('theirs')).toBe(true);
  });

  it('keeps connectors attached to a replaced shape', () => {
    const scene = new Scene();
    scene.add(makeRect('s1'));
    scene.add(makeRect('s2', { x: 300 }));
    scene.add({
      id: 'c',
      type: 'connector',
      z: 3,
      start: { kind: 'element', id: 's1' },
      end: { kind: 'element', id: 's2' },
      route: 'straight',
      stroke: 0x000000ff,
      strokeWidth: 1,
      dash: 'solid',
      startCap: 'none',
      endCap: 'arrow',
    });
    const before = scene.connectorGeometry('c')!.points.at(-1)!;
    applyChanges(scene, { updated: [makeRect('s2', { x: 600 })] });
    const after = scene.connectorGeometry('c')!.points.at(-1)!;
    expect(after.x).toBeGreaterThan(before.x + 200);
    expect(scene.connectorsOf('s2')).toEqual(['c']);
  });
});
