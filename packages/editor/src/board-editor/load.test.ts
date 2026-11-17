import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShapeElement } from '@apeiro/core';
import { BoardEditor } from './board-editor';

const box = (id: string, w = 100): ShapeElement => ({
  id,
  type: 'rect',
  x: 0,
  y: 0,
  w,
  h: 100,
  rotation: 0,
  z: 0,
  fill: 0xffffffff,
  stroke: 0,
  strokeWidth: 0,
  radius: 0,
});

describe('BoardEditor.load', () => {
  let editor: BoardEditor;
  afterEach(() => editor?.destroy());

  it.each([
    { name: 'an invalid element', elements: [box('new'), box('invalid', -1)] },
    { name: 'duplicate ids', elements: [box('new'), box('new')] },
  ])(
    'keeps content, selection and history without notifying subscribers on $name',
    ({ elements }) => {
      editor = new BoardEditor();
      editor.load([box('original')]);
      editor.updateElements(['original'], { x: 50 });
      editor.select(['original']);
      const before = editor.getElements();
      const onChange = vi.fn();
      editor.scene.subscribe(onChange);

      expect(() => editor.load(elements)).toThrow();
      expect(editor.getElements()).toEqual(before);
      expect(editor.scene.get('original')).toBe(before[0]);
      expect(editor.selection).toEqual(['original']);
      expect(editor.canUndo).toBe(true);
      expect(onChange).not.toHaveBeenCalled();

      editor.undo();
      expect(editor.scene.get('original')).toMatchObject({ x: 0 });
    },
  );

  it('replaces content in the same scene in one batch and clears history and selection', () => {
    editor = new BoardEditor();
    editor.addElements([box('original')]);
    const scene = editor.scene;
    const onChange = vi.fn();
    scene.subscribe(onChange);

    editor.load([box('original', 200), box('new')]);

    expect(editor.scene).toBe(scene);
    expect(editor.getElements()).toHaveLength(2);
    expect(scene.get('original')).toMatchObject({ w: 200 });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ origin: 'load' }));
    expect(editor.selection).toEqual([]);
    expect(editor.canUndo).toBe(false);
  });
});
