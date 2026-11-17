import { describe, expect, it } from 'vitest';
import {
  anchorAt,
  bendConnector,
  freezeConnectorEnds,
  resetBend,
  reverseConnector,
  capSize,
  hitTestConnector,
  resolveConnector,
  type ConnectorElement,
} from '.';
import { Scene, type SceneChanges } from '../scene/scene';
import type { ShapeElement } from '../elements/element';
import { makeRect } from '../test-utils';

const box = (id: string, x: number, y: number, patch: Partial<ShapeElement> = {}) =>
  makeRect(id, { x, y, w: 100, h: 100, ...patch }) as ShapeElement;

const conn = (patch: Partial<ConnectorElement> = {}): ConnectorElement => ({
  id: 'c',
  type: 'connector',
  z: 10,
  start: { kind: 'element', id: 'a' },
  end: { kind: 'element', id: 'b' },
  route: 'straight',
  stroke: 0x000000ff,
  // Hairline: these tests check where ends land on outlines (a wider line, or a shape's
  // border, moves the end out to the border's edge — tested separately below).
  strokeWidth: 0,
  dash: 'solid',
  startCap: 'none',
  endCap: 'arrow',
  ...patch,
});

const shapes = (...list: ShapeElement[]) => {
  const map = new Map(list.map((s) => [s.id, s]));
  return (id: string) => map.get(id);
};

describe('Scene route invalidation', () => {
  it('preserves routes and bounds on style updates but recalculates changed contours', () => {
    const scene = new Scene();
    scene.transact(() => {
      scene.add(box('a', 0, 0));
      scene.add(box('b', 300, 100));
      scene.add(conn());
    });
    const geometry = scene.connectorGeometry('c');
    const bounds = scene.getBounds('a');
    const changes: SceneChanges[] = [];
    scene.subscribe((change) => changes.push(change));
    scene.update('a', { fill: 0xff0000ff, strokeStyle: 'dashed', z: 50 });
    expect(scene.connectorGeometry('c')).toBe(geometry);
    expect(scene.getBounds('a')).toBe(bounds);
    expect(changes[0]!.updated.map((el) => el.id)).toEqual(['a']);
    expect(changes[0]!.orderChanged).toBe(true);
    scene.update('a', { radius: 40, x: 10 });
    expect(scene.connectorGeometry('c')).not.toBe(geometry);
    expect(changes[1]!.updated.map((el) => el.id)).toContain('c');
  });

  it('settles routes when querying combined bounds inside a transaction', () => {
    const scene = new Scene();
    scene.add(conn());
    expect(scene.bounds()).toBeNull(); // attached shapes have not arrived yet
    scene.transact(() => {
      scene.add(box('a', 0, 0));
      scene.add(box('b', 300, 100));
      expect(scene.bounds(['c'])).toEqual(scene.connectorGeometry('c')!.bounds);
    });
  });
});

