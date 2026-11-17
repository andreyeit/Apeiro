import { beforeEach, describe, expect, it } from 'vitest';
import { Camera, Scene, type ShapeElement } from '@apeiro/core';
import { attachControls } from './controls';
import { ToolState } from '../tools/tool-state';
import { Overlay } from '../overlay/overlay';

const box = (id: string, x: number, y: number, w = 100, h = 100): ShapeElement => ({
  id,
  type: 'rect',
  x,
  y,
  w,
  h,
  rotation: 0,
  z: 0,
  fill: 0xffffffff,
  stroke: 0x000000ff,
  strokeWidth: 2,
  radius: 0,
});

describe('smart guides and grid snapping (Figma-like)', () => {
  let scene: Scene;
  let stage: HTMLElement;
  let overlay: Overlay;

  // Camera at zoom 1, origin at 0,0: screen == world. Grid step 24, guide threshold 6.
  const pointer = (type: string, x: number, y: number, ctrlKey = false, shiftKey = false) =>
    stage.dispatchEvent(
      new PointerEvent(type, {
        clientX: x,
        clientY: y,
        button: 0,
        pointerId: 1,
        bubbles: true,
        ctrlKey,
        shiftKey,
      }),
    );

  beforeEach(() => {
    document.body.innerHTML = '<div id="stage"></div><canvas id="overlay"></canvas>';
    stage = document.getElementById('stage')!;
    stage.setPointerCapture = () => undefined;
    stage.releasePointerCapture = () => undefined;
    stage.hasPointerCapture = () => false;
    scene = new Scene();
    scene.add(box('a', 0, 0));
    scene.add(box('t', 300, 400, 100, 60)); // a target to align with
    const camera = new Camera();
    camera.setViewport(1000, 1000);
    const canvas = document.getElementById('overlay') as HTMLCanvasElement;
    canvas.getContext = (() =>
      new Proxy({}, { get: () => () => undefined, set: () => true })) as never;
    overlay = new Overlay(canvas, scene, camera);
    attachControls(stage, scene, camera, overlay, new ToolState(), undefined, { snapping: true });
  });

  it('aligns to another element within the threshold and shows a guide', () => {
    pointer('pointerdown', 50, 50);
    pointer('pointermove', 353, 150); // a's left edge would be at 303: 3 from t's left (300)
    expect(scene.get('a')).toMatchObject({ x: 300 });
    expect(overlay.guides.some((g) => g.axis === 'x' && g.at === 300)).toBe(true);
    pointer('pointerup', 353, 150);
    expect(overlay.guides).toEqual([]); // guides vanish with the gesture
  });

  it('keeps equal gaps with a row of elements and labels them', () => {
    scene.add(box('p', 300, 0));
    scene.add(box('q', 600, 0)); // gap p→q: 200
    pointer('pointerdown', 50, 50);
    pointer('pointermove', 947, 52); // a at 897,2: next in the row goes at 900
    expect(scene.get('a')).toMatchObject({ x: 900, y: 0 });
    expect(overlay.spacing).toHaveLength(1);
    expect(overlay.spacing[0]).toMatchObject({ axis: 'x', distance: 200 });
    expect(overlay.spacing[0]!.segments).toHaveLength(2);
    pointer('pointerup', 947, 52);
    expect(overlay.spacing).toEqual([]);
  });

  it('moves freely without Shift: no grid', () => {
    pointer('pointerdown', 50, 50);
    pointer('pointermove', 60, 85);
    expect(scene.get('a')).toMatchObject({ x: 10, y: 35 });
    pointer('pointerup', 60, 85);
  });

  it('snaps to the grid with Shift (geometry, not the stroke), along the locked axis', () => {
    pointer('pointerdown', 50, 50, false, true);
    pointer('pointermove', 60, 85, false, true); // mostly down: x locked, y 35 → 24
    expect(scene.get('a')).toMatchObject({ x: 0, y: 24 });
    pointer('pointermove', 50, 105, false, true); // y 55 → 48
    expect(scene.get('a')).toMatchObject({ x: 0, y: 48 });
    pointer('pointerup', 50, 105, false, true);
  });

  it('resizes to the grid with Shift only', () => {
    scene.remove('t');
    overlay.selection = new Set(['a']);
    pointer('pointerdown', 101, 101);
    pointer('pointermove', 140, 101); // right side free at ~140
    expect((scene.get('a') as ShapeElement).w % 24).not.toBe(0);
    pointer('pointerup', 140, 101);
  });

  it('a click does not nudge the element to the grid', () => {
    scene.update('a', { x: 5, y: 7 });
    pointer('pointerdown', 50, 50);
    pointer('pointermove', 51, 51); // within the click slop
    pointer('pointerup', 51, 51);
    expect(scene.get('a')).toMatchObject({ x: 6, y: 8 }); // the raw 1px, no jump to the grid
  });

  it('Ctrl/⌘ during the drag places freely', () => {
    pointer('pointerdown', 50, 50);
    pointer('pointermove', 353, 150, true);
    expect(scene.get('a')).toMatchObject({ x: 303, y: 100 });
    expect(overlay.guides).toEqual([]);
    pointer('pointerup', 353, 150, true);
  });

  it('snaps the dragged side of a resize to another element', () => {
    overlay.selection = new Set(['a']);
    // Bottom-right corner handle of a (frame includes the stroke: 101,101).
    pointer('pointerdown', 101, 101);
    pointer('pointermove', 398, 157); // right side near t's right edge (400)
    const a = scene.get('a') as ShapeElement;
    expect(a.x + a.w).toBeCloseTo(400, 0);
    expect(overlay.guides.some((g) => g.axis === 'x' && Math.abs(g.at - 400) < 1.5)).toBe(true);
    pointer('pointerup', 398, 157);
  });
});
