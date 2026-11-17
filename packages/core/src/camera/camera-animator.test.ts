import { describe, expect, it } from 'vitest';
import { Camera } from './camera';
import { CameraAnimator, type FrameScheduler } from './camera-animator';

/** Manual scheduler: frames run only when the test calls `run`. */
function manual() {
  let queue: Array<(now: number) => void> = [];
  let now = 0;
  const scheduler: FrameScheduler = {
    request: (cb) => {
      queue.push(cb);
      return queue.length;
    },
    cancel: () => {
      queue = [];
    },
  };
  const run = (frames: number, dt = 16) => {
    for (let i = 0; i < frames && queue.length; i++) {
      const q = queue;
      queue = [];
      now += dt;
      for (const cb of q) cb(now);
    }
  };
  return { scheduler, run, pending: () => queue.length };
}

function setup(enabled = true) {
  const camera = new Camera();
  camera.setViewport(800, 600);
  const m = manual();
  const anim = new CameraAnimator(camera, { scheduler: m.scheduler, halfLifeMs: 80 });
  anim.enabled = enabled;
  return { camera, anim, ...m };
}

describe('CameraAnimator', () => {
  it('applies immediately when disabled', () => {
    const { camera, anim, pending } = setup(false);
    anim.zoomAt({ x: 100, y: 100 }, 2);
    expect(camera.zoom).toBe(2);
    anim.panBy(10, 0);
    expect(camera.x).toBeCloseTo(50 - 5);
    expect(pending()).toBe(0);
  });

  it('eases toward the target and lands exactly', () => {
    const { camera, anim, run } = setup();
    anim.zoomAt({ x: 0, y: 0 }, 4);
    run(1);
    expect(camera.zoom).toBeGreaterThan(1);
    expect(camera.zoom).toBeLessThan(4);
    run(200);
    expect(camera.zoom).toBe(4);
    expect(anim.animating).toBe(false);
  });

  it('keeps the world point under the zoom anchor fixed during the animation', () => {
    const { camera, anim, run } = setup();
    camera.set({ x: 37, y: -12, zoom: 1.3 });
    const anchor = { x: 300, y: 200 };
    const world = camera.screenToWorld(anchor);
    anim.zoomAt(anchor, 3);
    for (let i = 0; i < 20; i++) {
      run(1);
      const w = camera.screenToWorld(anchor);
      expect(w.x).toBeCloseTo(world.x, 6);
      expect(w.y).toBeCloseTo(world.y, 6);
    }
  });

  it('accumulates repeated wheel steps into one target', () => {
    const { camera, anim, run } = setup();
    for (let i = 0; i < 5; i++) anim.zoomAt({ x: 0, y: 0 }, 1.25);
    run(300);
    expect(camera.zoom).toBeCloseTo(Math.pow(1.25, 5));
  });

  it('flings with the release velocity and stops', () => {
    const { camera, anim, run } = setup();
    anim.fling(1000, 0); // 1000 px/s to the right
    run(1, 16);
    // Initial speed ≈ velocity: ~16px in the first 16ms frame (camera moves the other way).
    expect(-camera.x).toBeGreaterThan(10);
    expect(-camera.x).toBeLessThan(18);
    run(300);
    const tau = 0.08 / Math.LN2;
    expect(-camera.x).toBeCloseTo(1000 * tau, 0);
  });

  it('ignores tiny flings', () => {
    const { anim, pending } = setup();
    anim.fling(5, 0);
    expect(pending()).toBe(0);
  });

  it('stops on demand where the camera is', () => {
    const { camera, anim, run } = setup();
    anim.panBy(-400, 0);
    run(2);
    const x = camera.x;
    anim.stop();
    run(10);
    expect(camera.x).toBe(x);
  });

  it('fits a box', () => {
    const { camera, anim, run } = setup();
    anim.fitBox({ minX: 0, minY: 0, maxX: 1000, maxY: 1000 }, 0);
    run(300);
    expect(camera.zoom).toBeCloseTo(0.6);
    const c = camera.screenToWorld({ x: 400, y: 300 });
    expect(c.x).toBeCloseTo(500);
    expect(c.y).toBeCloseTo(500);
  });
});
