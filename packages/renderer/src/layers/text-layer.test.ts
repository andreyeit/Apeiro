import { describe, expect, it, vi } from 'vitest';
import { Scene, textBlock, type ShapeElement, type FontMeasurer } from '@apeiro/core';
import { GlyphAtlas, type RasterGlyph } from '../text/glyph-atlas';
import {
  GLYPH_STRIDE,
  MODE_COLOR,
  MODE_SDF,
  MODE_SOLID,
  SDF_TIERS,
  TextLayer,
  pickTier,
} from './text-layer';
import { ColorTheme } from '../color-theme';
import { textDepth } from '../depth';

const FLOATS = GLYPH_STRIDE / 4;
const measurer: FontMeasurer = { advance: () => 0.5, ascent: 0.8, descent: 0.2 };
const raster = (size: number, channels = 1): RasterGlyph => {
  const s = Math.max(4, Math.round(size / 4));
  return { data: new Uint8Array(s * s * channels).fill(200), width: s, height: s, left: 0, top: s };
};

function setup(options: ConstructorParameters<typeof TextLayer>[4] = {}) {
  const sdf = vi.fn((_c: string, _v: number, size: number) => raster(size));
  const color = vi.fn((_c: string, _v: number, size: number) => raster(size, 4));
  const sdfAtlas = new GlyphAtlas({ channels: 1, initialSize: 256 });
  const colorAtlas = new GlyphAtlas({ channels: 4, initialSize: 256 });
  const layer = new TextLayer(
    sdfAtlas,
    colorAtlas,
    measurer,
    { sdf, color },
    { budgetMs: 1e9, budgetUnits: 1e9, ...options },
  );
  const scene = new Scene();
  const slots = new Map<string, number>();
  const slotOf = (id: string) => slots.get(id);
  const add = (el: ShapeElement) => {
    scene.add(el);
    slots.set(el.id, slots.size);
  };
  const update = (v = view(0, 400), zoom = 1, dpr = 1) => layer.update(scene, v, zoom, dpr, slotOf);
  return { scene, layer, add, update, sdf, color, sdfAtlas, slots };
}

const sticky = (
  id: string,
  x: number,
  text: string,
  patch: Partial<ShapeElement> = {},
): ShapeElement => ({
  id,
  type: 'sticky',
  x,
  y: 0,
  w: 200,
  h: 200,
  rotation: 0,
  z: 0,
  fill: 0xffff00ff,
  stroke: 0,
  strokeWidth: 0,
  radius: 0,
  text: textBlock(text, { fontSize: 20 }),
  ...patch,
});

const view = (minX: number, maxX: number) => ({ minX, minY: 0, maxX, maxY: 200 });
const modes = (layer: TextLayer) => {
  const f32 = new Float32Array(layer.data);
  return Array.from({ length: layer.count }, (_, i) => f32[i * FLOATS + 12]);
};