describe('resolveConnector', () => {
  it('clips a floating straight line to both outlines', () => {
    const g = resolveConnector(conn(), shapes(box('a', 0, 0), box('b', 300, 0)))!;
    expect(g.points).toEqual([
      { x: 100, y: 50 },
      { x: 300, y: 50 },
    ]);
    expect(g.endDir).toEqual({ x: 1, y: 0 });
    expect(g.startDir).toEqual({ x: -1, y: 0 });
  });

  it('clips to ellipses', () => {
    const g = resolveConnector(
      conn(),
      shapes(box('a', 0, 0, { type: 'ellipse' }), box('b', 300, 300)),
    )!;
    const p = g.points[0]!;
    // On the circle of radius 50 around (50, 50), toward the other box (diagonal).
    expect(Math.hypot(p.x - 50, p.y - 50)).toBeCloseTo(50);
    expect(p.x).toBeCloseTo(50 + 50 * Math.SQRT1_2);
  });

  it('uses fixed anchors, rotated with the shape', () => {
    const c = conn({ start: { kind: 'element', id: 'a', anchor: { x: 0.5, y: 0 } } });
    const g = resolveConnector(
      c,
      shapes(box('a', 0, 0, { rotation: Math.PI / 2 }), box('b', 300, 0)),
    )!;
    // Top-middle of a box rotated 90° clockwise points right: (100, 50).
    expect(g.points[0]!.x).toBeCloseTo(100);
    expect(g.points[0]!.y).toBeCloseTo(50);
  });

  it('routes elbow lines orthogonally from facing sides', () => {
    const g = resolveConnector(
      conn({ route: 'elbow' }),
      shapes(box('a', 0, 0), box('b', 300, 200)),
    )!;
    for (let i = 0; i + 1 < g.points.length; i++) {
      const a = g.points[i]!;
      const b = g.points[i + 1]!;
      expect(a.x === b.x || a.y === b.y).toBe(true);
    }
    expect(g.points[0]).toEqual({ x: 100, y: 50 }); // right side middle
    expect(g.points[g.points.length - 1]).toEqual({ x: 300, y: 250 }); // left side middle
  });

  it('straightens elbow lines between shapes whose facing sides overlap', () => {
    const g = resolveConnector(
      conn({ route: 'elbow' }),
      shapes(box('a', 0, 0), box('b', 300, 30)),
    )!;
    expect(g.points).toEqual([
      { x: 100, y: 65 },
      { x: 300, y: 65 },
    ]);
  });

  it('flattens curves into many points between the ends', () => {
    const g = resolveConnector(
      conn({ route: 'curve' }),
      shapes(box('a', 0, 0), box('b', 300, 200)),
    )!;
    expect(g.points.length).toBeGreaterThan(8);
    expect(g.points[0]!.x).toBeCloseTo(100);
  });

  it('supports free point ends', () => {
    const c = conn({ start: { kind: 'point', x: -50, y: 50 } });
    const g = resolveConnector(c, shapes(box('b', 300, 0)))!;
    expect(g.points).toEqual([
      { x: -50, y: 50 },
      { x: 300, y: 50 },
    ]);
  });

  it('returns null when an attached shape is missing', () => {
    expect(resolveConnector(conn(), shapes(box('a', 0, 0)))).toBeNull();
  });

  it('includes caps in the bounds', () => {
    const g = resolveConnector(conn(), shapes(box('a', 0, 0), box('b', 300, 0)))!;
    expect(g.bounds.maxY).toBeCloseTo(50 + capSize(2));
  });
});

describe('hitTestConnector', () => {
  it('hits near the line and the caps', () => {
    const c = conn({ strokeWidth: 2 });
    const g = resolveConnector(c, shapes(box('a', 0, 0), box('b', 300, 0)))!;
    expect(hitTestConnector(c, g, { x: 200, y: 51 })).toBe(true);
    expect(hitTestConnector(c, g, { x: 200, y: 60 })).toBe(false);
    expect(hitTestConnector(c, g, { x: 200, y: 60 }, 10)).toBe(true);
    expect(hitTestConnector(c, g, { x: 294, y: 54 })).toBe(true); // inside the arrow head
    expect(hitTestConnector(c, g, { x: 305, y: 54 })).toBe(false); // past the tip
  });
});

