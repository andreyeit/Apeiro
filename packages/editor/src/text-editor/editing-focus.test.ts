import { Camera, Scene, textBlock, type ShapeElement } from '@apeiro/core';
import type { BoardRenderer } from '@apeiro/renderer';
import { describe, expect, it, vi } from 'vitest';
import { TextEditor } from './text-editor';
import { Overlay } from '../overlay/overlay';

const block: ShapeElement = {
  id: 'a',
  type: 'rect',
  x: 100,
  y: 100,
  w: 200,
  h: 100,
  rotation: 0,
  z: 0,
  fill: 0xffffffff,
  stroke: 0x18181bff,
  strokeWidth: 1.5,
  radius: 8,
  text: textBlock('Hi'),
};

/** An overlay whose 2D context records the calls made on it. */
function recordingOverlay(scene: Scene) {
  document.body.innerHTML = '<canvas id="overlay"></canvas>';
  const canvas = document.getElementById('overlay') as HTMLCanvasElement;
  const calls: string[] = [];
  canvas.getContext = (() =>
    new Proxy(
      {},
      {
        get: (_, name) =>
          typeof name === 'string' ? (..._args: unknown[]) => void calls.push(name) : undefined,
        set: () => true,
      },
    )) as never;
  const camera = new Camera();
  camera.setViewport(1000, 1000);
  return { overlay: new Overlay(canvas, scene, camera), calls };
}

describe('editing text: one focus mark, no handles', () => {
  it('a selected shape has a frame with handles; while its text is edited only its outline', () => {
    const scene = new Scene();
    scene.add(block);
    const { overlay, calls } = recordingOverlay(scene);
    overlay.selection = new Set(['a']);
    overlay.anchorsFor = 'a';
    overlay.draw();
    const handles = calls.filter((c) => c === 'roundRect').length;
    const dots = calls.filter((c) => c === 'arc').length;
    expect(handles).toBeGreaterThanOrEqual(4); // corners (and the outline of the rounded rect)
    expect(dots).toBeGreaterThan(0); // connection dots and the radius handle
    calls.length = 0;
    overlay.editing = 'a';
    overlay.draw();
    expect(calls.filter((c) => c === 'roundRect').length).toBe(1); // the outline only
    expect(calls.filter((c) => c === 'arc').length).toBe(0);
    expect(calls.filter((c) => c === 'strokeRect').length).toBe(0); // no transform frame
  });

  it('the text editor reports the start and the end of editing', () => {
    document.body.innerHTML = '<div id="layer"></div>';
    const scene = new Scene();
    scene.add(block);
    const renderer = {
      setTextHidden: vi.fn(),
      drawnColor: (_type: string, color: number) => color,
      textLayout: () => undefined,
      measurer: { family: 'Inter' },
      onAfterRender: () => () => undefined,
    } as unknown as BoardRenderer;
    const editor = new TextEditor(document.getElementById('layer')!, scene, new Camera(), renderer);
    const started = vi.fn();
    const stopped = vi.fn();
    editor.onStart = started;
    editor.onStop = stopped;
    editor.start('a');
    expect(started).toHaveBeenCalledWith('a');
    editor.stop();
    expect(stopped).toHaveBeenCalledWith('a');
    editor.destroy();
  });
});
