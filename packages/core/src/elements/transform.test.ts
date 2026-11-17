import { describe, expect, it } from 'vitest';
import type { ConnectorElement } from '../connectors';
import type { ShapeElement } from './element';
import { makeRect } from '../test-utils';
import {
  boxFrame,
  handlePoint,
  normalizeAngle,
  resizeCursor,
  resizeFrame,
  rotateElements,
  scaleElements,
  shapeFrame,
  snapAngle,
  translateElements,
  type Frame,
} from './transform';

const frame = (patch: Partial<Frame> = {}): Frame => ({
  cx: 50,
  cy: 50,
  w: 100,
  h: 100,
  rotation: 0,
  ...patch,
});

describe('resizeFrame', () => {
  it('drags a corner with the opposite corner fixed', () => {
    const f = resizeFrame(frame(), 'se', { x: 20, y: 40 });
    expect(f).toEqual({ cx: 60, cy: 70, w: 120, h: 140, rotation: 0 });
    const nw = resizeFrame(frame(), 'nw', { x: 10, y: 10 });
    expect(nw).toEqual({ cx: 55, cy: 55, w: 90, h: 90, rotation: 0 });
  });

  it('drags an edge along one axis only', () => {
    expect(resizeFrame(frame(), 'e', { x: 30, y: 999 })).toMatchObject({
      cx: 65,
      cy: 50,
      w: 130,
      h: 100,
    });
    expect(resizeFrame(frame(), 'n', { x: 999, y: -20 })).toMatchObject({
      cx: 50,
      cy: 40,
      w: 100,
      h: 120,
    });
  });

  it('keeps the aspect ratio and resizes from the center on request', () => {
    const f = frame({ w: 200, h: 100, cx: 100 });
    expect(resizeFrame(f, 'se', { x: 100, y: 10 }, { keepAspect: true })).toMatchObject({
      w: 300,
      h: 150,
    });
    expect(resizeFrame(f, 'e', { x: 100, y: 0 }, { keepAspect: true })).toMatchObject({
      w: 300,
      h: 150,
      cy: 50, // an edge keeps the other axis centered
    });
    expect(resizeFrame(f, 'e', { x: 20, y: 0 }, { fromCenter: true })).toMatchObject({
      cx: 100,
      w: 240,
    });
  });

  it('never flips or shrinks below the minimum', () => {
    const f = resizeFrame(frame(), 'se', { x: -500, y: -500 }, { minSize: 4 });
    expect(f.w).toBe(4);
    expect(f.h).toBe(4);
    expect(f.cx - f.w / 2).toBeCloseTo(0); // still anchored at the top-left
  });

  it('works in the frame of a rotated shape', () => {
    const f = frame({ rotation: Math.PI / 2 });
    // Rotated 90°: the frame's local +x points down in world space.
    const r = resizeFrame(f, 'e', { x: 20, y: 0 });
    expect(r.w).toBe(120);
    expect(r.cx).toBeCloseTo(50);
    expect(r.cy).toBeCloseTo(60);
    expect(handlePoint(r, 'e').y).toBeCloseTo(60 + 60); // center y + half the new width
    expect(handlePoint(r, 'w').y).toBeCloseTo(0); // the opposite edge didn't move
  });
});

describe('applying frames to elements', () => {
  it('gives a single shape exactly the new box', () => {
    const el = makeRect('a', { x: 10, y: 20, w: 100, h: 50, rotation: 0.3 });
    const to = resizeFrame(shapeFrame(el), 'se', { x: 20, y: 10 });
    const patch = scaleElements([el], shapeFrame(el), to).get('a')!;
    expect(patch.w).toBeCloseTo(120);
    expect(patch.h).toBeCloseTo(60);
    expect(patch.x! + patch.w! / 2).toBeCloseTo(to.cx);
  });

  it('scales a group: positions and sizes proportionally, free connector ends too', () => {
    const a = makeRect('a', { x: 0, y: 0, w: 100, h: 100 });
    const b = makeRect('b', { x: 200, y: 0, w: 100, h: 100 });
    const c: ConnectorElement = {
      id: 'c',
      type: 'connector',
      z: 1,
      start: { kind: 'element', id: 'a' },
      end: { kind: 'point', x: 300, y: 100 },
      route: 'straight',
      stroke: 0,
      strokeWidth: 2,
      dash: 'solid',
      startCap: 'none',
      endCap: 'arrow',
    };
    const from = boxFrame({ minX: 0, minY: 0, maxX: 300, maxY: 100 });
    const to = resizeFrame(from, 'se', { x: 300, y: 0 }); // twice as wide
    const patches = scaleElements([a, b, c], from, to);
    expect(patches.get('a')).toMatchObject({ x: 0, w: 200, h: 100 });
    expect(patches.get('b')).toMatchObject({ x: 400, w: 200 });
    expect(patches.get('c')).toEqual({
      start: { kind: 'element', id: 'a' }, // attached ends follow their shapes
      end: { kind: 'point', x: 600, y: 100 },
    });
  });

  it('rotates elements around a center, adding to their own rotation', () => {
    const a = makeRect('a', { x: 100, y: -50, w: 100, h: 100, rotation: 0.5 });
    const p = rotateElements([a], { x: 0, y: 0 }, Math.PI / 2).get('a') as Partial<ShapeElement>;
    // Center (150, 0) → (0, 150).
    expect(p.x! + 50).toBeCloseTo(0);
    expect(p.y! + 50).toBeCloseTo(150);
    expect(p.rotation).toBeCloseTo(0.5 + Math.PI / 2);
  });

  it('translates shapes and free connector ends', () => {
    const a = makeRect('a', { x: 5, y: 5 });
    expect(translateElements([a], 10, -1).get('a')).toEqual({ x: 15, y: 4 });
  });
});

describe('angles and cursors', () => {
  it('normalizes and snaps angles', () => {
    expect(normalizeAngle(Math.PI * 3)).toBeCloseTo(Math.PI);
    expect(normalizeAngle(-Math.PI * 1.5)).toBeCloseTo(Math.PI / 2);
    expect(snapAngle(0.27, Math.PI / 12)).toBeCloseTo(Math.PI / 12);
  });

  it('picks the resize cursor from the handle direction and rotation', () => {
    expect(resizeCursor('e', 0)).toBe('ew-resize');
    expect(resizeCursor('se', 0)).toBe('nwse-resize');
    expect(resizeCursor('ne', 0)).toBe('nesw-resize');
    expect(resizeCursor('n', 0)).toBe('ns-resize');
    expect(resizeCursor('e', Math.PI / 2)).toBe('ns-resize');
    expect(resizeCursor('e', Math.PI / 4)).toBe('nwse-resize');
  });
});