describe('TextLayer', () => {
  it('rebuilds polygon text after changing the number of sides', () => {
    const { scene, layer, add, update } = setup();
    add(sticky('polygon', 0, 'a polygon with several words', { type: 'polygon', sides: 3 }));
    scene.subscribe((changes) => layer.applyChanges(changes));
    update();
    layer.takeUpload();
    const previous = layer.layoutOf(scene.get('polygon') as ShapeElement);
    scene.update('polygon', { sides: 6 });
    update();
    expect(layer.takeUpload().kind).toBe('all');
    expect(layer.layoutOf(scene.get('polygon') as ShapeElement)).not.toBe(previous);
  });

  it('builds glyphs only for elements near the viewport', () => {
    const { layer, add, update } = setup();
    add(sticky('near', 0, 'abc'));
    add(sticky('far', 100_000, 'defg'));
    update();
    expect(layer.count).toBe(3);
    expect(modes(layer)).toEqual([MODE_SDF, MODE_SDF, MODE_SDF]);
  });

  it('draws line bars instead of glyphs when text is tiny, and nothing when invisible', () => {
    const { layer, add, update } = setup();
    add(sticky('a', 0, 'abc'));
    update(view(0, 4000), 0.1); // 20 * 0.1 = 2px: greeking
    expect(modes(layer)).toEqual([MODE_SOLID]);
    update(view(0, 40000), 0.01); // 0.2px: nothing
    expect(layer.count).toBe(0);
  });

  it('picks a raster tier from the on-screen size, including DPR', () => {
    expect(pickTier(SDF_TIERS, 10)).toBe(0);
    expect(pickTier(SDF_TIERS, 50)).toBe(1);
    expect(pickTier(SDF_TIERS, 5000)).toBe(SDF_TIERS.length - 1);
    expect(pickTier(SDF_TIERS, 5000, 2)).toBe(2);

    const { add, update, sdf } = setup();
    add(sticky('a', 0, 'a'));
    update(view(0, 400), 1, 1); // 20 device px → tier 32
    update(view(0, 40), 10, 2); // 400 device px → tier 512
    expect(sdf.mock.calls.map((c) => c[2])).toEqual([32, 512]);
  });

  it('spreads rasterization over frames and falls back to available tiers', () => {
    const { layer, add, update, sdf } = setup({ budgetUnits: 0 }); // nothing fits the budget
    add(sticky('a', 0, 'ab'));
    update();
    expect(sdf).not.toHaveBeenCalled();
    expect(layer.needsMoreFrames).toBe(true);
    expect(layer.count).toBe(0);
  });

  it('routes emoji to the color atlas', () => {
    const { layer, add, update, color } = setup();
    add(sticky('a', 0, 'a👋'));
    update();
    expect(color).toHaveBeenCalledTimes(1);
    expect(modes(layer)).toEqual([MODE_SDF, MODE_COLOR]);
  });

  it('reuses the built region for small pans and rebuilds when leaving it', () => {
    const { layer, add, update } = setup();
    add(sticky('a', 0, 'abc'));
    update();
    layer.takeUpload();
    update(view(50, 450)); // inside the margin
    expect(layer.takeUpload().kind).toBe('none');
    update(view(5000, 5400));
    expect(layer.takeUpload().kind).toBe('all');
    expect(layer.count).toBe(0);
  });

  it('moves quads in place when an element is dragged', () => {
    const { scene, layer, add, update } = setup();
    add(sticky('a', 0, 'ab'));
    add(sticky('b', 300, 'cd'));
    update(view(0, 600));
    layer.takeUpload();
    const changes: Parameters<TextLayer['applyChanges']>[0][] = [];
    scene.subscribe((c) => changes.push(c));
    scene.update('b', { x: 350, rotation: 0.5 });
    layer.applyChanges(changes[0]!);
    const upload = layer.takeUpload();
    expect(upload).toEqual({ kind: 'ranges', runs: [[2, 4]] });
    const f32 = new Float32Array(layer.data);
    expect(f32[2 * FLOATS]).toBe(450); // new center x
    expect(f32[2 * FLOATS + 6]).toBeCloseTo(0.5);
    // No rebuild needed: the next update is a no-op.
    update(view(0, 600));
    expect(layer.takeUpload().kind).toBe('none');
  });

  it('rebuilds after text changes', () => {
    const { scene, layer, add, update } = setup();
    add(sticky('a', 0, 'abc'));
    update();
    const changes: Parameters<TextLayer['applyChanges']>[0][] = [];
    scene.subscribe((c) => changes.push(c));
    scene.update('a', { text: textBlock('abcdef', { fontSize: 20 }) });
    layer.applyChanges(changes[0]!);
    update();
    expect(layer.count).toBe(6);
  });

  it('hides quads of removed elements without a rebuild', () => {
    const { scene, layer, add, update } = setup();
    add(sticky('a', 0, 'ab'));
    update();
    layer.takeUpload();
    const changes: Parameters<TextLayer['applyChanges']>[0][] = [];
    scene.subscribe((c) => changes.push(c));
    scene.remove('a');
    layer.applyChanges(changes[0]!);
    expect(layer.takeUpload()).toEqual({ kind: 'ranges', runs: [[0, 2]] });
    expect(new Float32Array(layer.data)[4]).toBe(0); // width zeroed
  });

  it('hides text of elements being edited elsewhere', () => {
    const { layer, add, update } = setup();
    add(sticky('a', 0, 'abc'));
    layer.setHidden('a', true);
    update();
    expect(layer.count).toBe(0);
    layer.setHidden('a', false);
    update();
    expect(layer.count).toBe(3);
  });

  it('puts glyphs just in front of their own shape', () => {
    const { layer, add, update } = setup();
    add(sticky('a', 0, 'x'));
    add(sticky('b', 300, 'y'));
    update(view(0, 600));
    const f32 = new Float32Array(layer.data);
    const depths = [f32[7], f32[FLOATS + 7]].sort();
    expect(depths).toEqual([textDepth(1), textDepth(0)].map((d) => Math.fround(d)).sort());
  });

  it('caches layouts by text block and size', () => {
    const { scene, layer, add } = setup();
    add(sticky('a', 0, 'abc'));
    const first = layer.layoutOf(scene.get('a')! as ShapeElement);
    scene.update('a', { x: 50 }); // geometry-only change keeps the TextBlock reference
    expect(layer.layoutOf(scene.get('a')! as ShapeElement)).toBe(first);
    scene.update('a', { w: 300 });
    expect(layer.layoutOf(scene.get('a')! as ShapeElement)).not.toBe(first);
  });

  it('makes progress every frame even when iterating prepared text is slow', () => {
    const { layer, add, update } = setup({ budgetMs: 1e9, budgetUnits: 2 });
    for (let i = 0; i < 6; i++) add(sticky(`e${i}`, i * 10, 'a'));
    // Each frame: 1 layout + 1 glyph (tier 32 = 1 unit) or 2 layouts.
    let frames = 0;
    do {
      update(view(0, 400));
      frames++;
    } while (layer.needsMoreFrames && frames < 20);
    expect(layer.needsMoreFrames).toBe(false);
    expect(layer.count).toBe(6);
    expect(frames).toBeGreaterThan(1);
  });

  it('bounds the layout cache', () => {
    const { scene, layer, add } = setup({ layoutCacheSize: 2 });
    for (let i = 0; i < 3; i++) add(sticky(`e${i}`, i * 300, 'x'));
    const first = layer.layoutOf(scene.get('e0')! as ShapeElement);
    layer.layoutOf(scene.get('e1')! as ShapeElement);
    layer.layoutOf(scene.get('e2')! as ShapeElement); // evicts e0
    expect(layer.layoutOf(scene.get('e0')! as ShapeElement)).not.toBe(first);
  });

  it('respects the quad budget', () => {
    const { layer, add, update } = setup({ maxQuads: 5 });
    add(sticky('a', 0, 'abcdefghij'));
    update();
    expect(layer.count).toBe(5);
  });

  describe('quads kept between builds', () => {
    const colorAt = (layer: TextLayer, i: number) => [
      ...new Uint8Array(layer.data, i * GLYPH_STRIDE + 52, 4),
    ];

    it('copies unchanged text instead of looking glyphs up again', () => {
      const { layer, add, update, sdfAtlas } = setup();
      add(sticky('a', 0, 'abc'));
      update();
      const before = [...new Float32Array(layer.data, 0, layer.count * FLOATS)];
      const peek = vi.spyOn(sdfAtlas, 'peek');
      layer.markDirty();
      update();
      update(view(0, 400), 1.3); // rebuilt for the zoom, same raster tier
      expect(peek).not.toHaveBeenCalled();
      expect([...new Float32Array(layer.data, 0, layer.count * FLOATS)]).toEqual(before);
    });

    it('patches copied quads when the element moved or changed paint order', () => {
      const { scene, layer, add, update, slots } = setup();
      add(sticky('a', 0, 'ab'));
      update();
      scene.update('a', { x: 40, rotation: 0.25 }); // not reported: only a rebuild sees it
      slots.set('a', 7);
      layer.markDirty();
      update();
      const f32 = new Float32Array(layer.data);
      for (let i = 0; i < layer.count; i++) {
        expect(f32[i * FLOATS]).toBe(140);
        expect(f32[i * FLOATS + 6]).toBeCloseTo(0.25);
        expect(f32[i * FLOATS + 7]).toBe(Math.fround(textDepth(7)));
      }
    });

    it('builds again for another raster tier, colour theme or atlas contents', () => {
      const { layer, add, update, sdf, sdfAtlas } = setup();
      add(sticky('a', 0, 'a'));
      update();
      const stored = colorAt(layer, 0);
      const rgb = (stored[0]! << 16) | (stored[1]! << 8) | stored[2]!;
      const theme = new ColorTheme();
      theme.set([[rgb, 0x123456]]);
      layer.theme = theme;
      layer.markDirty();
      update();
      expect(colorAt(layer, 0)).toEqual([0x12, 0x34, 0x56, stored[3]]);

      sdf.mockClear();
      sdfAtlas.reset();
      update();
      expect(sdf).toHaveBeenCalledOnce(); // rasterized again into the new atlas

      update(view(0, 40), 10, 2); // 400 device px: tier 512
      expect(sdf.mock.calls.at(-1)?.[2]).toBe(512);
    });

    it('does not keep glyphs borrowed from another tier', () => {
      const { layer, add, update, sdf } = setup();
      add(sticky('a', 0, 'a'));
      update(); // tier 32 in the atlas
      layer.options.budgetUnits = 0;
      update(view(0, 40), 10, 2); // wants 512, draws the 32 one for now
      expect(layer.needsMoreFrames).toBe(true);
      expect(sdf.mock.calls.map((c) => c[2])).toEqual([32]);
      layer.options.budgetUnits = 1e9;
      update(view(0, 40), 10, 2);
      expect(sdf.mock.calls.map((c) => c[2])).toEqual([32, 512]);
      expect(layer.needsMoreFrames).toBe(false);
    });

    it('finishes text left over by the frame budget without building the rest again', () => {
      const { layer, add, update } = setup({ budgetUnits: 2 });
      for (let i = 0; i < 6; i++) add(sticky(`e${i}`, i * 10, 'a'));
      update();
      expect(layer.takeUpload().kind).toBe('all');
      const first = layer.count;
      expect(layer.needsMoreFrames).toBe(true);
      update(); // same view: only the left-over text
      const upload = layer.takeUpload();
      expect(upload).toEqual({ kind: 'ranges', runs: [[first, layer.count]] });
      while (layer.needsMoreFrames) update();
      expect(layer.count).toBe(6);
    });

    it('builds again when an atlas grows, as written UVs are normalized by its size', () => {
      const { layer, add, update, sdfAtlas } = setup();
      // Enough distinct glyphs to outgrow the 256px test atlas in the middle of the build.
      const chars = Array.from({ length: 1200 }, (_, i) => String.fromCharCode(0x4e00 + i));
      add(sticky('a', 0, chars.join(''), { w: 4000, h: 4000 }));
      update(view(0, 4000));
      expect(sdfAtlas.size).toBeGreaterThan(256);
      // A glyph placed before the growth, away from the origin (where UVs are 0 at any size).
      const glyph = sdfAtlas.peek(`32|0|${chars[10]}`)!;
      expect(glyph.x).toBeGreaterThan(0);
      const f32 = new Float32Array(layer.data);
      expect(f32[10 * FLOATS + 8]).toBeCloseTo(glyph.x / sdfAtlas.size, 6);
      expect(f32[10 * FLOATS + 9]).toBeCloseTo(glyph.y / sdfAtlas.size, 6);
    });

    it('skips the board when even its largest text is too small to see', () => {
      const { scene, layer, add, update } = setup();
      add(sticky('a', 0, 'abc'));
      scene.subscribe((c) => layer.applyChanges(c));
      const query = vi.spyOn(scene, 'queryBox');
      update(view(0, 40000), 0.01); // 20 * 0.01 = 0.2px
      expect(query).not.toHaveBeenCalled();
      expect(layer.count).toBe(0);
      add(sticky('big', 0, 'x', { text: textBlock('x', { fontSize: 400 }) }));
      update(view(0, 40000), 0.01); // 4px
      expect(query).toHaveBeenCalled();
      expect(layer.count).toBe(1);
    });
  });
});
