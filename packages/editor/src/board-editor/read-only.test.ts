import { Camera, CameraAnimator, Scene, type ShapeElement } from '@apeiro/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { BoardEditor } from './board-editor';
import { attachControls } from '../input/controls';
import { ToolState } from '../tools/tool-state';
import { Overlay } from '../overlay/overlay';

const box = (id: string, x = 0): ShapeElement => ({
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

describe('BoardEditor readOnly', () => {
  it('refuses every command that changes the board, keeps selecting and copying', () => {
    const editor = new BoardEditor();
    editor.addElements([box('a'), box('b', 200)], { select: false });
    editor.setReadOnly(true);
    expect(editor.readOnly).toBe(true);
    const before = editor.getElements();

    editor.addElements([box('c')]);
    editor.updateElements(['a'], { x: 50 });
    editor.select(['a', 'b']);
    expect(editor.selection).toEqual(['a', 'b']);
    editor.deleteSelection();
    editor.reorderSelection('front');
    editor.group();
    expect(editor.duplicate()).toEqual([]);
    expect(editor.cut()).toBeNull();
    expect(editor.place('sticky')).toBeNull();
    expect(editor.addText()).toBeNull();
    expect(editor.pasteText('hi')).toBeNull();
    const copied = editor.copy();
    expect(copied).not.toBeNull();
    expect(editor.paste(copied)).toEqual([]);
    editor.undo();

    expect(editor.getElements()).toEqual(before);
    editor.destroy();
  });

  it('offers only the tools that change nothing', () => {
    const editor = new BoardEditor();
    editor.setTool('pen');
    editor.setReadOnly(true);
    expect(editor.tool).toBe('select'); // a creating tool is dropped
    editor.setTool('rect');
    expect(editor.tool).toBe('select');
    editor.setTool('hand');
    expect(editor.tool).toBe('hand');
    editor.setTool('comment');
    expect(editor.tool).toBe('comment');
    editor.destroy();
  });

  it('lets the scene refuse local edits but take remote ones and loads', () => {
    const editor = new BoardEditor({ readOnly: true });
    editor.scene.add(box('local'));
    expect(editor.scene.has('local')).toBe(false);
    editor.scene.transact(() => editor.scene.add(box('remote')), 'yjs');
    expect(editor.scene.has('remote')).toBe(true);
    expect(editor.scene.update('remote', { x: 9 })).toBe(false);
    editor.load([box('loaded')]);
    expect(editor.getElements().map((e) => e.id)).toEqual(['loaded']);
    editor.destroy();
  });

  it('can become editable again, and tells listeners', () => {
    const editor = new BoardEditor({ readOnly: true });
    let events = 0;
    editor.on('readOnly', () => events++);
    editor.setReadOnly(false);
    editor.addElements([box('a')]);
    expect(editor.scene.has('a')).toBe(true);
    expect(events).toBe(1);
    editor.destroy();
  });
});

describe('controls on a read-only board', () => {
  let scene: Scene;
  let stage: HTMLElement;
  let overlay: Overlay;
  let tools: ToolState;
  let readOnly: boolean;

  const pointer = (type: string, x: number, y: number) =>
    stage.dispatchEvent(
      new PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: 1, bubbles: true }),
    );
  const key = (k: string, init: KeyboardEventInit = {}) =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }));

  beforeEach(() => {
    document.body.innerHTML = '<div id="stage"></div><canvas id="overlay"></canvas>';
    stage = document.getElementById('stage')!;
    stage.setPointerCapture = () => undefined;
    stage.releasePointerCapture = () => undefined;
    stage.hasPointerCapture = () => false;
    scene = new Scene();
    scene.add(box('a'));
    const camera = new Camera();
    camera.setViewport(1000, 1000);
    const canvas = document.getElementById('overlay') as HTMLCanvasElement;
    canvas.getContext = (() =>
      new Proxy({}, { get: () => () => undefined, set: () => true })) as never;
    overlay = new Overlay(canvas, scene, camera);
    tools = new ToolState();
    readOnly = true;
    attachControls(stage, scene, camera, overlay, tools, new CameraAnimator(camera), {
      readOnly: () => readOnly,
    });
  });

  it('selects with a click but a drag moves nothing', () => {
    pointer('pointerdown', 50, 50);
    pointer('pointermove', 150, 150);
    pointer('pointerup', 150, 150);
    expect(overlay.selection).toEqual(new Set(['a']));
    expect((scene.get('a') as ShapeElement).x).toBe(0);
  });

  it('shows no connection dots and ignores editing keys', () => {
    pointer('pointermove', 50, 50);
    expect(overlay.anchorsFor).toBeNull();
    overlay.selection = new Set(['a']);
    key('Delete');
    key('ArrowRight');
    key('r');
    expect(scene.has('a')).toBe(true);
    expect((scene.get('a') as ShapeElement).x).toBe(0);
    expect(tools.tool).toBe('select');
    key('h');
    expect(tools.tool).toBe('hand');
  });

  it('treats a creating tool as select', () => {
    tools.setTool('rect');
    pointer('pointerdown', 500, 500);
    pointer('pointerup', 500, 500);
    expect(scene.size).toBe(1);
  });

  it('works normally once editable', () => {
    readOnly = false;
    pointer('pointerdown', 50, 50);
    pointer('pointermove', 100, 50);
    pointer('pointermove', 150, 50);
    pointer('pointerup', 150, 50);
    expect((scene.get('a') as ShapeElement).x).toBe(100);
  });
});
