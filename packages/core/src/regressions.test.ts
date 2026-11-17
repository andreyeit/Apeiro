import { describe, expect, it } from 'vitest';
import { Camera } from './camera/camera';
import { CameraAnimator, type FrameScheduler } from './camera/camera-animator';
import type { ConnectorElement } from './connectors';
import type { ShapeElement } from './elements/element';
import { validateElement } from './elements/validation';
import { computePeaks, isAllowedMediaSrc } from './elements/media';
import { Scene, type SceneChanges } from './scene/scene';
import { layoutText, type FontMeasurer } from './text/layout';
import { textBlock } from './text/text-block';
import { makeRect } from './test-utils';

const measurer: FontMeasurer = { advance: () => 0.6, ascent: 0.9, descent: 0.2 };

function elbow(id: string, from: string, to: string): ConnectorElement {
  return {
    id,
    type: 'connector',
    z: 1e6,
    start: { kind: 'element', id: from },
    end: { kind: 'element', id: to },
    route: 'elbow',
    stroke: 0,
    strokeWidth: 2,
    dash: 'solid',
    startCap: 'none',
    endCap: 'none',
  };
}

describe('Scene: re-adding an element in the same batch', () => {
  it('reports a z change as a paint order change', () => {
    const scene = new Scene();
    scene.add(makeRect('a', { z: 1 }));
    scene.add(makeRect('b', { z: 2 }));
    let last: SceneChanges | undefined;
    scene.subscribe((c) => (last = c));
    scene.transact(() => {
      scene.remove('a');
      scene.add(makeRect('a', { z: 5 }));
    });
    expect(last!.updated.map((e) => e.id)).toEqual(['a']);
    expect(last!.orderChanged).toBe(true);
  });

  it('keeps orderChanged false when the re-added element has the same z and type', () => {
    const scene = new Scene();
    scene.add(makeRect('a', { z: 1 }));
    let last: SceneChanges | undefined;
    scene.subscribe((c) => (last = c));
    scene.transact(() => {
      scene.remove('a');
      scene.add(makeRect('a', { z: 1, x: 50 }));
    });
    expect(last!.orderChanged).toBe(false);
  });
});

describe('Scene: validation', () => {
  it('rejects non-finite geometry on add and update, changing nothing', () => {
    const scene = new Scene();
    expect(() => scene.add(makeRect('n', { x: NaN }))).toThrow(/x must be finite/);
    expect(scene.has('n')).toBe(false);
    scene.add(makeRect('a'));
    expect(() => scene.update('a', { w: Infinity })).toThrow();
    expect((scene.get('a') as ShapeElement).w).toBe(100);
    expect(() => scene.update('a', { w: -1 })).toThrow();
  });

  it('rejects broken text and connector ends', () => {
    expect(validateElement(makeRect('t', { text: { ...textBlock('x'), fontSize: 0 } }))).toMatch(
      /fontSize/,
    );
    const c = elbow('c', 'a', 'b');
    expect(validateElement(c)).toBeNull();
    expect(validateElement({ ...c, start: { kind: 'point', x: NaN, y: 0 } })).toMatch(/start/);
    expect(validateElement({ ...c, route: 'zigzag' as never })).toMatch(/route/);
  });

  it('cannot change id or type through a patch', () => {
    const scene = new Scene();
    scene.add(makeRect('a'));
    scene.update('a', { id: 'b', type: 'connector' } as never);
    expect(scene.get('a')?.type).toBe('rect');
    expect(scene.has('b')).toBe(false);
  });
});

describe('Scene: listeners and caches', () => {
  it('notifies every listener even if one throws, then rethrows', () => {
    const scene = new Scene();
    const seen: number[] = [];
    let fail = true;
    scene.subscribe(() => {
      if (fail) {
        fail = false;
        throw new Error('boom');
      }
    });
    scene.subscribe((c) => seen.push(c.added.length));
    expect(() => scene.add(makeRect('a'))).toThrow('boom');
    expect(seen).toEqual([1]);
    scene.add(makeRect('b')); // the scene is still consistent
    expect(seen).toEqual([1, 1]);
  });

  it('keeps maxZ right through adds, z changes and removals', () => {
    const scene = new Scene();
    expect(scene.maxZ()).toBe(0);
    scene.add(makeRect('a', { z: 3 }));
    scene.add(makeRect('b', { z: 7 }));
    expect(scene.maxZ()).toBe(7);
    scene.update('b', { z: 2 });
    expect(scene.maxZ()).toBe(3);
    scene.update('a', { z: 10 });
    expect(scene.maxZ()).toBe(10);
    scene.remove('a');
    expect(scene.maxZ()).toBe(2);
    scene.clear();
    expect(scene.maxZ()).toBe(0);
  });

  it('freezes stored elements when asked to', () => {
    const scene = new Scene({ freeze: true });
    const el = makeRect('a', { text: textBlock('hi') });
    scene.add(el);
    const stored = scene.get('a') as ShapeElement;
    expect(() => {
      (stored as { x: number }).x = 5;
    }).toThrow();
    expect(() => stored.text!.runs.push({ text: '!' })).toThrow();
  });
});