describe('ends rest against the border, like Miro', () => {
  it('a line stops at the outer edge of the border, not in it', () => {
    // Borders 4 wide: their outer edge is 2 outside the outline. Line 2 wide: its round
    // end reaches 1 past its point. So the ends sit 3 out of the outlines (x 100 and 300).
    const c = conn({ strokeWidth: 2 });
    const g = resolveConnector(
      c,
      shapes(box('a', 0, 0, { strokeWidth: 4 }), box('b', 300, 0, { strokeWidth: 4 })),
    )!;
    expect(g.points[0]).toEqual({ x: 103, y: 50 });
    expect(g.points.at(-1)).toEqual({ x: 297, y: 50 });
  });

  it('moves straight out of the border: along a side, along the normal of an ellipse', () => {
    const c = conn({ strokeWidth: 2, end: { kind: 'point', x: 400, y: 0 } });
    // Floating end (with a cap) on a box toward the upper right: it leaves the right side,
    // moved straight right.
    const g = resolveConnector(
      { ...c, startCap: 'arrow' },
      shapes(box('a', 0, 0), box('b', 300, 0)),
    )!;
    expect(g.points[0]!.x).toBeCloseTo(101);
    const e = resolveConnector(
      conn({
        strokeWidth: 2,
        startCap: 'circle',
        start: { kind: 'element', id: 'e', anchor: { x: 1, y: 0.5 } },
      }),
      shapes(box('e', 0, 0, { type: 'ellipse' }), box('b', 300, 0)),
    )!;
    expect(e.points[0]).toEqual({ x: 101, y: 50 });
  });

  it('elbows and free point ends: elbows too, points stay exactly where they are', () => {
    const g = resolveConnector(
      conn({ route: 'elbow', strokeWidth: 2 }),
      shapes(box('a', 0, 0, { strokeWidth: 2 }), box('b', 300, 0, { strokeWidth: 2 })),
    )!;
    expect(g.points[0]).toEqual({ x: 102, y: 50 }); // half the border + half the line
    expect(g.points.at(-1)).toEqual({ x: 298, y: 50 });
    const p = resolveConnector(
      conn({ strokeWidth: 2, end: { kind: 'point', x: 400, y: 50 } }),
      shapes(box('a', 0, 0), box('b', 300, 0)),
    )!;
    expect(p.points.at(-1)).toEqual({ x: 400, y: 50 });
  });

  it("pinning a floating end anchors it on the outline, so the line doesn't move", () => {
    const c = conn({ strokeWidth: 2, end: { kind: 'point', x: 400, y: 160 } });
    const get = shapes(box('a', 0, 0, { strokeWidth: 4 }), box('b', 300, 0));
    const before = resolveConnector(c, get)!;
    const after = resolveConnector({ ...c, ...freezeConnectorEnds(c, get)! }, get)!;
    expect(after.points[0]!.x).toBeCloseTo(before.points[0]!.x);
    expect(after.points[0]!.y).toBeCloseTo(before.points[0]!.y);
  });
});

describe('anchorAt', () => {
  it('snaps to side midpoints', () => {
    const s = box('a', 0, 0);
    expect(anchorAt(s, { x: 98, y: 52 }, 8)).toEqual({ x: 1, y: 0.5 });
    expect(anchorAt(s, { x: 70, y: 70 }, 8)).toBeUndefined();
  });
});

describe('Scene with connectors', () => {
  function setup() {
    const scene = new Scene();
    scene.add(box('a', 0, 0));
    scene.add(box('b', 300, 0));
    scene.add(conn());
    const events: SceneChanges[] = [];
    scene.subscribe((c) => events.push(c));
    return { scene, events };
  }

  it('moves connectors together with attached shapes in the same batch', () => {
    const { scene, events } = setup();
    scene.update('b', { y: 200 });
    expect(events).toHaveLength(1);
    expect(events[0]!.updated.map((e) => e.id).sort()).toEqual(['b', 'c']);
    const g = scene.connectorGeometry('c')!;
    expect(g.points[g.points.length - 1]!.y).toBeGreaterThan(150);
    expect(scene.hitTest(g.points[1] ?? g.points[0]!)?.id).toBeDefined();
  });

  it('hides connectors whose shape was removed, and restores them if it comes back', () => {
    const { scene } = setup();
    const b = scene.get('b')!;
    scene.remove('b');
    expect(scene.connectorGeometry('c')).toBeNull();
    expect(scene.getBounds('c')).toBeUndefined();
    scene.add(b); // e.g. undo, or a remote add arriving late
    expect(scene.connectorGeometry('c')).not.toBeNull();
  });

  it('resolves connectors added before their shapes', () => {
    const scene = new Scene();
    scene.add(conn());
    expect(scene.connectorGeometry('c')).toBeNull();
    scene.transact(() => {
      scene.add(box('a', 0, 0));
      scene.add(box('b', 300, 0));
    });
    expect(scene.connectorGeometry('c')).not.toBeNull();
  });

  it('re-attaches when ends change', () => {
    const { scene } = setup();
    scene.add(box('d', 0, 400));
    scene.update('c', { end: { kind: 'element', id: 'd' } });
    expect(scene.connectorsOf('b')).toEqual([]);
    expect(scene.connectorsOf('d')).toEqual(['c']);
  });

  it('removes attached connectors with removeWithConnectors', () => {
    const { scene } = setup();
    scene.removeWithConnectors(['a']);
    expect(scene.has('c')).toBe(false);
    expect(scene.has('b')).toBe(true);
  });

  it('hit tests connectors by distance to the line', () => {
    const { scene } = setup();
    expect(scene.hitTest({ x: 200, y: 50 }, 2)?.id).toBe('c');
    expect(scene.hitTest({ x: 200, y: 80 }, 2)).toBeUndefined();
    expect(scene.hitTestShape({ x: 50, y: 50 })?.id).toBe('a');
  });
});

