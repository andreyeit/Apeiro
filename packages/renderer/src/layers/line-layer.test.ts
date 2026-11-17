import { describe, expect, it } from 'vitest';
import {
  capSize,
  inkGeometry,
  Scene,
  type ConnectorElement,
  type ShapeElement,
} from '@apeiro/core';
import {
  CAP_MODE,
  JOIN_END,
  JOIN_FLAG,
  LINE_ARC,
  LINE_HIDDEN,
  LINE_SEGMENT,
  LINE_STRIDE,
  LineLayer,
} from './line-layer';
import { shapeDepth } from '../depth';

const FLOATS = LINE_STRIDE / 4;

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

const conn = (patch: Partial<ConnectorElement> = {}): ConnectorElement => ({
  id: 'c',
  type: 'connector',
  z: 1,
  start: { kind: 'element', id: 'a' },
  end: { kind: 'element', id: 'b' },
  route: 'straight',
  stroke: 0x112233ff,
  strokeWidth: 2,
  dash: 'solid',
  startCap: 'none',
  endCap: 'triangle',
  ...patch,
});

function setup(c: ConnectorElement = conn()) {
  const scene = new Scene();
  scene.add(box('a', 0, 0));
  scene.add(box('b', 300, 0));
  scene.add(c);
  const layer = new LineLayer();
  const read = (i: number) => Array.from(new Float32Array(layer.data, i * LINE_STRIDE, 12));
  const mode = (i: number) => read(i)[5];
  return { scene, layer, read, mode };
}

