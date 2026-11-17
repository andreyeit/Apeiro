import type { ShapeElement } from '@apeiro/core';
import { afterEach, describe, expect, it } from 'vitest';
import { BoardEditor } from './board-editor';

const rect = (id: string, x = 0): ShapeElement => ({
  id,
  type: 'rect',
  x,
  y: 0,
  w: 100,
  h: 100,
  rotation: 0,
  z: 0,
  fill: 0xffffffff,
  stroke: 0,
  strokeWidth: 0,
  radius: 0,
});

let editor: BoardEditor;
afterEach(() => editor.destroy());

describe('BoardEditor clipboard', () => {
  it('copy + paste adds selected copies in the middle of the view, one undo step', () => {
    editor = new BoardEditor();
    editor.camera.setViewport(1000, 800);
    editor.addElements([rect('a')]);
    expect(editor.copy()?.elements).toHaveLength(1);
    const ids = editor.paste();
    expect(ids).toHaveLength(1);
    expect(editor.selection).toEqual(ids);
    expect(editor.scene.get(ids[0]!)).toMatchObject({ x: 450, y: 350 });
    editor.undo();
    expect(editor.scene.has(ids[0]!)).toBe(false);
    expect(editor.scene.has('a')).toBe(true);
  });

  it('pasting again at the same place steps aside each time', () => {
    editor = new BoardEditor();
    editor.addElements([rect('a')]);
    editor.copy();
    const at = { x: 0, y: 0 };
    const p1 = editor.scene.get(editor.paste(undefined, at)[0]!)!;
    const p2 = editor.scene.get(editor.paste(undefined, at)[0]!)!;
    expect('x' in p2 && 'x' in p1 && p2.x - p1.x).toBe(24);
  });

  it('cut copies and deletes', () => {
    editor = new BoardEditor();
    editor.addElements([rect('a')]);
    editor.cut();
    expect(editor.scene.has('a')).toBe(false);
    expect(editor.paste()).toHaveLength(1);
  });

  it('duplicate puts selected copies next to the originals', () => {
    editor = new BoardEditor();
    editor.addElements([rect('a', 100)]);
    const [id] = editor.duplicate();
    expect(editor.scene.get(id!)).toMatchObject({ x: 124, y: 24 });
    expect(editor.selection).toEqual([id]);
    expect(editor.scene.has('a')).toBe(true);
  });

  it('copy with nothing selected copies nothing and paste with nothing copied adds nothing', () => {
    editor = new BoardEditor();
    expect(editor.copy()).toBeNull();
    expect(editor.paste()).toEqual([]);
    expect(editor.duplicate()).toEqual([]);
  });

  it('pastes plain text as a text box', () => {
    editor = new BoardEditor();
    const id = editor.pasteText('hello\r\nworld', { x: 0, y: 0 })!;
    const el = editor.scene.get(id) as ShapeElement;
    expect(el.type).toBe('text');
    expect(el.text!.runs).toEqual([{ text: 'hello\nworld' }]);
    expect(editor.selection).toEqual([id]);
  });
});
