import { describe, expect, it } from 'vitest';
import { ColorTheme } from './color-theme';

describe('ColorTheme', () => {
  it('draws stored colors as stored until pairs are set', () => {
    const t = new ColorTheme();
    expect(t.of('rect', 0xffffffff)).toBe(0xffffffff);
  });

  it('swaps colors by RGB, keeps alpha, and leaves kept types and other colors alone', () => {
    const t = new ColorTheme();
    t.set(
      [
        [0xffffff, 0x0e0e10],
        [0x18181b, 0xf4f4f5],
      ],
      ['sticky'],
    );
    expect(t.of('rect', 0xffffffff)).toBe(0x0e0e10ff);
    expect(t.of('connector', 0x18181b80)).toBe(0xf4f4f580);
    expect(t.of('rect', 0x2563ebff)).toBe(0x2563ebff);
    expect(t.of('sticky', 0x18181bff)).toBe(0x18181bff);
    t.set([]);
    expect(t.of('rect', 0xffffffff)).toBe(0xffffffff);
  });
});