describe('bending connectors', () => {
  const two = () => shapes(box('a', 0, 0), box('b', 300, 0));

  it('makes a curve pass through the dragged handle and keeps it while ends move', () => {
    const c = conn({ route: 'curve' });
    const patch = bendConnector(c, { x: 200, y: -80 }, two())!;
    const bent = { ...c, ...patch };
    const g = resolveConnector(bent, two())!;
    expect(g.handle!.kind).toBe('curve');
    expect(g.handle!.point.x).toBeCloseTo(200);
    expect(g.handle!.point.y).toBeCloseTo(-80);
    // Same relative bend after moving b further away: the handle scales with the chord.
    const moved = resolveConnector(bent, shapes(box('a', 0, 0), box('b', 500, 0)))!;
    expect(moved.handle!.point.y).toBeLessThan(-80);
  });

  it('turns a straight line into a curve when its middle is dragged', () => {
    const c = conn({ route: 'straight' });
    expect(resolveConnector(c, two())!.handle!.point).toEqual({ x: 200, y: 50 });
    const patch = bendConnector(c, { x: 200, y: 150 }, two())!;
    expect(patch.route).toBe('curve');
    const g = resolveConnector({ ...c, ...patch }, two())!;
    expect(g.handle!.point.y).toBeCloseTo(150);
  });

  it('moves the middle segment of an elbow', () => {
    const c = conn({ route: 'elbow' });
    const get = shapes(box('a', 0, 0), box('b', 300, 300));
    const handle = resolveConnector(c, get)!.handle!;
    expect(handle).toMatchObject({ kind: 'elbow', axis: 'x' });
    const patch = bendConnector(c, { x: 150, y: 999 }, get)!;
    const g = resolveConnector({ ...c, ...patch }, get)!;
    expect(g.handle!.point.x).toBeCloseTo(150);
    for (let i = 0; i + 1 < g.points.length; i++) {
      const a = g.points[i]!;
      const b = g.points[i + 1]!;
      expect(a.x === b.x || a.y === b.y).toBe(true);
    }
  });

  it('resets the bend', () => {
    const c = { ...conn({ route: 'curve' }), curve: { along: 0.1, across: 0.5 } };
    const g0 = resolveConnector(conn({ route: 'curve' }), two())!;
    const g1 = resolveConnector({ ...c, ...resetBend() }, two())!;
    expect(g1.points).toEqual(g0.points);
  });

  it('reverses direction keeping the same line shape', () => {
    const c: ConnectorElement = { ...conn({ route: 'curve' }), curve: { along: 0.1, across: 0.4 } };
    const g = resolveConnector(c, two())!;
    const r = resolveConnector({ ...c, ...reverseConnector(c) }, two())!;
    expect(r.points[0]).toEqual(g.points[g.points.length - 1]);
    expect(r.handle!.point.x).toBeCloseTo(g.handle!.point.x);
    expect(r.handle!.point.y).toBeCloseTo(g.handle!.point.y);

    const e: ConnectorElement = { ...conn({ route: 'elbow' }), elbowAt: 0.2 };
    const get = shapes(box('a', 0, 0), box('b', 300, 300));
    const ge = resolveConnector(e, get)!;
    const re = resolveConnector({ ...e, ...reverseConnector(e) }, get)!;
    const reversed = re.points.slice().reverse();
    expect(reversed).toHaveLength(ge.points.length);
    reversed.forEach((p, i) => {
      expect(p.x).toBeCloseTo(ge.points[i]!.x);
      expect(p.y).toBeCloseTo(ge.points[i]!.y);
    });
  });
});

