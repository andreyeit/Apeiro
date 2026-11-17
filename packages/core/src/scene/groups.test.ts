import { describe, expect, it } from 'vitest';
import {
  canGroup,
  canUngroup,
  expandToGroups,
  groupElements,
  groupOf,
  isWholeGroup,
  ungroupElements,
} from './groups';
import { History } from './history';
import { Scene } from './scene';
import { makeRect } from '../test-utils';

const sceneOf = (...ids: string[]) => {
  const scene = new Scene();
  ids.forEach((id, i) => scene.add(makeRect(id, { x: i * 200 })));
  return scene;
};

describe('groups', () => {
  it('groups elements and finds every member from any of them', () => {
    const scene = sceneOf('a', 'b', 'c');
    expect(groupElements(scene, ['a', 'b'], 'g1')).toEqual(['a', 'b']);
    expect(groupOf(scene, scene.get('a'))?.sort()).toEqual(['a', 'b']);
    expect(groupOf(scene, scene.get('c'))).toBeNull();
    expect(expandToGroups(scene, ['b', 'c'])).toEqual(new Set(['b', 'a', 'c']));
    expect(isWholeGroup(scene, new Set(['a', 'b']))).toBe(true);
    expect(canGroup(scene, new Set(['a', 'b']))).toBe(false); // already exactly one group
    expect(canGroup(scene, new Set(['a', 'b', 'c']))).toBe(true);
    expect(canGroup(scene, new Set(['c']))).toBe(false);
  });

  it('merges existing groups into the new one', () => {
    const scene = sceneOf('a', 'b', 'c', 'd');
    groupElements(scene, ['a', 'b'], 'g1');
    groupElements(scene, ['c', 'd'], 'g2');
    // Only one member of each group listed: the whole groups join.
    expect(groupElements(scene, ['a', 'c'], 'g3')?.sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(scene.groupMembers('g3').sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(scene.groupMembers('g1')).toEqual([]);
  });

  it('ungroups the whole group, whichever members are listed', () => {
    const scene = sceneOf('a', 'b', 'c');
    groupElements(scene, ['a', 'b', 'c'], 'g1');
    expect(canUngroup(scene, ['b'])).toBe(true);
    expect(ungroupElements(scene, ['b']).sort()).toEqual(['a', 'b', 'c']);
    expect(scene.groupMembers('g1')).toEqual([]);
    expect(canUngroup(scene, ['a', 'b', 'c'])).toBe(false);
  });

  it('keeps the index right through removal and undo', () => {
    const scene = sceneOf('a', 'b', 'c');
    const history = new History(scene);
    groupElements(scene, ['a', 'b', 'c'], 'g1');
    scene.remove('c');
    expect(scene.groupMembers('g1').sort()).toEqual(['a', 'b']);
    history.undo(); // c is back, still grouped
    expect(scene.groupMembers('g1').sort()).toEqual(['a', 'b', 'c']);
    history.undo(); // grouping undone
    expect(scene.groupMembers('g1')).toEqual([]);
    expect(scene.get('a')?.groupId).toBeUndefined();
  });

  it('a group left with one element acts as no group', () => {
    const scene = sceneOf('a', 'b');
    groupElements(scene, ['a', 'b'], 'g1');
    scene.remove('b');
    expect(groupOf(scene, scene.get('a'))).toBeNull();
    expect(canUngroup(scene, ['a'])).toBe(false);
  });

  it('rejects an empty groupId', () => {
    const scene = sceneOf('a');
    expect(() => scene.update('a', { groupId: '' })).toThrow(/groupId/);
  });
});
