import { beforeEach, describe, expect, it } from 'vitest';
import { Camera, History, Scene, type ShapeElement } from '@apeiro/core';
import { attachControls } from './controls';
import { ToolState } from '../tools/tool-state';
import { countHandlePoint, radiusHandlePoint } from '../overlay/handles';
import { Overlay } from '../overlay/overlay';

const shape = (patch: Partial<ShapeElement>): ShapeElement => ({
  id: 's',
  type: 'rect',
  x: 100,
  y: 100,
  w: 200,
  h: 200,
  rotation: 0,
  z: 0,
  fill: 0xffffffff,
  stroke: 0,
  strokeWidth: 0,
  radius: 0,
  ...patch,
});

describe('corner handles (Figma-like)', () => {
  let scene: Scene;
  let stage: HTMLElement;
  let history: History;

  // Camera at zoom 1, origin at 0,0: screen == world.
  const pointer = (type: string, x: number, y: number, altKey = false) =>
    stage.dispatchEvent(
      new PointerEvent(type, {
        clientX: x,
        clientY: y,
        button: 0,
        pointerId: 1,
        bubbles: true,
        altKey,
      }),
    );
  const drag = (from: { x: number; y: number }, to: { x: number; y: number }, altKey = false) => {
    pointer('pointerdown', from.x, from.y, altKey);
    pointer('pointermove', to.x, to.y, altKey);
    pointer('pointerup', to.x, to.y, altKey);
  };
  const s = () => scene.get('s') as ShapeElement;

  const setup = (el: ShapeElement) => {
    document.body.innerHTML = '<div id="stage"></div><canvas id="overlay"></canvas>';
    stage = document.getElementById('stage')!;
    stage.setPointerCapture = () => undefined;
    stage.releasePointerCapture = () => undefined;
    stage.hasPointerCapture = () => false;
    scene = new Scene();
    scene.add(el);
    history = new History(scene);
    const camera = new Camera();
    camera.setViewport(1000, 1000);
    const canvas = document.getElementById('overlay') as HTMLCanvasElement;
    canvas.getContext = (() =>
      new Proxy({}, { get: () => () => undefined, set: () => true })) as never;
    const overlay = new Overlay(canvas, scene, camera);
    overlay.selection = new Set(['s']);
    attachControls(stage, scene, camera, overlay, new ToolState(), undefined, { history });
  };

  describe('radius', () => {
    beforeEach(() => setup(shape({})));

    it('the handle at the top-left corner rounds every corner', () => {
      const h = radiusHandlePoint(s(), 1); // top-left
      drag(h, { x: h.x + 20, y: h.y + 20 }); // the handle is the arc center: radius 20
      expect(s().radius).toBe(20);
    });
  });

  describe('polygon corner count', () => {
    beforeEach(() => setup(shape({ type: 'polygon', sides: 5 })));

    it('dragging the count handle around the center adds or removes corners', () => {
      const h = countHandlePoint(s(), 1);
      const center = { x: 200, y: 200 };
      const at = (n: number) => ({
        x: center.x + 80 * Math.sin(Math.PI / n),
        y: center.y - 80 * Math.cos(Math.PI / n),
      });
      pointer('pointerdown', h.x, h.y);
      pointer('pointermove', at(8).x, at(8).y);
      expect(s().sides).toBe(8);
      pointer('pointermove', at(3).x, at(3).y);
      expect(s().sides).toBe(3);
      pointer('pointermove', center.x + 1, center.y - 80); // nearly at the top: the most
      expect(s().sides).toBe(12);
      pointer('pointerup', center.x + 1, center.y - 80);
      history.undo(); // one step
      expect(s().sides).toBe(5);
    });
  });
});
