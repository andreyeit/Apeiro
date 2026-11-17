import { beforeEach, describe, expect, it } from 'vitest';
import { Camera, History, Scene, type ShapeElement } from '@apeiro/core';
import { attachControls, cropControls } from './controls';
import { ToolState } from '../tools/tool-state';
import { replaceImage } from '../media/import-files';
import { Overlay } from '../overlay/overlay';

// A 400×200 picture shown in a 100×100 box (fill: the middle half of it).
const image = (): ShapeElement => ({
  id: 'img',
  type: 'image',
  x: 100,
  y: 100,
  w: 100,
  h: 100,
  rotation: 0,
  z: 0,
  fill: 0,
  stroke: 0,
  strokeWidth: 0,
  radius: 0,
  media: { src: 'blob:pic', naturalWidth: 400, naturalHeight: 200 },
});

describe('image crop mode (Figma-like)', () => {
  let scene: Scene;
  let stage: HTMLElement;
  let overlay: Overlay;
  let history: History;
  const crop = cropControls();

  // Camera at zoom 1, origin at 0,0: screen == world.
  const pointer = (type: string, x: number, y: number) =>
    stage.dispatchEvent(
      new PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: 1, bubbles: true }),
    );
  const drag = (from: [number, number], to: [number, number]) => {
    pointer('pointerdown', ...from);
    pointer('pointermove', ...to);
    pointer('pointerup', ...to);
  };
  const img = () => scene.get('img') as ShapeElement;
  const key = (k: string) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k }));

  beforeEach(() => {
    document.body.innerHTML = '<div id="stage"></div><canvas id="overlay"></canvas>';
    stage = document.getElementById('stage')!;
    stage.setPointerCapture = () => undefined;
    stage.releasePointerCapture = () => undefined;
    stage.hasPointerCapture = () => false;
    scene = new Scene();
    scene.add(image());
    history = new History(scene);
    const camera = new Camera();
    camera.setViewport(1000, 1000);
    const canvas = document.getElementById('overlay') as HTMLCanvasElement;
    canvas.getContext = (() =>
      new Proxy({}, { get: () => () => undefined, set: () => true })) as never;
    overlay = new Overlay(canvas, scene, camera);
    attachControls(stage, scene, camera, overlay, new ToolState(), undefined, { crop, history });
  });

  it('double click enters crop mode showing the same part; Enter leaves it', () => {
    stage.dispatchEvent(new MouseEvent('dblclick', { clientX: 150, clientY: 150, bubbles: true }));
    expect(overlay.cropping).toBe('img');
    expect(img()).toMatchObject({ imageFit: 'crop', crop: { x: 0.25, y: 0, w: 0.5, h: 1 } });
    key('Enter');
    expect(overlay.cropping).toBeNull();
    expect(overlay.selection).toEqual(new Set(['img']));
  });

  it('dragging a side of the frame shows more of the image, which stays in place', () => {
    crop.start('img');
    drag([200, 150], [230, 150]); // right side +30
    expect(img()).toMatchObject({ x: 100, w: 130, h: 100 });
    expect(img().crop!.x).toBeCloseTo(0.25);
    expect(img().crop!.w).toBeCloseTo(0.65);
  });

  it('the frame stops at the image edge', () => {
    crop.start('img');
    drag([100, 150], [-400, 150]); // the picture starts 50 left of the box
    expect(img()).toMatchObject({ x: 50, w: 150 });
  });

  it('dragging inside moves the image under the frame', () => {
    crop.start('img');
    drag([150, 150], [170, 150]);
    expect(img()).toMatchObject({ x: 100, w: 100 }); // the frame stays
    expect(img().crop!.x).toBeCloseTo(0.15);
  });

  it('dragging a corner of the image scales it inside the fixed frame', () => {
    crop.start('img');
    // The picture spans x 50..250, y 100..200; pull its bottom-right corner out ×1.5.
    drag([250, 200], [350, 200]);
    expect(img()).toMatchObject({ x: 100, y: 100, w: 100, h: 100 }); // the frame stays
    expect(img().crop!.w).toBeCloseTo(1 / 3); // 100 of a 300 wide picture
    expect(img().crop!.h).toBeCloseTo(2 / 3);
    expect(img().crop!.x).toBeCloseTo(50 / 300); // the top-left corner stayed at x 50
  });

  it('a press outside ends crop mode; each crop drag is one undo step', () => {
    crop.start('img');
    drag([200, 150], [230, 150]);
    pointer('pointerdown', 600, 600);
    pointer('pointerup', 600, 600);
    expect(overlay.cropping).toBeNull();
    history.undo();
    expect(img()).toMatchObject({ w: 100, imageFit: 'crop' });
    history.undo(); // entering crop mode
    expect(img().imageFit).toBeUndefined();
  });

  it('Esc cancels a crop drag, then leaves crop mode', () => {
    crop.start('img');
    pointer('pointerdown', 200, 150);
    pointer('pointermove', 260, 150);
    key('Escape');
    pointer('pointerup', 260, 150);
    expect(img()).toMatchObject({ w: 100 });
    expect(overlay.cropping).toBe('img');
    key('Escape');
    expect(overlay.cropping).toBeNull();
  });
});

describe('replace image', () => {
  it('in fit mode the frame refits around the new picture', async () => {
    const scene = new Scene();
    scene.add({ ...image(), y: 125, h: 50, imageFit: 'fit' }); // hugging the 2:1 picture
    globalThis.createImageBitmap = (async () => ({ width: 100, height: 200, close() {} })) as never;
    await replaceImage(scene, 'img', new Blob(['x']), 'tall.png', async () => 'blob:tall');
    // A 1:2 picture inside the old 100×50 frame: 25×50, centered.
    expect(scene.get('img')).toMatchObject({ x: 137.5, y: 125, w: 25, h: 50, imageFit: 'fit' });
  });

  it('keeps the box, fills it with the new picture, drops the old crop', async () => {
    const scene = new Scene();
    scene.add({ ...image(), imageFit: 'crop', crop: { x: 0.1, y: 0, w: 0.5, h: 1 } });
    const bitmap = { width: 300, height: 300, close: () => undefined };
    globalThis.createImageBitmap = (async () => bitmap) as never;
    const ok = await replaceImage(
      scene,
      'img',
      new Blob(['x'], { type: 'image/png' }),
      'new.png',
      async () => 'blob:new',
    );
    expect(ok).toBe(true);
    expect(scene.get('img')).toMatchObject({
      x: 100,
      y: 100,
      w: 100,
      h: 100,
      imageFit: 'fill',
      crop: undefined,
      media: { src: 'blob:new', name: 'new.png', naturalWidth: 300, naturalHeight: 300 },
    });
  });
});