describe('anchorAt on the outline', () => {
  it('projects points near an edge, keeps deep points floating', () => {
    const s = box('a', 0, 0);
    expect(anchorAt(s, { x: 25, y: 3 }, 8, 10)).toEqual({ x: 0.25, y: 0 }); // past the magnet strip
    expect(anchorAt(s, { x: 104, y: 80 }, 8, 10)).toEqual({ x: 1, y: 0.8 });
    expect(anchorAt(s, { x: 50, y: 40 }, 8, 10)).toBeUndefined();
  });

  it('projects radially on ellipses', () => {
    const s = box('e', 0, 0, { type: 'ellipse' });
    const a = anchorAt(s, { x: 50 + 49 * Math.SQRT1_2, y: 50 + 49 * Math.SQRT1_2 }, 4, 6)!;
    expect(a.x).toBeCloseTo(0.5 + 0.5 * Math.SQRT1_2);
    expect(a.y).toBeCloseTo(0.5 + 0.5 * Math.SQRT1_2);
  });
});

describe('elbow handle', () => {
  it('is hidden when the ends are aligned and the middle segment has no length', () => {
    const g = resolveConnector(conn({ route: 'elbow' }), shapes(box('a', 0, 0), box('b', 300, 0)))!;
    expect(g.handle).toBeNull();
  });
});

describe('bent curves with floating ends', () => {
  it('slide the ends along the outlines toward the bend', () => {
    const get = shapes(box('a', 0, 0, { type: 'ellipse' }), box('b', 300, 0, { type: 'ellipse' }));
    const c = conn({ route: 'straight', endCap: 'none' });
    const bent = { ...c, ...bendConnector(c, { x: 200, y: -100 }, get)! };
    const g = resolveConnector(bent, get)!;
    const start = g.points[0]!;
    const end = g.points[g.points.length - 1]!;
    expect(start.y).toBeLessThan(50); // moved up from the right-middle of a
    expect(end.y).toBeLessThan(50);
    expect(Math.hypot(start.x - 50, start.y - 50)).toBeCloseTo(50); // still on the circle
    // Smooth: no sharp turns between consecutive segments.
    for (let i = 1; i + 1 < g.points.length; i++) {
      const p = g.points[i - 1]!;
      const q = g.points[i]!;
      const r = g.points[i + 1]!;
      const a1 = Math.atan2(q.y - p.y, q.x - p.x);
      const a2 = Math.atan2(r.y - q.y, r.x - q.x);
      const turn = Math.abs(Math.atan2(Math.sin(a2 - a1), Math.cos(a2 - a1)));
      expect(turn).toBeLessThan(0.35);
    }
  });
});

describe('side midpoint magnet', () => {
  it('reaches further along a side than across it', () => {
    const s = box('a', 0, 0, { w: 300, h: 100 }); // top side 300 long → reach 60 along
    expect(anchorAt(s, { x: 150 + 55, y: 5 }, 10)).toEqual({ x: 0.5, y: 0 });
    expect(anchorAt(s, { x: 150 + 65, y: 5 }, 10)).toBeUndefined();
    expect(anchorAt(s, { x: 150, y: 15 }, 10)).toBeUndefined(); // too far across
    expect(anchorAt(s, { x: 150, y: -9 }, 10)).toEqual({ x: 0.5, y: 0 }); // from outside
  });

  it('picks the closest midpoint on small shapes', () => {
    const s = box('a', 0, 0, { w: 20, h: 20 });
    expect(anchorAt(s, { x: 19, y: 12 }, 15)).toEqual({ x: 1, y: 0.5 });
  });
});

