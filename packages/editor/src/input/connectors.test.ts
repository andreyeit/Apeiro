import { beforeEach, describe, expect, it } from 'vitest';
import { Camera, Scene, type ConnectorElement, type ShapeElement } from '@apeiro/core';
import { attachControls, reverseSelected } from './controls';
import { ToolState } from '../tools/tool-state';
import { anchorDot } from '../overlay/handles';
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

describe('controls: connectors', () => {
  let scene: Scene;
  let stage: HTMLElement;
  let overlay: Overlay;
  let tools: ToolState;

  // Camera at zoom 1, origin at 0,0: screen == world.
  const pointer = (type: string, x: number, y: number) =>
    stage.dispatchEvent(
      new PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: 1, bubbles: true }),
    );
  const drag = (from: [number, number], to: [number, number]) => {
    pointer('pointerdown', ...from);
    pointer('pointermove', (from[0] + to[0]) / 2, (from[1] + to[1]) / 2);
    pointer('pointermove', ...to);
    pointer('pointerup', ...to);
  };
  const connectors = () =>
    [...scene.all()].filter((e): e is ConnectorElement => e.type === 'connector');

  beforeEach(() => {
    document.body.innerHTML = '<div id="stage"></div><canvas id="overlay"></canvas>';
    stage = document.getElementById('stage')!;
    stage.setPointerCapture = () => undefined;
    stage.releasePointerCapture = () => undefined;
    stage.hasPointerCapture = () => false;
    scene = new Scene();
    scene.add(box('a', 0, 0));
    scene.add(box('b', 300, 0));
    const camera = new Camera();
    camera.setViewport(1000, 1000);
    const canvas = document.getElementById('overlay') as HTMLCanvasElement;
    canvas.getContext = (() =>
      new Proxy({}, { get: () => () => undefined, set: () => true })) as never;
    overlay = new Overlay(canvas, scene, camera);
    tools = new ToolState();
    attachControls(stage, scene, camera, overlay, tools);
  });

  it('drags a new connector from a connection dot to another shape, snapping to its side', () => {
    pointer('pointermove', 50, 50); // hover shape a: dots appear
    expect(overlay.anchorsFor).toBe('a');
    const dot = anchorDot(scene.get('a') as ShapeElement, { x: 1, y: 0.5 }, 1);
    drag([dot.x, dot.y], [302, 52]); // drop near the left-middle of b
    const [c] = connectors();
    expect(c).toBeDefined();
    expect(c!.start).toEqual({ kind: 'element', id: 'a', anchor: { x: 1, y: 0.5 } });
    expect(c!.end).toEqual({ kind: 'element', id: 'b', anchor: { x: 0, y: 0.5 } });
    expect(overlay.selection).toEqual(new Set([c!.id]));
    expect(overlay.target).toBeNull();
  });

  it('shows no connection dots on a selected shape, and its dot spot grabs nothing', () => {
    overlay.selection = new Set(['a']);
    pointer('pointermove', 50, 50); // over the selected shape
    expect(overlay.anchorsFor).toBeNull();
    pointer('pointermove', 350, 50); // the other one still offers them
    expect(overlay.anchorsFor).toBe('b');
    overlay.anchorsFor = 'a'; // even if they were left on
    const dot = anchorDot(scene.get('a') as ShapeElement, { x: 1, y: 0.5 }, 1);
    drag([dot.x, dot.y], [302, 52]);
    expect(connectors()).toHaveLength(0);
  });

  it('leaves a free end on empty space; ends inside shapes are pinned where they meet the outline', () => {
    tools.setTool('connector');
    drag([50, 50], [600, 600]);
    drag([50, 50], [360, 50]);
    const [free, pinned] = connectors();
    expect(free!.end).toEqual({ kind: 'point', x: 600, y: 600 });
    // Started inside a: pinned on the side facing the drop point (bottom-right corner area).
    expect(free!.start.kind === 'element' && free!.start.anchor).toBeTruthy();
    // Straight across: right-middle of a to left-middle of b.
    expect(pinned!.start).toEqual({ kind: 'element', id: 'a', anchor: { x: 1, y: 0.5 } });
    expect(pinned!.end).toEqual({ kind: 'element', id: 'b', anchor: { x: 0, y: 0.5 } });
  });

  it('keeps pinned ends in place on the shape when shapes move (no sliding along the outline)', () => {
    tools.setTool('connector');
    drag([50, 50], [360, 50]);
    const id = connectors()[0]!.id;
    const before = scene.connectorGeometry(id)!.points;
    const endBefore = before[before.length - 1]!;
    scene.update('b', { y: 200 }); // move b down: a floating end would slide to b's top-left
    const after = scene.connectorGeometry(id)!.points;
    const endAfter = after[after.length - 1]!;
    expect(endAfter.x).toBeCloseTo(endBefore.x);
    expect(endAfter.y).toBeCloseTo(endBefore.y + 200);
    expect(after[0]).toEqual(before[0]);
  });

  it('does not create a connector on a click without dragging', () => {
    tools.setTool('connector');
    pointer('pointerdown', 50, 50);
    pointer('pointerup', 51, 50);
    expect(connectors()).toHaveLength(0);
  });

  it('re-attaches an end by dragging its handle', () => {
    scene.add(box('d', 0, 300));
    tools.setTool('connector');
    drag([50, 50], [350, 50]);
    tools.setTool('select');
    const c = connectors()[0]!;
    const g = scene.connectorGeometry(c.id)!;
    const end = g.points[g.points.length - 1]!;
    drag([end.x, end.y], [50, 350]);
    expect((scene.get(c.id) as ConnectorElement).end).toMatchObject({ kind: 'element', id: 'd' });
    expect(
      ((scene.get(c.id) as ConnectorElement).end as { anchor?: unknown }).anchor,
    ).toBeDefined();
    expect(scene.connectorsOf('b')).toEqual([]);
  });

  it('moves free ends with the selection; attached ends follow their shapes', () => {
    tools.setTool('connector');
    drag([50, 50], [600, 600]);
    tools.setTool('select');
    const id = connectors()[0]!.id;
    overlay.selection = new Set(['a', id]);
    drag([50, 50], [150, 50]); // move by +100
    expect((scene.get('a') as ShapeElement).x).toBe(100);
    expect((scene.get(id) as ConnectorElement).end).toEqual({ kind: 'point', x: 700, y: 600 });
  });

  it('deletes connectors together with their shapes', () => {
    tools.setTool('connector');
    drag([50, 50], [350, 50]);
    overlay.selection = new Set(['a']);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }));
    expect(connectors()).toHaveLength(0);
    expect(scene.has('b')).toBe(true);
  });

  it('pins an end to the exact outline point when dropped near an edge', () => {
    tools.setTool('connector');
    drag([50, 50], [303, 80]); // 3px inside b's left edge, far from its middle
    const end = connectors()[0]!.end;
    expect(end.kind).toBe('element');
    expect(end.kind === 'element' && end.anchor).toEqual({ x: 0, y: 0.8 });
  });

  it('bends a line by dragging its middle handle, and straightens it on double click', () => {
    tools.style.route = 'straight';
    tools.setTool('connector');
    drag([50, 50], [350, 50]); // floating ends: straight line from (100,50) to (300,50)
    tools.setTool('select');
    const id = connectors()[0]!.id;
    const handle = scene.connectorGeometry(id)!.handle!.point;
    expect(handle).toEqual({ x: 200, y: 50 });
    drag([handle.x, handle.y], [200, 160]);
    const bent = scene.get(id) as ConnectorElement;
    expect(bent.route).toBe('curve');
    const after = scene.connectorGeometry(id)!.handle!.point;
    expect(after.x).toBeCloseTo(200);
    expect(after.y).toBeCloseTo(160);

    stage.dispatchEvent(
      new MouseEvent('dblclick', { clientX: after.x, clientY: after.y, bubbles: true }),
    );
    expect((scene.get(id) as ConnectorElement).curve).toBeUndefined();
  });

  it('reverses selected connectors', () => {
    tools.setTool('connector');
    drag([50, 50], [600, 600]);
    const c = connectors()[0]!;
    reverseSelected(scene, [c.id, 'a']); // shapes in the selection are ignored
    const r = scene.get(c.id) as ConnectorElement;
    expect(r.start).toEqual({ kind: 'point', x: 600, y: 600 });
    expect(r.end).toMatchObject({ kind: 'element', id: 'a' });
    expect(r.endCap).toBe(c.endCap); // caps stay: the arrow now points the other way
  });

  it('snaps to a side middle from outside the shape and holds it until clearly pulled away', () => {
    tools.setTool('connector');
    pointer('pointerdown', 50, 50);
    pointer('pointermove', 280, 70); // 20px outside b's left side, 20px below its middle
    const id = connectors()[0]!.id;
    const end = () => (scene.get(id) as ConnectorElement).end;
    expect(end()).toEqual({ kind: 'element', id: 'b', anchor: { x: 0, y: 0.5 } });
    expect(overlay.target).toBe('b');
    pointer('pointermove', 268, 50); // 32px out: beyond 28, but within the 1.5x release radius
    expect(end()).toEqual({ kind: 'element', id: 'b', anchor: { x: 0, y: 0.5 } });
    pointer('pointermove', 240, 50); // 60px out: released
    expect(end().kind).toBe('point');
    pointer('pointerup', 240, 50);
  });

  describe('UX', () => {
    const rightDot = () => anchorDot(scene.get('a') as ShapeElement, { x: 1, y: 0.5 }, 1);
    const key = (k: string) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k }));

    it('grabs a connection dot within a generous radius', () => {
      pointer('pointermove', 50, 50);
      const dot = rightDot();
      drag([dot.x - 10, dot.y + 7], [500, 500]);
      expect(connectors()).toHaveLength(1);
    });

    it('keeps the dots of the shape when the pointer crosses a neighbour to reach a dot', () => {
      scene.add(box('n', 110, 0)); // its area covers a's right dot
      pointer('pointermove', 50, 50);
      const dot = rightDot();
      pointer('pointermove', dot.x, dot.y);
      expect(overlay.anchorsFor).toBe('a');
      expect(overlay.hoverDot).toEqual({ x: 1, y: 0.5 });
    });

    it('hides dots on shapes that are tiny on screen', () => {
      const camera = (overlay as unknown as { camera: { set(s: object): void } }).camera;
      camera.set({ zoom: 0.2 }); // 100 units → 20px
      pointer('pointermove', 10, 10);
      expect(overlay.anchorsFor).toBeNull();
    });

    it('quick-creates a connected copy when a dot is clicked, skipping occupied spots', () => {
      let created: string | null = null;
      document.body.innerHTML = '<div id="stage2"></div>';
      const stage2 = document.getElementById('stage2')!;
      stage2.setPointerCapture = () => undefined;
      stage2.releasePointerCapture = () => undefined;
      stage2.hasPointerCapture = () => false;
      attachControls(
        stage2,
        scene,
        (overlay as unknown as { camera: never }).camera,
        overlay,
        tools,
        undefined,
        {
          onQuickCreate: (id) => (created = id),
        },
      );
      scene.add(box('busy', 180, 0)); // the first free spot to the right is taken
      const fire = (type: string, x: number, y: number) =>
        stage2.dispatchEvent(
          new PointerEvent(type, {
            clientX: x,
            clientY: y,
            button: 0,
            pointerId: 2,
            bubbles: true,
          }),
        );
      fire('pointermove', 50, 50);
      const dot = rightDot();
      fire('pointerdown', dot.x, dot.y);
      fire('pointerup', dot.x, dot.y);
      expect(created).not.toBeNull();
      const copy = scene.get(created!) as ShapeElement;
      // 180 is taken by "busy", 360 overlaps "b" (300..400): third step out.
      expect(copy.x).toBe(540);
      expect(copy.y).toBe(0);
      const link = connectors().find((c) => c.end.kind === 'element' && c.end.id === created)!;
      expect(link.start).toEqual({ kind: 'element', id: 'a', anchor: { x: 1, y: 0.5 } });
      expect(link.end).toEqual({ kind: 'element', id: created, anchor: { x: 0, y: 0.5 } });
      expect(overlay.selection).toEqual(new Set([created]));
    });

    it('Esc cancels a new connector, restores a moved end, a drag and a bend', () => {
      tools.setTool('connector');
      pointer('pointerdown', 50, 50);
      pointer('pointermove', 500, 500);
      key('Escape');
      expect(connectors()).toHaveLength(0);
      pointer('pointerup', 500, 500);

      drag([50, 50], [350, 50]);
      tools.setTool('select');
      const c = connectors()[0]!;
      const end = scene.connectorGeometry(c.id)!.points.at(-1)!;
      pointer('pointerdown', end.x, end.y);
      pointer('pointermove', 700, 700);
      key('Escape');
      expect((scene.get(c.id) as ConnectorElement).end).toEqual(c.end);
      pointer('pointerup', 700, 700);

      overlay.selection = new Set();
      pointer('pointerdown', 50, 50);
      pointer('pointermove', 150, 150);
      expect((scene.get('a') as ShapeElement).x).toBe(100);
      key('Escape');
      expect((scene.get('a') as ShapeElement).x).toBe(0);
      pointer('pointerup', 150, 150);
    });
  });

  it('switches tools with L and V', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l' }));
    expect(tools.tool).toBe('connector');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v' }));
    expect(tools.tool).toBe('select');
  });
});
