import type { ConnectorElement, ShapeElement } from '@apeiro/core';
import { describe, expect, it } from 'vitest';
import { BoardEditor } from '../board-editor/board-editor';
import type { DraftScene } from './draft-preview';
import { exportFrame } from '../export/export-image';

const sticky = (id: string, x = 0, z = 0): ShapeElement => ({
  id,
  type: 'sticky',
  x,
  y: 0,
  w: 100,
  h: 100,
  rotation: 0,
  z,
  fill: 0xfef3c7ff,
  stroke: 0,
  strokeWidth: 0,
  radius: 4,
});

const link = (id: string, from: string, to: string): ConnectorElement => ({
  id,
  type: 'connector',
  z: 0,
  start: { kind: 'element', id: from },
  end: { kind: 'element', id: to },
  route: 'straight',
  stroke: 0x000000ff,
  strokeWidth: 1,
  dash: 'solid',
  startCap: 'none',
  endCap: 'arrow',
});

describe('preview of proposed changes', () => {
  it('changes nothing until applied, then applies as one undo step', () => {
    const editor = new BoardEditor();
    editor.addElements([sticky('a'), sticky('old', 300)], { select: false });
    const before = editor.getElements();
    editor.showPreview({
      add: [sticky('idea', 600), link('l', 'a', 'idea')],
      update: [{ id: 'a', x: 50 }],
      remove: ['old'],
    });
    expect(editor.getElements()).toEqual(before);
    expect(editor.preview?.add.map((e) => e.id)).toEqual(['idea', 'l']);

    const ids = editor.applyPreview();
    expect(editor.preview).toBeNull();
    expect(ids.sort()).toEqual(['a', 'idea', 'l']);
    expect(editor.scene.has('old')).toBe(false);
    expect((editor.scene.get('a') as ShapeElement).x).toBe(50);
    expect(editor.selection.slice().sort()).toEqual(['a', 'idea', 'l']);

    editor.undo();
    expect(editor.getElements()).toEqual(before);
    editor.destroy();
  });

  it('discards without a trace', () => {
    const editor = new BoardEditor();
    editor.addElements([sticky('a')], { select: false });
    let events = 0;
    editor.on('preview', () => events++);
    editor.showPreview({ add: [sticky('b', 200)] });
    editor.discardPreview();
    expect(editor.preview).toBeNull();
    expect(editor.scene.has('b')).toBe(false);
    expect(editor.canUndo).toBe(true); // only the first addElements
    expect(events).toBe(2);
    editor.destroy();
  });

  it('renames clashing ids (connectors follow) and puts new elements on top', () => {
    const editor = new BoardEditor();
    editor.addElements([sticky('a', 0, 5)], { select: false });
    editor.showPreview({ add: [sticky('a', 300, 0), link('l', 'a', 'a')] });
    const [shape, line] = editor.preview!.add as [ShapeElement, ConnectorElement];
    expect(shape.id).not.toBe('a');
    expect(shape.z).toBeGreaterThan(5);
    expect(line.end).toEqual({ kind: 'element', id: shape.id });
    editor.destroy();
  });

  it('drops changes of missing elements and rejects invalid ones', () => {
    const editor = new BoardEditor();
    editor.showPreview({ update: [{ id: 'nope', x: 1 }], remove: ['nope'] });
    expect(editor.preview).toEqual({ add: [], update: [], remove: [] });
    expect(() => editor.showPreview({ add: [{ ...sticky('bad'), w: Number.NaN }] })).toThrow(/bad/);
    editor.destroy();
  });

  it('skips what someone else deleted meanwhile, and does nothing read-only', () => {
    const editor = new BoardEditor();
    editor.addElements([sticky('a')], { select: false });
    editor.showPreview({ update: [{ id: 'a', x: 10 }], add: [sticky('n', 400)] });
    editor.scene.transact(() => editor.scene.remove('a'), 'yjs');
    editor.setReadOnly(true);
    expect(editor.applyPreview()).toEqual([]);
    expect(editor.preview).not.toBeNull();
    editor.setReadOnly(false);
    expect(editor.applyPreview()).toEqual(['n']);
    editor.destroy();
  });

  it('keeps draft lines attached when someone moves the shapes they connect to', () => {
    const editor = new BoardEditor();
    editor.addElements([sticky('a')], { select: false });
    editor.showPreview({ add: [sticky('n', 400), link('l', 'a', 'n')] });
    const ghost = (editor as unknown as { draft: { scene: DraftScene } }).draft.scene.scene;
    const startX = () => ghost.connectorGeometry('l')!.points[0]!.x;
    const before = startX();
    editor.scene.transact(() => editor.scene.update('a', { x: -200 }), 'yjs');
    expect(startX()).toBeCloseTo(before - 200);
    // The copy of 'a' is there for the line only: it draws nothing.
    expect(ghost.get('a')).toMatchObject({ type: 'rect', fill: 0, stroke: 0 });
    editor.destroy();
  });
});

describe('exportFrame', () => {
  it('pads the box and scales it', () => {
    expect(exportFrame({ minX: 0, minY: 0, maxX: 100, maxY: 50 }, 2, 10)).toEqual({
      x: -10,
      y: -10,
      width: 240,
      height: 140,
      zoom: 2,
    });
  });

  it('scales down to fit the largest side', () => {
    const f = exportFrame({ minX: 0, minY: 0, maxX: 10_000, maxY: 100 }, 2, 0, 4096);
    expect(f.width).toBe(4096);
    expect(f.zoom).toBeCloseTo(0.4096);
  });
});
