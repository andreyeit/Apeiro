import { describe, expect, it } from 'vitest';
import {
  clipboardFromHtml,
  clipboardText,
  clipboardToHtml,
  copyElements,
  duplicateElements,
  isBoardClipboard,
  pasteElements,
} from './clipboard';
import type { ConnectorElement } from '../connectors';
import type { ShapeElement } from '../elements/element';
import { Scene } from './scene';
import { makeRect } from '../test-utils';
import { textBlock } from '../text/text-block';

const line = (id: string, from: string, to: string): ConnectorElement => ({
  id,
  type: 'connector',
  z: 10,
  start: { kind: 'element', id: from },
  end: { kind: 'element', id: to },
  route: 'straight',
  startCap: 'none',
  endCap: 'arrow',
  dash: 'solid',
  stroke: 0xff,
  strokeWidth: 2,
});

function board() {
  const scene = new Scene({ freeze: true });
  scene.transact(() => {
    scene.add(makeRect('a', { x: 0, y: 0, z: 1, text: textBlock('Alpha') }));
    scene.add(makeRect('b', { x: 300, y: 0, z: 2 }));
    scene.add(makeRect('c', { x: 600, y: 0, z: 3 }));
    scene.add(line('ab', 'a', 'b'));
    scene.add(line('bc', 'b', 'c'));
  });
  return scene;
}

const shapes = (scene: Scene, ids: string[]) => ids.map((id) => scene.get(id) as ShapeElement);

describe('copy and paste', () => {
  it('copies the lines between copied shapes and frees the ends at shapes left behind', () => {
    const scene = board();
    const data = copyElements(scene, ['a', 'b'])!;
    expect(data.elements.map((e) => e.id).sort()).toEqual(['a', 'ab', 'b']);
    const ids = pasteElements(scene, data, { offset: { x: 0, y: 500 } });
    expect(ids).toHaveLength(3);
    const copyLine = ids
      .map((id) => scene.get(id)!)
      .find((e) => e.type === 'connector') as ConnectorElement;
    const [ca, cb] = ids.filter((id) => id !== copyLine.id);
    expect(copyLine.start).toEqual({ kind: 'element', id: ca });
    expect(copyLine.end).toEqual({ kind: 'element', id: cb });
    expect(scene.connectorsOf(ca!)).toEqual([copyLine.id]);
    // A copied line whose other shape stays behind keeps its look, as a free end.
    const only = copyElements(scene, ['bc'])!;
    const c = only.elements[0] as ConnectorElement;
    expect(c.start.kind).toBe('point');
    expect(c.end.kind).toBe('point');
  });

  it('gives new ids, puts the copy on top in the same order and moves it', () => {
    const scene = board();
    const ids = pasteElements(scene, copyElements(scene, ['a', 'b'])!, {
      offset: { x: 10, y: 20 },
    });
    for (const id of ids) expect(['a', 'b', 'ab']).not.toContain(id);
    const [pa, pb] = shapes(
      scene,
      ids.filter((id) => scene.get(id)!.type === 'rect'),
    );
    expect([pa!.x, pa!.y, pb!.x, pb!.y]).toEqual([10, 20, 310, 20]);
    expect(Math.min(...ids.map((id) => scene.get(id)!.z))).toBeGreaterThan(10);
    expect(pa!.text).toEqual(textBlock('Alpha'));
  });

  it('centers the copy on a point', () => {
    const scene = board();
    const data = copyElements(scene, ['a'])!;
    const [id] = pasteElements(scene, data, { at: { x: 1000, y: 1000 } });
    expect(scene.get(id!)).toMatchObject({ x: 950, y: 950 });
  });

  it('pastes a group as a new group, and drops the group of a single pasted member', () => {
    const scene = new Scene();
    scene.add(makeRect('a', { groupId: 'g' }));
    scene.add(makeRect('b', { x: 200, groupId: 'g' }));
    const both = pasteElements(scene, copyElements(scene, ['a', 'b'])!);
    const g = scene.get(both[0]!)!.groupId;
    expect(g).toBeDefined();
    expect(g).not.toBe('g');
    expect(scene.groupMembers(g!).sort()).toEqual([...both].sort());
    const [one] = pasteElements(scene, copyElements(scene, ['a'])!);
    expect(scene.get(one!)!.groupId).toBeUndefined();
  });

  it('is one batch (one undo step) and skips invalid elements', () => {
    const scene = board();
    const data = copyElements(scene, ['a'])!;
    const bad = {
      ...data,
      elements: [...data.elements, { ...data.elements[0]!, id: 'x', w: Number.NaN }],
    };
    let batches = 0;
    scene.subscribe(() => batches++);
    expect(pasteElements(scene, bad)).toHaveLength(1);
    expect(batches).toBe(1);
  });

  it('duplicates next to the original', () => {
    const scene = board();
    const [id] = duplicateElements(scene, ['c'], { x: 24, y: 24 });
    expect(scene.get(id!)).toMatchObject({ x: 624, y: 24 });
  });

  it('round-trips through HTML and gives other apps the text', () => {
    const scene = board();
    const data = copyElements(scene, ['a', 'b'])!;
    const html = clipboardToHtml(data);
    expect(html).toContain('<p>Alpha</p>');
    expect(clipboardFromHtml(html)).toEqual(data);
    expect(clipboardFromHtml('<p>hello</p>')).toBeNull();
    expect(clipboardText(data)).toBe('Alpha');
    expect(isBoardClipboard(JSON.parse(JSON.stringify(data)))).toBe(true);
    expect(isBoardClipboard({ kind: 'other' })).toBe(false);
  });
});
