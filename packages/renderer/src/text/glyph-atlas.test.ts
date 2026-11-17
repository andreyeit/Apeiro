import { describe, expect, it } from 'vitest';
import { GlyphAtlas, type RasterGlyph } from './glyph-atlas';

const bitmap = (fill: number, w = 10, h = 12, channels = 1): RasterGlyph => ({
  data: new Uint8ClampedArray(w * h * channels).fill(fill),
  width: w,
  height: h,
  left: -1,
  top: 10,
});
const empty: RasterGlyph = { data: new Uint8ClampedArray(0), width: 0, height: 0, left: 0, top: 0 };

describe('GlyphAtlas', () => {
  it('stores glyphs by key with metrics', () => {
    const atlas = new GlyphAtlas({ channels: 1, initialSize: 64 });
    expect(atlas.peek('a')).toBeUndefined();
    const a = atlas.insert('a', bitmap(97), 48);
    expect(atlas.peek('a')).toBe(a);
    expect(a).toMatchObject({ left: -1, top: 10, rasterSize: 48, width: 10, height: 12 });
  });

  it('copies bitmaps without overlap', () => {
    const atlas = new GlyphAtlas({ channels: 1, initialSize: 64, maxSize: 64 });
    const a = atlas.insert('a', bitmap(97), 8);
    const b = atlas.insert('b', bitmap(98), 8);
    const overlap =
      a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    expect(overlap).toBe(false);
    expect(atlas.data[a.y * atlas.size + a.x]).toBe(97);
    expect(atlas.data[b.y * atlas.size + b.x]).toBe(98);
  });

  it('handles RGBA bitmaps', () => {
    const atlas = new GlyphAtlas({ channels: 4, initialSize: 32 });
    const g = atlas.insert('e', bitmap(7, 4, 4, 4), 8);
    expect(atlas.data.length).toBe(32 * 32 * 4);
    expect(atlas.data[(g.y * 32 + g.x) * 4 + 3]).toBe(7);
    expect(atlas.data[((g.y + 3) * 32 + g.x + 3) * 4]).toBe(7);
  });

  it('stores whitespace as empty glyphs', () => {
    const atlas = new GlyphAtlas({ channels: 1 });
    expect(atlas.insert(' ', empty, 8).width).toBe(0);
  });

  it('grows while keeping existing glyphs valid', () => {
    const atlas = new GlyphAtlas({ channels: 1, initialSize: 32, maxSize: 128 });
    const first = atlas.insert('a', bitmap(97), 8);
    for (let i = 0; i < 20; i++) atlas.insert(`g${i}`, bitmap(1), 8);
    expect(atlas.size).toBeGreaterThan(32);
    expect(atlas.generation).toBe(0);
    expect(atlas.data[first.y * atlas.size + first.x]).toBe(97);
  });

  it('resets when full at max size and bumps the generation', () => {
    const atlas = new GlyphAtlas({ channels: 1, initialSize: 32, maxSize: 32 });
    for (let i = 0; i < 20; i++) atlas.insert(`g${i}`, bitmap(1), 8);
    expect(atlas.generation).toBeGreaterThan(0);
    expect(atlas.size).toBe(32);
  });

  it('tracks incremental uploads after the first full one', () => {
    const atlas = new GlyphAtlas({ channels: 1, initialSize: 64 });
    expect(atlas.takeUploads().full).toBe(true);
    atlas.insert('x', bitmap(1), 8);
    const up = atlas.takeUploads();
    expect(up.full).toBe(false);
    expect(up.rects).toHaveLength(1);
    expect(atlas.takeUploads().rects).toHaveLength(0);
    atlas.markFullUpload();
    expect(atlas.takeUploads().full).toBe(true);
  });

  it('stores bitmaps larger than the atlas as empty glyphs instead of throwing', () => {
    const atlas = new GlyphAtlas({ channels: 1, initialSize: 16, maxSize: 16 });
    const info = atlas.insert('huge', bitmap(1, 40, 40), 8);
    expect(info.width).toBe(0);
    expect(info.height).toBe(0);
    expect(atlas.peek('huge')).toBe(info);
    expect(atlas.generation).toBe(0); // nothing was reset to make room
  });
});
