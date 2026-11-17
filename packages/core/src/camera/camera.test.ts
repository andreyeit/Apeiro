import { describe, expect, it, vi } from 'vitest';
import { Camera } from './camera';

describe('Camera', () => {
  it('round-trips screen and world coordinates', () => {
    const cam = new Camera();
    cam.setViewport(800, 600);
    cam.set({ x: 100, y: -50, zoom: 2 });
    const world = cam.screenToWorld({ x: 40, y: 60 });
    expect(world).toEqual({ x: 120, y: -20 });
    expect(cam.worldToScreen(world)).toEqual({ x: 40, y: 60 });
  });

  it('keeps the anchor point fixed when zooming', () => {
    const cam = new Camera();
    cam.setViewport(800, 600);
    cam.set({ x: 10, y: 20, zoom: 1 });
    const anchor = { x: 300, y: 200 };
    const before = cam.screenToWorld(anchor);
    cam.zoomAt(anchor, 3.5);
    const after = cam.screenToWorld(anchor);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    expect(cam.zoom).toBe(3.5);
  });

  it('clamps zoom to the configured range', () => {
    const cam = new Camera({ minZoom: 0.1, maxZoom: 4 });
    cam.set({ zoom: 100 });
    expect(cam.zoom).toBe(4);
    cam.zoomAt({ x: 0, y: 0 }, 0.0001);
    expect(cam.zoom).toBe(0.1);
  });

  it('pans by screen delta independent of zoom', () => {
    const cam = new Camera();
    cam.set({ zoom: 4 });
    cam.panBy(40, -20);
    expect(cam.x).toBe(-10);
    expect(cam.y).toBe(5);
  });

  it('fits a box into the viewport', () => {
    const cam = new Camera();
    cam.setViewport(1000, 500);
    cam.fitBox({ minX: 0, minY: 0, maxX: 200, maxY: 200 }, 0);
    expect(cam.zoom).toBe(2.5);
    const vb = cam.viewportBounds();
    expect((vb.minX + vb.maxX) / 2).toBeCloseTo(100);
    expect((vb.minY + vb.maxY) / 2).toBeCloseTo(100);
  });

  it('notifies subscribers only on real changes', () => {
    const cam = new Camera();
    const spy = vi.fn();
    const off = cam.subscribe(spy);
    cam.set({ x: 0, y: 0, zoom: 1 });
    expect(spy).not.toHaveBeenCalled();
    cam.panBy(1, 0);
    expect(spy).toHaveBeenCalledTimes(1);
    off();
    cam.panBy(1, 0);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
