import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Camera, Scene, type ShapeElement } from '@apeiro/core';
import { attachControls, type ControlsHooks } from './controls';
import { ToolState } from '../tools/tool-state';
import { Overlay } from '../overlay/overlay';

const box = (id: string, x: number, y: number): ShapeElement => ({
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
});

describe('controls: toolbar tools', () => {
  let scene: Scene;
  let stage: HTMLElement;
  let overlay: Overlay;
  let tools: ToolState;
  let camera: Camera;
  let hooks: Required<Pick<ControlsHooks, 'place' | 'addComment' | 'pickImage' | 'zoom'>>;
  let detach: () => void;

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
  const inks = () => [...scene.all()].filter((e) => e.type === 'ink') as ShapeElement[];

  beforeEach(() => {
    document.body.innerHTML = '<div id="stage"></div><canvas id="overlay"></canvas>';
    stage = document.getElementById('stage')!;
    stage.setPointerCapture = () => undefined;
    stage.releasePointerCapture = () => undefined;
    stage.hasPointerCapture = () => false;
    scene = new Scene();
    scene.add(box('a', 0, 0));
    camera = new Camera();
    camera.setViewport(1000, 1000);
    const canvas = document.getElementById('overlay') as HTMLCanvasElement;
    canvas.getContext = (() =>
      new Proxy({}, { get: () => () => undefined, set: () => true })) as never;
    overlay = new Overlay(canvas, scene, camera);
    tools = new ToolState();
    hooks = { place: vi.fn(), addComment: vi.fn(), pickImage: vi.fn(), zoom: vi.fn() };
    detach = attachControls(stage, scene, camera, overlay, tools, undefined, hooks);
  });
  afterEach(() => detach());

  it('pen draws a stroke through the pointer path and stays the active tool', () => {
    tools.setTool('pen');
    drag([200, 200], [250, 220], [300, 200], [350, 260]);
    const [ink] = inks();
    expect(ink).toBeDefined();
    expect(ink!.stroke).toBe(tools.pen.stroke);
    expect(ink!.strokeWidth).toBe(tools.pen.strokeWidth);
    expect(ink!.x).toBeCloseTo(200);
    expect(ink!.y).toBeCloseTo(200);
    expect(ink!.w).toBeCloseTo(150);
    expect(ink!.h).toBeCloseTo(60);
    expect(ink!.points!.length).toBe(8); // 4 points, none redundant
    expect(tools.tool).toBe('pen');
    expect(overlay.selection.size).toBe(0); // drawing doesn't select
    // Hit near the line, not anywhere in its box.
    expect(scene.hitTest({ x: 300, y: 201 }, 1)?.id).toBe(ink!.id);
    expect(scene.hitTest({ x: 300, y: 250 }, 1)).toBeFalsy();
  });

  it('pen simplifies straight runs on release; a click leaves a dot', () => {
    tools.setTool('pen');
    drag([100, 300], [110, 300], [120, 300], [130, 300], [140, 300]);
    expect(inks()[0]!.points!.length).toBe(4); // just the two ends
    drag([500, 500], [500, 500]);
    const [u, v] = inks()[1]!.points!;
    expect(u).toBeCloseTo(0.5);
    expect(v).toBeCloseTo(0.5);
  });

  it('Esc while drawing removes the stroke', () => {
    tools.setTool('pen');
    pointer('pointerdown', 200, 200);
    pointer('pointermove', 260, 260);
    expect(inks()).toHaveLength(1);
    key({ key: 'Escape' });
    expect(inks()).toHaveLength(0);
    pointer('pointerup', 260, 260);
  });

  it('eraser erases only what it passes over: a crossed stroke falls in two', () => {
    tools.setTool('pen');
    drag([200, 400], [400, 400]);
    drag([200, 600], [400, 600]);
    tools.setTool('eraser');
    drag([300, 380], [300, 420], [50, 50]); // across the first stroke, then over the rect
    const first = inks()
      .filter((e) => Math.abs(e.y + e.h / 2 - 400) < 1)
      .sort((a, b) => a.x - b.x);
    expect(first).toHaveLength(2);
    // The eraser (8) plus half the 4-wide line: the gap ends at 310. Its way on to the
    // rect crosses the stroke again near x 286, so the left piece ends before that.
    expect(first[0]!.x).toBeCloseTo(200);
    expect(first[0]!.x + first[0]!.w).toBeLessThan(290);
    expect(first[0]!.x + first[0]!.w).toBeGreaterThan(260);
    expect(Math.abs(first[1]!.x - 310)).toBeLessThan(1.5); // the eraser walks in 8px steps
    expect(first[1]!.x + first[1]!.w).toBeCloseTo(400);
    // The second stroke and the rect are untouched.
    expect(inks().filter((e) => Math.abs(e.y + e.h / 2 - 600) < 1)).toHaveLength(1);
    expect(scene.get('a')).toBeDefined();
    expect(tools.tool).toBe('eraser');
  });

  it('eraser removes a stroke it covers completely', () => {
    tools.setTool('pen');
    drag([300, 400], [306, 400]);
    tools.setTool('eraser');
    drag([303, 380], [303, 420]);
    expect(inks()).toHaveLength(0);
  });

  it('hand pans the board instead of selecting', () => {
    tools.setTool('hand');
    drag([50, 50], [150, 120]);
    expect(camera.x).toBeCloseTo(-100);
    expect(camera.y).toBeCloseTo(-70);
    expect(overlay.selection.size).toBe(0);
    expect((scene.get('a') as ShapeElement).x).toBe(0);
  });

  it('sticky and shape tools: a click places at the point, a drag passes the box', () => {
    tools.setTool('sticky');
    drag([500, 500], [501, 501]);
    expect(hooks.place).toHaveBeenLastCalledWith('sticky', { x: 500, y: 500 }, null);
    expect(tools.tool).toBe('select'); // one element per click
    tools.setTool('ellipse');
    drag([600, 600], [700, 650], [800, 700]);
    expect(hooks.place).toHaveBeenLastCalledWith(
      'ellipse',
      { x: 600, y: 600 },
      { minX: 600, minY: 600, maxX: 800, maxY: 700 },
    );
  });

  it('comment tool pins a thread where clicked', () => {
    tools.setTool('comment');
    drag([420, 240], [420, 240]);
    expect(hooks.addComment).toHaveBeenCalledWith({ x: 420, y: 240 });
    expect(tools.tool).toBe('select');
  });

  it('switches tools by the design shortcuts, by physical key on any layout', () => {
    const cases: Array<[KeyboardEventInit, string]> = [
      [{ code: 'KeyH', key: 'р' }, 'hand'],
      [{ code: 'KeyS', key: 's' }, 'sticky'],
      [{ code: 'KeyR', key: 'к' }, 'rect'],
      [{ code: 'KeyO', key: 'o' }, 'ellipse'],
      [{ code: 'KeyT', key: 't' }, 'text'],
      [{ code: 'KeyC', key: 'с' }, 'comment'],
      [{ code: 'KeyP', key: 'P', shiftKey: true }, 'pen'],
      [{ code: 'KeyE', key: 'E', shiftKey: true }, 'eraser'],
      [{ code: 'KeyV', key: 'м' }, 'select'],
    ];
    for (const [init, tool] of cases) {
      key(init);
      expect(tools.tool, JSON.stringify(init)).toBe(tool);
    }
    // Ctrl+C is copy, not the comment tool.
    key({ code: 'KeyC', key: 'c', ctrlKey: true });
    expect(tools.tool).toBe('select');
  });

  it('zoom and image shortcuts', () => {
    key({ code: 'Digit0', key: ')', shiftKey: true });
    key({ code: 'Digit1', key: '!', shiftKey: true });
    key({ code: 'Digit2', key: '@', shiftKey: true });
    key({ code: 'Equal', key: '=', ctrlKey: true });
    key({ code: 'Minus', key: '-', ctrlKey: true });
    expect(vi.mocked(hooks.zoom).mock.calls.map((c) => c[0])).toEqual([
      'reset',
      'fit',
      'selection',
      'in',
      'out',
    ]);
    key({ code: 'KeyK', key: 'K', ctrlKey: true, shiftKey: true });
    expect(hooks.pickImage).toHaveBeenCalledOnce();
  });

  it('pen strokes are not connection targets', () => {
    tools.setTool('pen');
    drag([300, 300], [400, 300]);
    tools.setTool('connector');
    drag([350, 300], [600, 600]);
    const c = [...scene.all()].find((e) => e.type === 'connector');
    expect(c && c.type === 'connector' && c.start.kind).toBe('point');
  });
});
