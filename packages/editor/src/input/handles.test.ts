import { boxFrame, Camera, Scene, type ShapeElement } from '@apeiro/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachControls } from './controls';
import { ToolState } from '../tools/tool-state';
import { selectionEdgeFrame, selectionFrame, transformHandleAt } from '../overlay/handles';
import { Overlay } from '../overlay/overlay';

/** Just outside a corner, diagonally (screen px): the rotation zone. */
const OUT = 12;

const box: ShapeElement = {
  id: 'a',
  type: 'rect',
  x: 100,
  y: 100,
  w: 200,
  h: 100,
  rotation: 0,
  z: 0,
  fill: 0xffffffff,
  stroke: 0,
  strokeWidth: 0,
  radius: 0,
};

describe('transform handles', () => {
  const frame = boxFrame({ minX: 100, minY: 100, maxX: 300, maxY: 200 });

  it('just outside a corner rotates', () => {
    expect(transformHandleAt(frame, { x: 300 + OUT, y: 100 - OUT }, 1)).toEqual({
      kind: 'rotate',
      corner: 'ne',
    });
    // At zoom 2 the zone is half as far out in world units (constant on screen).
    expect(transformHandleAt(frame, { x: 300 + OUT / 2, y: 100 - OUT / 2 }, 2)?.kind).toBe(
      'rotate',
    );
  });

  it('corners and the middle of the sides resize', () => {
    expect(transformHandleAt(frame, { x: 300, y: 200 }, 1)).toEqual({
      kind: 'resize',
      handle: 'se',
    });
    expect(transformHandleAt(frame, { x: 200, y: 100 }, 1)).toEqual({
      kind: 'resize',
      handle: 'n',
    });
    expect(transformHandleAt(frame, { x: 100, y: 150 }, 1)).toEqual({
      kind: 'resize',
      handle: 'w',
    });
  });
});

describe('size and angle badge', () => {
  let scene: Scene;
  let stage: HTMLElement;
  let overlay: Overlay;
  let detach: () => void;
  const pointer = (type: string, x: number, y: number) =>
    stage.dispatchEvent(
      new PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: 1, bubbles: true }),
    );

  beforeEach(() => {
    document.body.innerHTML = '<div id="stage"></div><canvas id="overlay"></canvas>';
    stage = document.getElementById('stage')!;
    stage.setPointerCapture = () => undefined;
    stage.releasePointerCapture = () => undefined;
    stage.hasPointerCapture = () => false;
    scene = new Scene();
    scene.add(box);
    const camera = new Camera();
    camera.setViewport(1000, 1000);
    const canvas = document.getElementById('overlay') as HTMLCanvasElement;
    canvas.getContext = (() =>
      new Proxy({}, { get: () => () => undefined, set: () => true })) as never;
    overlay = new Overlay(canvas, scene, camera);
    overlay.selection = new Set(['a']);
    detach = attachControls(stage, scene, camera, overlay, new ToolState());
  });
  afterEach(() => detach());

  it('shows the size while resizing and clears it on release', () => {
    pointer('pointerdown', 300, 200);
    pointer('pointermove', 350, 240);
    expect(overlay.badge).toBe('250 × 140');
    pointer('pointerup', 350, 240);
    expect(overlay.badge).toBeNull();
  });

  it('shows the angle while rotating from just outside a corner', () => {
    pointer('pointerdown', 300 + OUT, 100 - OUT);
    // A quarter turn around the center (200, 150).
    const start = Math.atan2(100 - OUT - 150, 300 + OUT - 200);
    const r = 150;
    pointer(
      'pointermove',
      200 + r * Math.cos(start + Math.PI / 2),
      150 + r * Math.sin(start + Math.PI / 2),
    );
    expect(overlay.badge).toBe('90°');
    expect((scene.get('a') as ShapeElement).rotation).toBeCloseTo(Math.PI / 2);
    pointer('pointerup', 0, 0);
    expect(overlay.badge).toBeNull();
  });
});

describe('frame on the outer edge', () => {
  it("a lone shape's frame takes in its border; several elements' bounds already do", () => {
    const scene = new Scene();
    scene.add({ ...box, strokeWidth: 10 });
    const one = selectionEdgeFrame(scene, new Set(['a']))!;
    expect([one.w, one.h]).toEqual([210, 110]);
    expect(selectionFrame(scene, new Set(['a']))!.w).toBe(200); // the geometry, for resizing
    scene.add({ ...box, id: 'b', x: 400, strokeWidth: 10 });
    const two = selectionEdgeFrame(scene, new Set(['a', 'b']))!;
    expect(two.w).toBe(selectionFrame(scene, new Set(['a', 'b']))!.w);
  });

  it('the corner handle on the outer edge of a thick border resizes the geometry', () => {
    document.body.innerHTML = '<div id="stage"></div><canvas id="overlay"></canvas>';
    const stage = document.getElementById('stage')!;
    stage.setPointerCapture = () => undefined;
    stage.releasePointerCapture = () => undefined;
    stage.hasPointerCapture = () => false;
    const scene = new Scene();
    scene.add({ ...box, strokeWidth: 30 });
    const camera = new Camera();
    camera.setViewport(1000, 1000);
    const canvas = document.getElementById('overlay') as HTMLCanvasElement;
    canvas.getContext = (() =>
      new Proxy({}, { get: () => () => undefined, set: () => true })) as never;
    const overlay = new Overlay(canvas, scene, camera);
    overlay.selection = new Set(['a']);
    const detach = attachControls(stage, scene, camera, overlay, new ToolState());
    const pointer = (type: string, x: number, y: number) =>
      stage.dispatchEvent(
        new PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: 1, bubbles: true }),
      );
    // The bottom-right corner is drawn at (315, 215), 15 px out from the box corner.
    pointer('pointerdown', 315, 215);
    pointer('pointermove', 345, 235);
    pointer('pointerup', 345, 235);
    expect(scene.get('a')).toMatchObject({ x: 100, y: 100, w: 230, h: 120 });
    detach();
  });
});
