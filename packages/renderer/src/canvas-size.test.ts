import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasSize } from './canvas-size';

type Entry = Partial<ResizeObserverEntry>;
let fire: ((entries: Entry[]) => void) | null = null;
let observedBox: string | undefined;

class FakeResizeObserver {
  constructor(cb: (entries: Entry[]) => void) {
    fire = cb;
  }
  observe(_el: unknown, options?: { box?: string }) {
    observedBox = options?.box;
  }
  disconnect() {}
}

const canvas = () =>
  ({ clientWidth: 801, clientHeight: 600, width: 300, height: 150 }) as HTMLCanvasElement;

describe('CanvasSize', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.stubGlobal('window', { devicePixelRatio: 1.25 });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fire = null;
  });

  it('uses the exact device pixels at a fractional ratio, so nothing is resampled', () => {
    const c = canvas();
    const onChange = vi.fn();
    const size = new CanvasSize(c, onChange);
    expect(observedBox).toBe('device-pixel-content-box');
    // 800.8 CSS px at 125 %: the browser says it covers 1001 device pixels.
    fire!([
      {
        contentBoxSize: [{ inlineSize: 800.8, blockSize: 600 }],
        devicePixelContentBoxSize: [{ inlineSize: 1001, blockSize: 750 }],
      } as unknown as Entry,
    ]);
    expect(onChange).toHaveBeenCalledTimes(1);
    const m = size.measure(3);
    expect(m).toMatchObject({ pixelWidth: 1001, pixelHeight: 750, cssWidth: 800.8 });
    expect(m.ratio).toBeCloseTo(1001 / 800.8);
    expect(size.apply(m)).toBe(true);
    expect([c.width, c.height]).toEqual([1001, 750]);
    expect(size.apply(m)).toBe(false);
  });

  it('computes the buffer when the ratio is capped or fixed, or without the observer data', () => {
    const size = new CanvasSize(canvas(), () => undefined);
    // Nothing observed yet: from clientWidth.
    expect(size.measure(3)).toMatchObject({ pixelWidth: 1001, pixelHeight: 750 });
    fire!([
      {
        contentBoxSize: [{ inlineSize: 800, blockSize: 600 }],
        devicePixelContentBoxSize: [{ inlineSize: 1000, blockSize: 750 }],
      } as unknown as Entry,
    ]);
    expect(size.measure(1)).toMatchObject({ pixelWidth: 800, ratio: 1 }); // capped below the screen
    expect(size.measure(3, 2)).toMatchObject({ pixelWidth: 1600, ratio: 2 }); // fixed (export)
  });
});