describe('Scene.hitTestShape tolerance', () => {
  it('finds shapes near the point, not only under it', () => {
    const scene = new Scene();
    scene.add(box('a', 0, 0));
    expect(scene.hitTestShape({ x: 120, y: 50 })).toBeUndefined();
    expect(scene.hitTestShape({ x: 120, y: 50 }, 25)?.id).toBe('a');
  });
});

describe('freezeConnectorEnds', () => {
  it('pins floating ends at their current outline points without changing the line', () => {
    const get = shapes(box('a', 0, 0), box('b', 300, 100));
    const c = conn();
    const before = resolveConnector(c, get)!;
    const frozen = { ...c, ...freezeConnectorEnds(c, get)! };
    expect(frozen.start.kind === 'element' && frozen.start.anchor).toBeTruthy();
    const after = resolveConnector(frozen, get)!;
    expect(after.points[0]!.x).toBeCloseTo(before.points[0]!.x);
    expect(after.points[0]!.y).toBeCloseTo(before.points[0]!.y);
  });

  it('snaps exact side middles to clean anchors', () => {
    const get = shapes(box('a', 0, 0), box('b', 300, 0));
    const frozen = freezeConnectorEnds(conn(), get)!;
    expect(frozen.start).toEqual({ kind: 'element', id: 'a', anchor: { x: 1, y: 0.5 } });
  });

  it('does nothing when no end is floating', () => {
    const c = conn({
      start: { kind: 'point', x: 0, y: 0 },
      end: { kind: 'element', id: 'b', anchor: { x: 0, y: 0.5 } },
    });
    expect(freezeConnectorEnds(c, shapes(box('b', 300, 0)))).toBeNull();
  });
});

/** True if an axis-aligned segment runs through the inside of a shape's box (touching edges is fine). */
function crosses(
  p: { x: number; y: number },
  q: { x: number; y: number },
  s: ShapeElement,
): boolean {
  const e = 0.5;
  const minX = s.x + e;
  const maxX = s.x + s.w - e;
  const minY = s.y + e;
  const maxY = s.y + s.h - e;
  if (Math.abs(p.y - q.y) < 1e-6) {
    const lo = Math.min(p.x, q.x);
    const hi = Math.max(p.x, q.x);
    return p.y > minY && p.y < maxY && hi > minX && lo < maxX;
  }
  const lo = Math.min(p.y, q.y);
  const hi = Math.max(p.y, q.y);
  return p.x > minX && p.x < maxX && hi > minY && lo < maxY;
}

