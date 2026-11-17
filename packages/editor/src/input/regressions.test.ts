import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Camera, Scene, textBlock, type ShapeElement } from '@apeiro/core';
import type { BoardRenderer } from '@apeiro/renderer';
import { attachControls } from './controls';
import { ToolState } from '../tools/tool-state';
import { TextEditor } from '../text-editor/text-editor';
import { importFiles, revokeUnusedObjectUrls } from '../media/import-files';
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

describe('controls: interrupted gestures', () => {
  let scene: Scene;
  let stage: HTMLElement;
  let tools: ToolState;

  const pointer = (type: string, x: number, y: number, pointerId = 1) =>
    stage.dispatchEvent(
      new PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId, bubbles: true }),
    );

  beforeEach(() => {
    document.body.innerHTML = '<div id="stage"></div><canvas id="overlay"></canvas>';
    stage = document.getElementById('stage')!;
    stage.setPointerCapture = () => undefined;
    stage.releasePointerCapture = () => undefined;
    stage.hasPointerCapture = () => false;
    scene = new Scene({ freeze: true });
    scene.add(box('a', 0, 0));
    const camera = new Camera();
    camera.setViewport(1000, 1000);
    const canvas = document.getElementById('overlay') as HTMLCanvasElement;
    canvas.getContext = (() =>
      new Proxy({}, { get: () => () => undefined, set: () => true })) as never;
    tools = new ToolState();
    attachControls(stage, scene, camera, new Overlay(canvas, scene, camera), tools);
  });

  it('pointercancel undoes a drag instead of committing it', () => {
    pointer('pointerdown', 50, 50);
    pointer('pointermove', 250, 250);
    expect((scene.get('a') as ShapeElement).x).toBe(200);
    pointer('pointercancel', 250, 250);
    expect((scene.get('a') as ShapeElement).x).toBe(0);
  });

  it('pointercancel removes a connector being drawn', () => {
    tools.setTool('connector');
    pointer('pointerdown', 50, 50);
    pointer('pointermove', 500, 500);
    expect([...scene.all()].some((e) => e.type === 'connector')).toBe(true);
    pointer('pointercancel', 500, 500);
    expect([...scene.all()].some((e) => e.type === 'connector')).toBe(false);
  });

  it('ignores a second pointer while a gesture is in progress', () => {
    pointer('pointerdown', 50, 50, 1);
    pointer('pointermove', 150, 50, 1);
    pointer('pointerdown', 600, 600, 2);
    pointer('pointermove', 900, 900, 2);
    pointer('pointerup', 900, 900, 2);
    expect((scene.get('a') as ShapeElement).x).toBe(100); // still following pointer 1
    pointer('pointerup', 150, 50, 1);
  });
});

describe('TextEditor: undo and outside changes', () => {
  let scene: Scene;
  let editor: TextEditor;
  let input: HTMLElement;

  const text = () => (scene.get('s') as ShapeElement).text!.runs.map((r) => r.text).join('');
  const key = (k: string, extra: KeyboardEventInit = {}) =>
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: k, ctrlKey: true, bubbles: true, ...extra }),
    );
  const selectAll = () => {
    const range = document.createRange();
    range.selectNodeContents(input);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  };

  beforeEach(() => {
    document.body.innerHTML = '<div id="layer"></div>';
    scene = new Scene({ freeze: true });
    const renderer = {
      setTextHidden: () => undefined,
      drawnColor: (_type: string, color: number) => color,
      textLayout: () => undefined,
      measurer: { family: 'Inter' },
      onAfterRender: () => () => undefined,
    } as unknown as BoardRenderer;
    editor = new TextEditor(document.getElementById('layer')!, scene, new Camera(), renderer);
    scene.add(box('s', 0, 0, { type: 'sticky', w: 200, h: 200, text: textBlock('hello') }));
    editor.start('s');
    input = document.querySelector('.ap-text-editor-input')!;
  });

  it('undoes and redoes formatting with Ctrl+Z / Ctrl+Shift+Z', () => {
    selectAll();
    key('b');
    expect((scene.get('s') as ShapeElement).text!.runs[0]!.bold).toBe(true);
    key('z');
    expect((scene.get('s') as ShapeElement).text!.runs[0]!.bold).toBeUndefined();
    key('z', { shiftKey: true });
    expect((scene.get('s') as ShapeElement).text!.runs[0]!.bold).toBe(true);
  });

  it('shows text changed elsewhere instead of overwriting it on the next edit', () => {
    const el = scene.get('s') as ShapeElement;
    scene.update('s', { text: { ...el.text!, runs: [{ text: 'from another view' }] } });
    expect(input.textContent).toBe('from another view');
    selectAll();
    key('i');
    expect(text()).toBe('from another view');
  });

  it('stops listening to the document after destroy', () => {
    editor.destroy();
    expect(document.querySelector('.ap-text-editor-input')).toBeNull();
    expect(() => document.dispatchEvent(new Event('selectionchange'))).not.toThrow();
  });
});

describe('media import', () => {
  it('skips a file that fails to import and keeps going', async () => {
    const scene = new Scene();
    const bad = new File(['x'], 'bad.png', { type: 'image/png' });
    const good = new File(['y'], 'a.txt', { type: 'text/plain' }); // ignored type, not an error
    const errors: string[] = [];
    vi.stubGlobal('createImageBitmap', () => Promise.reject(new Error('corrupt')));
    const ids = await importFiles([bad, good, bad], { x: 0, y: 0 }, scene, undefined, (f) =>
      errors.push(f.name),
    );
    vi.unstubAllGlobals();
    expect(ids).toEqual([]);
    expect(errors).toEqual(['bad.png', 'bad.png']);
  });

  it('revokes object URLs once no element uses them', () => {
    const scene = new Scene();
    const revoked: string[] = [];
    revokeUnusedObjectUrls(scene, (url) => revoked.push(url));
    const image = (id: string) => box(id, 0, 0, { type: 'image', media: { src: 'blob:one' } });
    scene.add(image('i1'));
    scene.add(image('i2'));
    scene.remove('i1');
    expect(revoked).toEqual([]);
    scene.update('i2', { media: { src: 'blob:two' } });
    expect(revoked).toEqual(['blob:one']);
    scene.clear();
    expect(revoked).toEqual(['blob:one', 'blob:two']);
  });
});