describe('LineLayer', () => {
  it('emits segments and caps with depth from the slot and the stroke color', () => {
    const { scene, layer, read, mode } = setup();
    layer.set(scene.get('c') as ConnectorElement, scene.connectorGeometry('c'), 7);
    expect(mode(0)).toBe(LINE_SEGMENT);
    expect(mode(1)).toBe(CAP_MODE.triangle);
    expect(read(0)[9]).toBeCloseTo(shapeDepth(7));
    expect([...new Uint8Array(layer.data, 48, 4)]).toEqual([0x11, 0x22, 0x33, 0xff]);
    // Line stops inside the filled arrow head; the cap tip rests against the shape
    // (half the 2-wide line out of the outline at x 300).
    expect(read(0)[2]).toBeCloseTo(299 - capSize(2) * 0.7);
    expect(read(1).slice(0, 2)).toEqual([299, 50]);
  });

  it('continues dash offsets along the polyline', () => {
    const { scene, layer, read } = setup(conn({ route: 'elbow', dash: 'dashed', endCap: 'none' }));
    scene.update('b', { y: 300 });
    layer.set(scene.get('c') as ConnectorElement, scene.connectorGeometry('c'), 0);
    const first = read(0);
    const second = read(1);
    const len0 = Math.hypot(first[2]! - first[0]!, first[3]! - first[1]!);
    expect(second[8]).toBeCloseTo(len0);
    expect(first[7]).toBeGreaterThan(0); // gap > 0 means dashed
  });

  it('rewrites in place and hides spare instances when the shape of the route changes', () => {
    const { scene, layer, mode } = setup(conn({ route: 'elbow', endCap: 'none' }));
    scene.update('b', { y: 300 });
    layer.set(scene.get('c') as ConnectorElement, scene.connectorGeometry('c'), 0);
    const count = layer.count;
    scene.update('b', { y: 0 }); // straight across: fewer segments
    layer.set(scene.get('c') as ConnectorElement, scene.connectorGeometry('c'), 0);
    expect(layer.count).toBe(count);
    expect(mode(1)).toBe(LINE_HIDDEN);
  });

  it('moves to the end when a connector outgrows its range', () => {
    const { scene, layer, mode } = setup(conn({ endCap: 'none' }));
    layer.set(scene.get('c') as ConnectorElement, scene.connectorGeometry('c'), 0);
    const before = layer.count;
    scene.update('c', { route: 'curve' });
    layer.set(scene.get('c') as ConnectorElement, scene.connectorGeometry('c'), 0);
    expect(layer.count).toBeGreaterThan(before);
    expect(mode(0)).toBe(LINE_HIDDEN); // old range became a hole
  });

  it('hides connectors without geometry and on removal', () => {
    const { scene, layer, mode } = setup();
    layer.set(scene.get('c') as ConnectorElement, scene.connectorGeometry('c'), 0);
    layer.takeUpload();
    layer.remove('c');
    expect(mode(0)).toBe(LINE_HIDDEN);
    expect(layer.takeUpload()).toEqual({ kind: 'ranges', runs: [[0, expect.any(Number)]] });
    scene.remove('b');
    layer.set(scene.get('c') as ConnectorElement, scene.connectorGeometry('c'), 0);
    for (let i = 0; i < layer.count; i++) expect(mode(i)).toBe(LINE_HIDDEN);
  });

  it('rebuilds all connectors of a scene', () => {
    const { scene, layer } = setup();
    layer.rebuild(scene, () => 0);
    expect(layer.count).toBeGreaterThanOrEqual(2);
    expect(layer.takeUpload()).toEqual({ kind: 'all' });
    expect(FLOATS).toBe(13);
  });

  it('draws rounded bends as exact arcs, with dashes continuing along them', () => {
    const scene = new Scene();
    scene.add(box('a', 0, 0));
    scene.add(box('b', 300, 300));
    scene.add(conn({ route: 'elbow', cornerRadius: 20, dash: 'dashed', endCap: 'none' }));
    const g = scene.connectorGeometry('c')!;
    expect(g.arcs?.length).toBeGreaterThan(0);
    const layer = new LineLayer();
    layer.set(scene.get('c') as ConnectorElement, g, 1);
    const items = Array.from({ length: layer.count }, (_, i) =>
      Array.from(new Float32Array(layer.data, i * LINE_STRIDE, 12)),
    ).filter((it) => it[5] !== LINE_HIDDEN);
    const arcs = items.filter((it) => it[5] === LINE_ARC);
    // One instance per bend instead of its flattened points.
    expect(arcs).toHaveLength(g.arcs!.length);
    const first = g.arcs![0]!;
    expect(arcs[0]!.slice(0, 4)).toEqual([
      expect.closeTo(first.cx, 3),
      expect.closeTo(first.cy, 3),
      expect.closeTo(first.r, 3),
      expect.closeTo(first.start, 5),
    ]);
    expect(arcs[0]![10]).toBeCloseTo(first.sweep, 5);
    // Dash offsets grow monotonically: segment, arc, segment… in path order.
    const offsets = items.map((it) => it[8]!);
    for (let i = 1; i < offsets.length; i++) expect(offsets[i]!).toBeGreaterThan(offsets[i - 1]!);
  });

  describe('joints', () => {
    /** One end of an instance's packed joins: null if free, else its split line's angle. */
    const joint = (item: number[], end: boolean): number | null => {
      const packed = item[11]!;
      const bits = end ? Math.floor(packed / JOIN_END) : packed % JOIN_END;
      if (bits < JOIN_FLAG) return null;
      return ((bits - JOIN_FLAG) / (JOIN_FLAG - 1)) * Math.PI - Math.PI / 2;
    };
    const itemsOf = (layer: LineLayer) =>
      Array.from({ length: layer.count }, (_, i) =>
        Array.from(new Float32Array(layer.data, i * LINE_STRIDE, 12)),
      ).filter((it) => it[5] !== LINE_HIDDEN);
    const elbow = (cornerRadius: number) => {
      const scene = new Scene();
      scene.add(box('a', 0, 0));
      scene.add(box('b', 300, 300));
      scene.add(conn({ route: 'elbow', cornerRadius }));
      const layer = new LineLayer();
      layer.set(scene.get('c') as ConnectorElement, scene.connectorGeometry('c'), 1);
      return itemsOf(layer);
    };

    it('splits every rounded bend between the arc and the segments touching it', () => {
      const items = elbow(20);
      const path = items.filter((it) => it[5] === LINE_SEGMENT || it[5] === LINE_ARC);
      expect(path.some((it) => it[5] === LINE_ARC)).toBe(true);
      // The line's own ends stay round; every joint inside is split, across the line
      // (angle 0: bends are tangent to their segments).
      expect(joint(path[0]!, false)).toBeNull();
      expect(joint(path.at(-1)!, true)).toBeNull();
      for (let i = 0; i + 1 < path.length; i++) {
        expect(joint(path[i]!, true)).toBeCloseTo(0, 2);
        expect(joint(path[i + 1]!, false)).toBeCloseTo(0, 2);
      }
      // The arrow head is not part of the path.
      expect(items.find((it) => it[5] === CAP_MODE.triangle)![11]).toBe(0);
    });

    it('splits sharp corners along the bisector of the two directions', () => {
      const path = elbow(0).filter((it) => it[5] === LINE_SEGMENT);
      expect(path.length).toBeGreaterThan(1);
      for (let i = 0; i + 1 < path.length; i++) {
        const end = joint(path[i]!, true)!;
        expect(Math.abs(end)).toBeCloseTo(Math.PI / 4, 2); // a right angle, halved
        expect(joint(path[i + 1]!, false)).toBeCloseTo(-end, 2); // the same line seen from the other side
      }
    });

    it('joins the segments of a pen stroke, but a dot keeps its round ends', () => {
      const layer = new LineLayer();
      const ink = (pts: Array<{ x: number; y: number }>): ShapeElement => ({
        ...box('ink', 0, 0),
        type: 'ink',
        stroke: 0x000000ff,
        strokeWidth: 2,
        ...inkGeometry(pts),
      });
      layer.setInk(
        ink([
          { x: 0, y: 0 },
          { x: 40, y: 0 },
          { x: 80, y: 30 },
        ]),
        0,
      );
      const items = itemsOf(layer);
      expect(items.length).toBeGreaterThan(2);
      expect(joint(items[0]!, false)).toBeNull();
      expect(joint(items[0]!, true)).not.toBeNull();
      expect(joint(items.at(-1)!, true)).toBeNull();

      layer.setInk(ink([{ x: 5, y: 5 }]), 0);
      const dot = itemsOf(layer);
      expect(dot).toHaveLength(1);
      expect(dot[0]![11]).toBe(0);
    });
  });

  it('moves a growing pen stroke only now and then', () => {
    const layer = new LineLayer();
    const pts: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < 600; i++) {
      pts.push({ x: i * 3, y: Math.sin(i / 10) * 40 });
      const stroke: ShapeElement = {
        ...box('ink', 0, 0),
        type: 'ink',
        stroke: 0x000000ff,
        strokeWidth: 2,
        ...inkGeometry(pts),
      };
      layer.setInk(stroke, 0);
    }
    const f32 = new Float32Array(layer.data);
    let segments = 0;
    for (let i = 0; i < layer.count; i++) if (f32[i * FLOATS + 5] === LINE_SEGMENT) segments++;
    expect(segments).toBeGreaterThan(500);
    // Ranges grow by half: everything ever allocated is a small multiple of the stroke
    // (a geometric series, at most 4.5x), not a sum over every point.
    expect(layer.count).toBeLessThan(segments * 5);
  });
});
