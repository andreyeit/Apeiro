import { beforeEach, describe, expect, it } from 'vitest';
import { Camera, Scene, textBlock, type FontMeasurer, type ShapeElement } from '@apeiro/core';
import { attachControls } from './controls';
import { ToolState } from '../tools/tool-state';
import { Overlay } from '../overlay/overlay';

/** Monospace: every char is 0.5em. */
const mono: FontMeasurer & { family: string } = {
  family: 'Inter',
  advance: () => 0.5,
  ascent: 0.8,
  descent: 0.2,
};

describe('double click on a text box handle hugs the text (Figma)', () => {
  let scene: Scene;
  let stage: HTMLElement;
  let overlay: Overlay;

  const dblclickAt = (x: number, y: number) => {
    for (let i = 0; i < 2; i++) {
      for (const type of ['pointerdown', 'pointerup'])
        stage.dispatchEvent(
          new PointerEvent(type, {
            clientX: x,
            clientY: y,
            button: 0,
            pointerId: 1,
            bubbles: true,
          }),
        );
    }
    stage.dispatchEvent(new MouseEvent('dblclick', { clientX: x, clientY: y, bubbles: true }));
  };
  const text = () => scene.get('t') as ShapeElement;

  beforeEach(() => {
    document.body.innerHTML = '<div id="stage"></div><canvas id="overlay"></canvas>';
    stage = document.getElementById('stage')!;
    stage.setPointerCapture = () => undefined;
    stage.releasePointerCapture = () => undefined;
    stage.hasPointerCapture = () => false;
    scene = new Scene();
    // A fixed 400×200 box around a short word.
    scene.add({
      id: 't',
      type: 'text',
      x: 0,
      y: 0,
      w: 400,
      h: 200,
      rotation: 0,
      z: 0,
      fill: 0,
      stroke: 0,
      strokeWidth: 0,
      radius: 0,
      text: {
        ...textBlock('hello', { fontSize: 10, align: 'left' }),
        verticalAlign: 'top',
        sizing: 'fixed',
      },
    });
    const camera = new Camera();
    camera.setViewport(1000, 1000);
    const canvas = document.getElementById('overlay') as HTMLCanvasElement;
    canvas.getContext = (() =>
      new Proxy({}, { get: () => () => undefined, set: () => true })) as never;
    overlay = new Overlay(canvas, scene, camera);
    overlay.selection = new Set(['t']);
    attachControls(stage, scene, camera, overlay, new ToolState(), undefined, { measurer: mono });
  });

  it('a corner fits width and height (auto width), keeping the top-left corner', () => {
    dblclickAt(400, 200);
    const t = text();
    expect(t.text!.sizing).toBe('auto-width');
    expect(t.w).toBeCloseTo(25); // 5 chars × 5
    expect(t.h).toBeLessThan(20);
    expect(t).toMatchObject({ x: 0, y: 0 });
  });

  it('a left or right side does the same', () => {
    dblclickAt(400, 100);
    expect(text().text!.sizing).toBe('auto-width');
    expect(text().w).toBeCloseTo(25);
  });

  it('the top or bottom side keeps the width and fits the height (auto height)', () => {
    dblclickAt(200, 200);
    const t = text();
    expect(t.text!.sizing).toBe('auto-height');
    expect(t.w).toBe(400);
    expect(t.h).toBeLessThan(20);
  });

  it('a double click inside the box is still for editing, not resizing', () => {
    dblclickAt(200, 100);
    expect(text()).toMatchObject({ w: 400, h: 200 });
    expect(text().text!.sizing).toBe('fixed');
  });
});
