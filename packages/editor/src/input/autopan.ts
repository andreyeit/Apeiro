import type { Vec2 } from '@apeiro/core';
import { AUTOPAN_EDGE_PX, AUTOPAN_MAX_SPEED } from './constants';
import type { InputContext } from './context';
import { isMovingMode } from './modes';

/**
 * Scrolls the board while a gesture drags near the viewport edges, faster the closer the
 * pointer is to the edge. `onStep` re-applies the gesture: the world under the pointer moved.
 */
export class AutoPan {
  private frame = 0;
  private last = 0;

  constructor(
    private readonly c: InputContext,
    private readonly onStep: (p: Vec2) => void,
  ) {}

  /** Starts panning if the pointer is at an edge during a moving gesture. */
  maybeStart(p: Vec2): void {
    if (this.frame || !isMovingMode(this.c.mode)) return;
    const v = this.velocity(p);
    if (v.x === 0 && v.y === 0) return;
    this.last = 0;
    this.frame = requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private readonly tick = (now: number): void => {
    this.frame = 0;
    const { pointer } = this.c;
    if (!pointer || !isMovingMode(this.c.mode)) return;
    const v = this.velocity(pointer);
    if (v.x === 0 && v.y === 0) return;
    const dt = this.last ? Math.min(now - this.last, 50) / 1000 : 1 / 60;
    this.last = now;
    this.c.camera.panBy(-v.x * dt, -v.y * dt);
    this.onStep(pointer);
    this.frame = requestAnimationFrame(this.tick);
  };

  /** Pan speed (screen px per second) for a pointer at `p`. */
  private velocity(p: Vec2): Vec2 {
    const r = this.c.el.getBoundingClientRect();
    if (r.width <= AUTOPAN_EDGE_PX * 2 || r.height <= AUTOPAN_EDGE_PX * 2) return { x: 0, y: 0 };
    const axis = (v: number, size: number) => {
      if (v < AUTOPAN_EDGE_PX) return -((AUTOPAN_EDGE_PX - v) / AUTOPAN_EDGE_PX);
      if (v > size - AUTOPAN_EDGE_PX) return (v - (size - AUTOPAN_EDGE_PX)) / AUTOPAN_EDGE_PX;
      return 0;
    };
    const k = (t: number) => Math.sign(t) * Math.min(1, Math.abs(t)) ** 2 * AUTOPAN_MAX_SPEED;
    return { x: k(axis(p.x, r.width)), y: k(axis(p.y, r.height)) };
  }
}
