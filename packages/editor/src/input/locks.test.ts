import { Camera, Scene, type ShapeElement } from '@apeiro/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachControls } from './controls';
import { ToolState } from '../tools/tool-state';
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

describe('controls: elements locked by another participant', () => {
  let scene: Scene;
  let stage: HTMLElement;
  let overlay: Overlay;
  let tools: ToolState;
  let detach: () => void;
  const locked = new Set<string>();

  // Camera at zoom 1, origin at 0,0: screen == world.
  const pointer = (type: string, x: number, y: number) =>
    stage.dispatchEvent(
      new PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: 1, bubbles: true }),
    );
  const drag = (...pts: Array<[number, number]>) => {
    pointer('pointerdown', ...pts[0]!);
    for (const p of pts.slice(1)) pointer('pointermove', ...p);
    pointer('pointerup', ...pts[pts.length - 1]!);
  };
  const key = (init: KeyboardEventInit) => window.dispatchEvent(new KeyboardEvent('keydown', init));

  beforeEach(() => {
    locked.clear();
    document.body.innerHTML = '<div id="stage"></div><canvas id="overlay"></canvas>';
    stage = document.getElementById('stage')!;
    stage.setPointerCapture = () => undefined;
    stage.releasePointerCapture = () => undefined;
    stage.hasPointerCapture = () => false;
    scene = new Scene();
    scene.add(box('mine', 0, 0));
    scene.add(box('theirs', 300, 0));
    const camera = new Camera();
    camera.setViewport(1000, 1000);
    const canvas = document.getElementById('overlay') as HTMLCanvasElement;
    canvas.getContext = (() =>
      new Proxy({}, { get: () => () => undefined, set: () => true })) as never;
    overlay = new Overlay(canvas, scene, camera);
    overlay.isLocked = (id) => locked.has(id);
    tools = new ToolState();
    detach = attachControls(stage, scene, camera, overlay, tools, undefined, {
      isLocked: (id) => locked.has(id),
    });
    locked.add('theirs');
  });
  afterEach(() => detach());

  it('a click does not select it and a drag does not move it', () => {
    drag([350, 50], [450, 150]);
    expect(overlay.selection.has('theirs')).toBe(false);
    expect(scene.get('theirs')).toMatchObject({ x: 300, y: 0 });
  });

  it('a marquee and Ctrl+A skip it, so Delete leaves it alone', () => {
    drag([-50, -50], [500, 200]);
    expect([...overlay.selection]).toEqual(['mine']);
    key({ key: 'a', code: 'KeyA', ctrlKey: true });
    expect([...overlay.selection]).toEqual(['mine']);
    key({ key: 'Delete', code: 'Delete' });
    expect(scene.has('theirs')).toBe(true);
    expect(scene.has('mine')).toBe(false);
  });

  it('it leaves the selection when it gets locked, and can be selected once released', () => {
    locked.delete('theirs');
    drag([350, 50], [350, 50]);
    expect(overlay.selection.has('theirs')).toBe(true);
    locked.add('theirs');
    expect(overlay.releaseLocked()).toBe(true);
    expect(overlay.selection.size).toBe(0);
    locked.delete('theirs');
    drag([350, 50], [350, 50]);
    expect(overlay.selection.has('theirs')).toBe(true);
  });

  it('the eraser does not erase a locked pen stroke', () => {
    scene.add(
      box('ink', 600, 0, { type: 'ink', strokeWidth: 4, stroke: 0xff, points: [0, 0.5, 1, 0.5] }),
    );
    locked.add('ink');
    tools.setTool('eraser');
    drag([600, 50], [700, 50]);
    expect(scene.has('ink')).toBe(true);
  });
});

describe('Scene edit guard', () => {
  it('refuses local updates and removals of guarded elements, but not remote ones', () => {
    const scene = new Scene();
    scene.add(box('a', 0, 0));
    scene.setEditGuard((id) => id !== 'a');
    expect(scene.update('a', { x: 5 })).toBe(false);
    expect(scene.remove('a')).toBe(false);
    scene.transact(() => scene.update('a', { x: 5 }), 'history');
    expect(scene.get('a')).toMatchObject({ x: 0 });
    scene.transact(() => scene.update('a', { x: 7 }), 'yjs');
    expect(scene.get('a')).toMatchObject({ x: 7 });
    scene.setEditGuard(null);
    expect(scene.update('a', { x: 9 })).toBe(true);
  });
});
