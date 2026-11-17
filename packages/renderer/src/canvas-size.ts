/** A canvas's size on the page and the drawing buffer that matches it. */
export interface CanvasMetrics {
  /** CSS size (may be fractional). */
  cssWidth: number;
  cssHeight: number;
  /** Drawing buffer size, device pixels. */
  pixelWidth: number;
  pixelHeight: number;
  /** Device pixels per CSS pixel actually used: `pixelWidth / cssWidth`. */
  ratio: number;
}

/**
 * Keeps track of the exact number of device pixels a canvas covers, so its drawing buffer
 * maps 1:1 onto the screen and nothing gets resampled (blurred).
 *
 * `clientWidth * devicePixelRatio` is not enough: `clientWidth` is rounded to whole CSS
 * pixels and fractional ratios (125 %, 150 % screen scaling, browser zoom) land between
 * device pixels, so the browser stretches the buffer by a fraction of a pixel. The
 * `device-pixel-content-box` of a ResizeObserver reports the real size; browsers without
 * it (Safari) fall back to the computed one.
 */
export class CanvasSize {
  private observer: ResizeObserver | null = null;
  private css: { w: number; h: number } | null = null;
  private device: { w: number; h: number } | null = null;

  /**
   * @param onChange called when the size or the pixel ratio changed (also when the window
   *   moves to a screen with another ratio).
   */
  constructor(
    private readonly canvas: HTMLCanvasElement,
    onChange: () => void,
  ) {
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const box = entry.contentBoxSize?.[0];
      if (box) this.css = { w: box.inlineSize, h: box.blockSize };
      const px = entry.devicePixelContentBoxSize?.[0];
      this.device = px ? { w: px.inlineSize, h: px.blockSize } : null;
      onChange();
    });
    try {
      observer.observe(canvas, { box: 'device-pixel-content-box' });
    } catch {
      observer.observe(canvas); // no device-pixel-content-box: computed sizes
    }
    this.observer = observer;
  }

  /**
   * The canvas's size now and the buffer to draw into, for a pixel ratio of at most
   * `maxRatio`, or exactly `fixedRatio` (e.g. 1 for an export).
   */
  measure(maxRatio: number, fixedRatio: number | null = null): CanvasMetrics {
    const cssWidth = this.css?.w ?? this.canvas.clientWidth;
    const cssHeight = this.css?.h ?? this.canvas.clientHeight;
    const screen = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const ratio = fixedRatio ?? Math.min(screen, maxRatio);
    // The screen's own pixels when they are what we draw at (not capped, not fixed).
    const exact = this.device && fixedRatio === null && screen <= maxRatio + 1e-6;
    const pixelWidth = Math.max(1, exact ? this.device!.w : Math.round(cssWidth * ratio));
    const pixelHeight = Math.max(1, exact ? this.device!.h : Math.round(cssHeight * ratio));
    return {
      cssWidth,
      cssHeight,
      pixelWidth,
      pixelHeight,
      ratio: cssWidth > 0 ? pixelWidth / cssWidth : ratio,
    };
  }

  /** Sets the canvas's drawing buffer to the measured size; true if it changed. */
  apply(metrics: CanvasMetrics): boolean {
    if (this.canvas.width === metrics.pixelWidth && this.canvas.height === metrics.pixelHeight)
      return false;
    this.canvas.width = metrics.pixelWidth;
    this.canvas.height = metrics.pixelHeight;
    return true;
  }

  dispose(): void {
    this.observer?.disconnect();
    this.observer = null;
  }
}

/** Default cap of the pixel ratio: the screen's own up to 3x (phones), not more. */
export const MAX_PIXEL_RATIO = 3;
