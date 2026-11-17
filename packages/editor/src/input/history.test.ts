import { beforeEach, describe, expect, it } from 'vitest';
import { Camera, History, Scene, textBlock, type ShapeElement } from '@apeiro/core';
import type { BoardRenderer } from '@apeiro/renderer';
import { attachControls } from './controls';
import { ToolState } from '../tools/tool-state';
import { TextEditor } from '../text-editor/text-editor';
import { Overlay } from '../overlay/overlay';

const box = (
  id: string,
  x: number,
  y: number,
  patch: Partial<ShapeElement> = {},
): ShapeElement => ({
  id,
  type: 'rect',
  x,
  y,
  w: 100,
  h: 100,
  rotation: 0,
  z: 0,
  fill: 0xffffffff,
  stroke: 0,
  strokeWidth: 0,
  radius: 0,
  ...patch,
});

describe('controls: undo/redo', () => {
  let scene: Scene;
  let history: History;
  let stage: HTMLElement;
  let overlay: Overlay;
  let tools: ToolState;

  const pointer = (type: string, x: number, y: number) =>
    stage.dispatchEvent(
      new PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: 1, bubbles: true }),
    );
  const drag = (from: [number, number], to: [number, number]) => {
    pointer('pointerdown', ...from);
    for (let i = 1; i <= 5; i++)
      pointer(
        'pointermove',
        from[0] + ((to[0] - from[0]) * i) / 5,
        from[1] + ((to[1] - from[1]) * i) / 5,
      );
    pointer('pointerup', ...to);
  };
  const keys = (code: string, init: KeyboardEventInit = {}) =>
    window.dispatchEvent(new KeyboardEvent('keydown', { code, ctrlKey: true, ...init }));
  const x = (id: string) => (scene.get(id) as ShapeElement).x;

  beforeEach(() => {
    document.body.innerHTML = '<div id="stage"></div><canvas id="overlay"></canvas>';
    stage = document.getElementById('stage')!;
    stage.setPointerCapture = () => undefined;
    stage.releasePointerCapture = () => undefined;
    stage.hasPointerCapture = () => false;
    scene = new Scene({ freeze: true });
    scene.add(box('a', 0, 0));
    scene.add(box('b', 300, 0));
    history = new History(scene);
    const camera = new Camera();
    camera.setViewport(1000, 1000);
    const canvas = document.getElementById('overlay') as HTMLCanvasElement;
    canvas.getContext = (() =>
      new Proxy({}, { get: () => () => undefined, set: () => true })) as never;
    overlay = new Overlay(canvas, scene, camera);
    tools = new ToolState();
    attachControls(stage, scene, camera, overlay, tools, undefined, { history });
  });

  it('undoes a whole drag in one step and redoes it', () => {
    drag([50, 50], [250, 50]);
    expect(x('a')).toBe(200);
    keys('KeyZ');
    expect(x('a')).toBe(0);
    expect(history.canUndo).toBe(false);
    keys('KeyZ', { shiftKey: true });
    expect(x('a')).toBe(200);
    keys('KeyZ');
    keys('KeyY');
    expect(x('a')).toBe(200);
  });

  it('a drag cancelled with Esc leaves nothing to undo', () => {
    pointer('pointerdown', 50, 50);
    pointer('pointermove', 250, 50);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    pointer('pointerup', 250, 50);
    expect(x('a')).toBe(0);
    expect(history.canUndo).toBe(false);
  });

  it('brings back deleted shapes with their connector and selects them', () => {
    tools.setTool('connector');
    drag([50, 50], [350, 50]);
    tools.setTool('select');
    const connector = [...scene.all()].find((e) => e.type === 'connector')!;
    overlay.selection = new Set(['a']);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }));
    expect(scene.has('a')).toBe(false);
    expect(scene.has(connector.id)).toBe(false);
    keys('KeyZ');
    expect(scene.has('a')).toBe(true);
    expect(scene.has(connector.id)).toBe(true);
    expect(overlay.selection).toEqual(new Set(['a', connector.id]));
    keys('KeyZ'); // the connector itself
    expect(scene.has(connector.id)).toBe(false);
  });

  it('works with any keyboard layout (physical key)', () => {
    drag([50, 50], [150, 50]);
    // Russian layout: the Z key produces "я".
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'я', code: 'KeyZ', ctrlKey: true }));
    expect(x('a')).toBe(0);
  });

  it('makes one text editing session one step', () => {
    document.body.insertAdjacentHTML('beforeend', '<div id="layer"></div>');
    scene.update('b', { text: textBlock('one') });
    const renderer = {
      setTextHidden: () => undefined,
      drawnColor: (_type: string, color: number) => color,
      textLayout: () => undefined,
      measurer: { family: 'Inter' },
      onAfterRender: () => () => undefined,
    } as unknown as BoardRenderer;
    const editor = new TextEditor(
      document.getElementById('layer')!,
      scene,
      new Camera(),
      renderer,
      history,
    );
    editor.start('b');
    const input = document.querySelector<HTMLElement>('.ap-text-editor-input')!;
    const range = document.createRange();
    range.selectNodeContents(input);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    const ctrl = (key: string) =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true }));
    ctrl('b');
    ctrl('i');
    editor.stop();
    const runs = () => (scene.get('b') as ShapeElement).text!.runs;
    expect(runs()[0]).toMatchObject({ bold: true, italic: true });
    history.undo();
    expect(runs()).toEqual([{ text: 'one' }]);
    history.redo();
    expect(runs()[0]).toMatchObject({ bold: true, italic: true });
    editor.destroy();
  });
});
