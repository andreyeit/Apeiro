import type { Camera, CameraState } from './camera';
import { clamp, type Box, type Vec2 } from '../geometry/math';

export interface FrameScheduler {
  request(cb: (now: number) => void): number;
  cancel(handle: number): void;
}

const defaultScheduler: FrameScheduler = {
  request: (cb) => requestAnimationFrame(cb),
  cancel: (h) => cancelAnimationFrame(h),
};

export interface CameraAnimatorOptions {
  /** Time for the camera to cover half the remaining distance. Smaller = snappier. */
  halfLifeMs?: number;
  scheduler?: FrameScheduler;
}

/**
 * Smooth camera on top of `Camera`. When `enabled`, zoom/pan requests move a target
 * and the camera eases toward it each frame (exponential smoothing, frame-rate
 * independent). When disabled, requests apply immediately, so callers can always
 * go through the animator.
 *
 * Zoom keeps the world point under the zoom anchor fixed during the whole animation,
 * not only at the end, so zooming at the cursor doesn't "swim".
 */
export class CameraAnimator {
  enabled = false;
  halfLifeMs: number;
  private target: CameraState | null = null;
  /** Screen point that stays fixed while zooming. */
  private anchor: Vec2 = { x: 0, y: 0 };
  private frame = 0;
  private last = 0;
  private readonly scheduler: FrameScheduler;

  constructor(
    private readonly camera: Camera,
    options: CameraAnimatorOptions = {},
  ) {
    this.halfLifeMs = options.halfLifeMs ?? 80;
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  get animating(): boolean {
    return this.target !== null;
  }

  /** Zooms by `factor` around a screen point. */
  zoomAt(anchor: Vec2, factor: number): void {
    if (!this.enabled) {
      this.camera.zoomAt(anchor, this.camera.zoom * factor);
      return;
    }
    const from = this.target ?? this.camera.getState();
    const zoom = clamp(from.zoom * factor, this.camera.minZoom, this.camera.maxZoom);
    // World point under the anchor in the target state stays under the anchor.
    const wx = from.x + anchor.x / from.zoom;
    const wy = from.y + anchor.y / from.zoom;
    this.anchor = anchor;
    this.animate({ zoom, x: wx - anchor.x / zoom, y: wy - anchor.y / zoom });
  }

  /** Moves the view by a screen-space delta. */
  panBy(dx: number, dy: number): void {
    if (!this.enabled) {
      this.camera.panBy(dx, dy);
      return;
    }
    const from = this.target ?? this.camera.getState();
    this.animate({ ...from, x: from.x - dx / from.zoom, y: from.y - dy / from.zoom });
  }

  /**
   * Continues a released drag with its velocity (screen px per second), decaying
   * smoothly. The distance matches the velocity at release for this half-life.
   */
  fling(vx: number, vy: number): void {
    if (!this.enabled) return;
    const tau = this.halfLifeMs / 1000 / Math.LN2; // time constant of the decay, seconds
    if (Math.hypot(vx, vy) * tau < 2) return; // not worth a frame
    this.panBy(vx * tau, vy * tau);
  }

  /** Moves to a state (animated when enabled). */
  animateTo(state: Partial<CameraState>, anchor?: Vec2): void {
    const cur = this.camera.getState();
    const next = { ...cur, ...state };
    if (!this.enabled) {
      this.camera.set(next);
      return;
    }
    this.anchor = anchor ?? { x: this.camera.viewportWidth / 2, y: this.camera.viewportHeight / 2 };
    this.animate(next);
  }

  /** Fits a world box into the viewport (animated when enabled). */
  fitBox(box: Box, padding = 32): void {
    this.animateTo(this.camera.fitState(box, padding));
  }

  /** Stops where the camera is now (e.g. when the user grabs the canvas). */
  stop(): void {
    this.target = null;
    if (this.frame) this.scheduler.cancel(this.frame);
    this.frame = 0;
  }

  /** Advances the animation by `dtMs`. Exposed for tests; normally driven by the scheduler. */
  step(dtMs: number): void {
    const t = this.target;
    if (!t) return;
    const cur = this.camera.getState();
    const k = 1 - Math.pow(0.5, dtMs / this.halfLifeMs);
    const zoom = Math.exp(Math.log(cur.zoom) + (Math.log(t.zoom) - Math.log(cur.zoom)) * k);
    // Interpolate the world point under the anchor, then place the camera so it stays there.
    const a = this.anchor;
    const wx = cur.x + a.x / cur.zoom;
    const wy = cur.y + a.y / cur.zoom;
    const twx = t.x + a.x / t.zoom;
    const twy = t.y + a.y / t.zoom;
    const nwx = wx + (twx - wx) * k;
    const nwy = wy + (twy - wy) * k;
    let next = { zoom, x: nwx - a.x / zoom, y: nwy - a.y / zoom };
    // Close enough (sub-pixel on screen): land exactly.
    const done =
      Math.abs(Math.log(t.zoom / zoom)) < 1e-4 &&
      Math.abs(next.x - t.x) * zoom < 0.25 &&
      Math.abs(next.y - t.y) * zoom < 0.25;
    if (done) {
      next = t;
      this.target = null;
    }
    this.camera.set(next);
  }

  private animate(requested: CameraState): void {
    // The camera clamps zoom; an unreachable target would keep the animation running forever.
    if (![requested.x, requested.y, requested.zoom].every(Number.isFinite) || requested.zoom <= 0)
      return;
    const zoom = clamp(requested.zoom, this.camera.minZoom, this.camera.maxZoom);
    let target = requested;
    if (zoom !== requested.zoom) {
      // Keep the world point under the anchor where the requested state would have put it.
      const a = this.anchor;
      const wx = requested.x + a.x / requested.zoom;
      const wy = requested.y + a.y / requested.zoom;
      target = { zoom, x: wx - a.x / zoom, y: wy - a.y / zoom };
    }
    this.target = target;
    if (this.frame) return;
    this.last = 0;
    const tick = (now: number) => {
      this.frame = 0;
      const dt = this.last ? Math.min(now - this.last, 64) : 16;
      this.last = now;
      this.step(dt);
      if (this.target) this.frame = this.scheduler.request(tick);
    };
    this.frame = this.scheduler.request(tick);
  }
}