describe('elbow routing invariants', () => {
  const SIDES = [
    { x: 0.5, y: 0 },
    { x: 1, y: 0.5 },
    { x: 0.5, y: 1 },
    { x: 0, y: 0.5 },
  ];
  const normalOf = (a: { x: number; y: number }) => ({ x: (a.x - 0.5) * 2, y: (a.y - 0.5) * 2 });

  function check(
    points: { x: number; y: number }[],
    n0: { x: number; y: number },
    n1: { x: number; y: number },
  ) {
    const dirs: { x: number; y: number }[] = [];
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i]!;
      const b = points[i + 1]!;
      expect(Math.abs(a.x - b.x) < 1e-6 || Math.abs(a.y - b.y) < 1e-6).toBe(true); // orthogonal
      const l = Math.hypot(b.x - a.x, b.y - a.y);
      if (l > 1e-6) dirs.push({ x: (b.x - a.x) / l, y: (b.y - a.y) / l });
    }
    for (let i = 0; i + 1 < dirs.length; i++) {
      const dot = dirs[i]!.x * dirs[i + 1]!.x + dirs[i]!.y * dirs[i + 1]!.y;
      expect(dot).toBeGreaterThan(-0.5); // never doubles back
    }
    if (dirs.length > 0) {
      expect(dirs[0]!.x * n0.x + dirs[0]!.y * n0.y).toBeGreaterThanOrEqual(0); // leaves outwards
      const last = dirs[dirs.length - 1]!;
      expect(-(last.x * n1.x + last.y * n1.y)).toBeGreaterThanOrEqual(0); // arrives from outside
    }
  }

  it('does not hook back when facing shapes are closer than two stubs (reported bug)', () => {
    // Circle above a sticky with a 20px gap, ends offset horizontally.
    const get = shapes(box('a', 100, 0, { type: 'ellipse' }), box('b', 0, 120, { w: 300 }));
    const c = conn({
      route: 'elbow',
      start: { kind: 'element', id: 'a', anchor: { x: 0.5, y: 1 } },
      end: { kind: 'element', id: 'b', anchor: { x: 0.2, y: 0 } },
    });
    const g = resolveConnector(c, get)!;
    check(g.points, { x: 0, y: 1 }, { x: 0, y: -1 });
    for (let i = 0; i + 1 < g.points.length; i++) {
      expect(g.points[i + 1]!.y).toBeGreaterThanOrEqual(g.points[i]!.y - 1e-6); // only downwards
    }
  });

  it('holds for random layouts and every pair of sides', () => {
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let trial = 0; trial < 2000; trial++) {
      const a = box('a', 0, 0, { w: 40 + rand() * 200, h: 40 + rand() * 200 });
      const b = box('b', (rand() - 0.5) * 800, (rand() - 0.5) * 800, {
        w: 40 + rand() * 200,
        h: 40 + rand() * 200,
      });
      const sa = SIDES[Math.floor(rand() * 4)]!;
      const sb = SIDES[Math.floor(rand() * 4)]!;
      const c = conn({
        route: 'elbow',
        start: { kind: 'element', id: 'a', anchor: sa },
        end: { kind: 'element', id: 'b', anchor: sb },
        elbowAt: rand() < 0.3 ? rand() * 3 - 1 : undefined,
      });
      const g = resolveConnector(c, shapes(a, b))!;
      check(g.points, normalOf(sa), normalOf(sb));
      // Unless the shapes (with their stub margin) overlap, the line never cuts through them.
      const m = 24;
      const apart =
        a.x - m > b.x + b.w + m ||
        b.x - m > a.x + a.w + m ||
        a.y - m > b.y + b.h + m ||
        b.y - m > a.y + a.h + m;
      if (apart) {
        for (let i = 0; i + 1 < g.points.length; i++) {
          const p = g.points[i]!;
          const q = g.points[i + 1]!;
          if (crosses(p, q, a) || crosses(p, q, b)) {
            throw new Error(
              `trial ${trial}: segment ${JSON.stringify([p, q])} crosses a shape; sides ${JSON.stringify([sa, sb])}`,
            );
          }
        }
      }
    }
  });

  it('goes around the target when both ends face the same way in a line (reported bug)', () => {
    // PostgreSQL box above a circle, both attached at their tops.
    const get = shapes(box('b', 10, 0, { w: 80, h: 100 }), box('a', 0, 300, { type: 'ellipse' }));
    const c = conn({
      route: 'elbow',
      start: { kind: 'element', id: 'a', anchor: { x: 0.5, y: 0 } },
      end: { kind: 'element', id: 'b', anchor: { x: 0.5, y: 0 } },
    });
    const g = resolveConnector(c, get)!;
    check(g.points, { x: 0, y: -1 }, { x: 0, y: -1 });
    for (let i = 0; i + 1 < g.points.length; i++) {
      expect(crosses(g.points[i]!, g.points[i + 1]!, get('b')!)).toBe(false);
      expect(crosses(g.points[i]!, g.points[i + 1]!, get('a')!)).toBe(false);
    }
  });
});