describe('elbow routing on a dense board', () => {
  it('stays fast with thousands of irregularly placed shapes in the way', () => {
    const scene = new Scene();
    const n = 45;
    scene.transact(() => {
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++)
          scene.add(
            makeRect(`r${i}_${j}`, {
              x: i * 160 + ((i * 7919 + j * 104729) % 37),
              y: j * 160 + ((i * 104729 + j * 7919) % 41),
            }),
          );
    });
    let t = performance.now();
    scene.add(elbow('c', 'r0_0', `r${n - 1}_${n - 1}`));
    expect(scene.connectorGeometry('c')).not.toBeNull();
    const addMs = performance.now() - t;
    t = performance.now();
    scene.update('r1_1', { x: 170 });
    scene.connectorGeometry('c');
    const moveMs = performance.now() - t;
    // Before the obstacle cap this took ~10 s each.
    expect(addMs).toBeLessThan(1000);
    expect(moveMs).toBeLessThan(1000);
  });
});

describe('text and camera edge cases', () => {
  it('autoFit never makes text larger than its font size', () => {
    const block = {
      ...textBlock('hello world hello world hello world'),
      fontSize: 4,
      autoFit: true,
    };
    expect(layoutText(block, 20, 10, measurer).fontSize).toBeLessThanOrEqual(4);
  });

  it('treats a lone \\r as a line break and \\r\\n split across runs as one', () => {
    const lines = (runs: Array<{ text: string }>) =>
      layoutText({ ...textBlock(''), runs }, 1000, 1000, measurer).lineCount;
    expect(lines([{ text: 'a\rb' }])).toBe(2);
    expect(lines([{ text: 'a\r' }, { text: '\nb' }])).toBe(2);
    expect(lines([{ text: 'a\r\nb' }])).toBe(2);
  });

  it('animateTo beyond the zoom range settles instead of animating forever', () => {
    const camera = new Camera({ maxZoom: 4 });
    camera.setViewport(800, 600);
    const queue: Array<(now: number) => void> = [];
    const scheduler: FrameScheduler = {
      request: (cb) => queue.push(cb),
      cancel: () => undefined,
    };
    const animator = new CameraAnimator(camera, { scheduler });
    animator.enabled = true;
    animator.animateTo({ zoom: 100 });
    let now = 0;
    for (let i = 0; i < 1000 && queue.length > 0; i++) queue.shift()!((now += 16));
    expect(animator.animating).toBe(false);
    expect(camera.zoom).toBe(4);
  });

  it('ignores non-finite camera states and rejects an empty zoom range', () => {
    const camera = new Camera();
    camera.set({ x: NaN, zoom: 2 });
    expect(camera.x).toBe(0);
    expect(camera.zoom).toBe(1);
    expect(() => new Camera({ minZoom: 0 })).toThrow();
  });
});

describe('media helpers', () => {
  it('allows only blob:, data: media, the page origin and listed origins', () => {
    const page = 'https://board.example';
    expect(isAllowedMediaSrc('blob:https://board.example/123', [], page)).toBe(true);
    expect(isAllowedMediaSrc('data:image/png;base64,AAAA', [], page)).toBe(true);
    expect(isAllowedMediaSrc('data:text/html,<script>', [], page)).toBe(false);
    expect(isAllowedMediaSrc('/files/a.png', [], page)).toBe(true);
    expect(isAllowedMediaSrc('https://evil.example/pixel.gif', [], page)).toBe(false);
    expect(isAllowedMediaSrc('https://cdn.example/a.png', ['https://cdn.example'], page)).toBe(
      true,
    );
    expect(isAllowedMediaSrc('javascript:alert(1)', [], page)).toBe(false);
    expect(isAllowedMediaSrc('http://192.168.0.1/admin', [], page)).toBe(false);
  });

  it('computes peaks for very many bars without overflowing the stack', () => {
    const data = new Float32Array(300_000).map((_, i) => Math.sin(i));
    const peaks = computePeaks([data], 300_000);
    expect(peaks).toHaveLength(300_000);
    expect(Math.max(...peaks.slice(0, 1000))).toBeLessThanOrEqual(1);
  });
});