describe('routing around other shapes (scene)', () => {
  function lineCrossesShape(scene: Scene, id: string, shapeId: string): boolean {
    const g = scene.connectorGeometry(id)!;
    const s = scene.get(shapeId) as ShapeElement;
    for (let i = 0; i + 1 < g.points.length; i++)
      if (crosses(g.points[i]!, g.points[i + 1]!, s)) return true;
    return false;
  }

  function setup() {
    const scene = new Scene();
    scene.add(box('a', 0, 0));
    scene.add(box('b', 600, 0));
    scene.add(
      conn({
        route: 'elbow',
        start: { kind: 'element', id: 'a', anchor: { x: 1, y: 0.5 } },
        end: { kind: 'element', id: 'b', anchor: { x: 0, y: 0.5 } },
      }),
    );
    return scene;
  }

  it('detours around a shape placed in the way, and straightens when it leaves', () => {
    const scene = setup();
    expect(scene.connectorGeometry('c')!.points).toHaveLength(2); // straight
    scene.add(box('wall', 300, -40, { w: 60, h: 180 }));
    expect(lineCrossesShape(scene, 'c', 'wall')).toBe(false);
    expect(scene.connectorGeometry('c')!.points.length).toBeGreaterThan(2);

    scene.update('wall', { y: 1000 }); // moved away
    expect(scene.connectorGeometry('c')!.points).toHaveLength(2);

    scene.update('wall', { y: -40 }); // back in the way
    expect(lineCrossesShape(scene, 'c', 'wall')).toBe(false);
    scene.remove('wall');
    expect(scene.connectorGeometry('c')!.points).toHaveLength(2);
  });

  it('reports re-routed connectors as updated in the same batch', () => {
    const scene = setup();
    const events: SceneChanges[] = [];
    scene.subscribe((e) => events.push(e));
    scene.add(box('wall', 300, -40, { w: 60, h: 180 }));
    expect(events[0]!.updated.map((e) => e.id)).toContain('c');
  });

  it('keeps going around when the detour runs into more shapes', () => {
    const scene = setup();
    // A tall wall, and blockers right where a short detour above it would pass.
    scene.add(box('wall', 300, -150, { w: 60, h: 400 }));
    scene.add(box('cap', 200, -320, { w: 260, h: 120 }));
    for (const id of ['wall', 'cap', 'a', 'b'])
      expect(lineCrossesShape(scene, 'c', id)).toBe(false);
  });
});

describe('routing around other shapes: random scenes', () => {
  it('never runs through a shape it could avoid', () => {
    let seed = 11;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const SIDES = [
      { x: 0.5, y: 0 },
      { x: 1, y: 0.5 },
      { x: 0.5, y: 1 },
      { x: 0, y: 0.5 },
    ];
    const near = (s: ShapeElement, o: ShapeElement, m: number) =>
      !(o.x > s.x + s.w + m || o.x + o.w < s.x - m || o.y > s.y + s.h + m || o.y + o.h < s.y - m);
    let detoured = 0;
    for (let trial = 0; trial < 1000; trial++) {
      const scene = new Scene();
      const a = box('a', 0, 0, { w: 80 + rand() * 80, h: 60 + rand() * 80 });
      const b = box('b', 300 + rand() * 400, (rand() - 0.5) * 600, {
        w: 80 + rand() * 80,
        h: 60 + rand() * 80,
      });
      scene.add(a);
      scene.add(b);
      const others: ShapeElement[] = [];
      for (let k = 0; k < 6; k++) {
        const o = box(`o${k}`, -100 + rand() * 900, -400 + rand() * 800, {
          w: 30 + rand() * 120,
          h: 30 + rand() * 120,
        });
        // Shapes touching a connected shape's stub zone can't always be avoided: skip those.
        if (near(a, o, 30) || near(b, o, 30)) continue;
        scene.add(o);
        others.push(o);
      }
      scene.add(
        conn({
          route: 'elbow',
          start: { kind: 'element', id: 'a', anchor: SIDES[Math.floor(rand() * 4)] },
          end: { kind: 'element', id: 'b', anchor: SIDES[Math.floor(rand() * 4)] },
        }),
      );
      const g = scene.connectorGeometry('c')!;
      if (g.points.length > 2) detoured++;
      for (let i = 0; i + 1 < g.points.length; i++) {
        for (const o of others) {
          if (crosses(g.points[i]!, g.points[i + 1]!, o)) {
            throw new Error(
              `trial ${trial}: crosses ${o.id} ${JSON.stringify({ a, b, others, points: g.points, c: scene.get('c') })}`,
            );
          }
        }
      }
    }
    expect(detoured).toBeGreaterThan(150); // the scenes really exercise routing
  });
});
