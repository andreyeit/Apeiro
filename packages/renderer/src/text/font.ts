import TinySDF from '@mapbox/tiny-sdf';
import { FONT_FAMILIES, variantFamily, type FontMeasurer, type FontVariant } from '@apeiro/core';
import type { RasterGlyph } from './glyph-atlas';

/** CSS family of a variant (the default one for an unknown index). */
export const familyCss = (variant: FontVariant): string =>
  (FONT_FAMILIES[variantFamily(variant)] ?? FONT_FAMILIES[0]!).css;

const MEASURE_SIZE = 100;

export const variantCss = (variant: FontVariant) => ({
  weight: variant & 1 ? '700' : '400',
  style: variant & 2 ? 'italic' : 'normal',
});

/** CSS `font` shorthand of a variant. */
export function cssFont(variant: FontVariant, size: number): string {
  const { weight, style } = variantCss(variant);
  return `${style} ${weight} ${size}px ${familyCss(variant)}`;
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function createContext(width = 1, height = 1): Ctx2D {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })!;
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas.getContext('2d', { willReadFrequently: true })!;
}

/**
 * Measures with Canvas 2D using the same CSS font as the DOM editor, so text wraps
 * the same way on the board and while editing. Kerning is measured per pair
 * (`width("AV") - width("A") - width("V")`) and cached.
 */
export class CanvasFontMeasurer implements FontMeasurer {
  ascent = 0.9;
  descent = 0.22;
  private ctx = createContext();
  private advances = new Map<string, number>();
  private kerns = new Map<string, number>();
  private vertical = new Map<number, { ascent: number; descent: number }>();
  private currentVariant: FontVariant | -1 = -1;

  constructor() {
    this.updateVerticalMetrics();
  }

  advance(cluster: string, variant: FontVariant): number {
    const key = `${variant}|${cluster}`;
    let w = this.advances.get(key);
    if (w === undefined) {
      w = this.measure(cluster, variant);
      this.advances.set(key, w);
    }
    return w;
  }

  kerning(left: string, right: string, variant: FontVariant): number {
    const key = `${variant}|${left}\u0000${right}`;
    let k = this.kerns.get(key);
    if (k === undefined) {
      k =
        this.measure(left + right, variant) -
        this.advance(left, variant) -
        this.advance(right, variant);
      // Float noise from the measurement is not kerning.
      if (Math.abs(k) < 1e-4) k = 0;
      this.kerns.set(key, k);
    }
    return k;
  }

  /** Ascent and descent (em) of a variant's family, measured once per family. */
  metrics(variant: FontVariant): { ascent: number; descent: number } {
    const family = variantFamily(variant);
    let m = this.vertical.get(family);
    if (!m) {
      this.ctx.font = cssFont(family * 4, MEASURE_SIZE);
      this.currentVariant = family * 4;
      const t = this.ctx.measureText('Hg');
      m = t.fontBoundingBoxAscent
        ? {
            ascent: t.fontBoundingBoxAscent / MEASURE_SIZE,
            descent: t.fontBoundingBoxDescent / MEASURE_SIZE,
          }
        : { ascent: this.ascent, descent: this.descent };
      this.vertical.set(family, m);
    }
    return m;
  }

  /** Call after fonts finish loading: cached metrics belong to the fallback font. */
  clear(): void {
    this.advances.clear();
    this.kerns.clear();
    this.vertical.clear();
    this.currentVariant = -1;
    this.updateVerticalMetrics();
  }

  private measure(text: string, variant: FontVariant): number {
    if (this.currentVariant !== variant) {
      this.ctx.font = cssFont(variant, MEASURE_SIZE);
      this.currentVariant = variant;
    }
    return this.ctx.measureText(text).width / MEASURE_SIZE;
  }

  private updateVerticalMetrics(): void {
    this.ctx.font = cssFont(0, MEASURE_SIZE);
    const m = this.ctx.measureText('Hg');
    if (m.fontBoundingBoxAscent) {
      this.ascent = m.fontBoundingBoxAscent / MEASURE_SIZE;
      this.descent = m.fontBoundingBoxDescent / MEASURE_SIZE;
    }
    this.currentVariant = 0;
  }
}

export type GlyphRasterizer = (cluster: string, variant: FontVariant, size: number) => RasterGlyph;

/** SDF value at the outline. Shared by the rasterizer and the shader. */
export const SDF_CUTOFF = 0.25;
/** SDF padding around the glyph for a raster size (integer, as TinySDF rounds it). */
const sdfBuffer = (size: number) => Math.ceil(size / 8);

/**
 * Single-channel SDF glyphs at any raster size. The distance range scales with the
 * size, so every tier antialiases identically in the shader.
 */
export function createSdfRasterizer(): GlyphRasterizer {
  const instances = new Map<string, TinySDF>();
  return (cluster, variant, size) => {
    const key = `${variant}:${size}`;
    let sdf = instances.get(key);
    if (!sdf) {
      const { weight, style } = variantCss(variant);
      sdf = new TinySDF({
        fontSize: size,
        buffer: sdfBuffer(size),
        radius: size / 4,
        cutoff: SDF_CUTOFF,
        fontFamily: familyCss(variant),
        fontWeight: weight,
        fontStyle: style,
      });
      instances.set(key, sdf);
    }
    const g = sdf.draw(cluster);
    return {
      data: g.data,
      width: g.width,
      height: g.height,
      left: g.glyphLeft - sdfBuffer(size),
      top: g.glyphTop + sdfBuffer(size),
    };
  };
}

/** RGBA bitmaps (premultiplied) for color glyphs: emoji, flags. */
export function createColorRasterizer(): GlyphRasterizer {
  let ctx: Ctx2D | null = null;
  return (cluster, variant, size) => {
    const pad = 2;
    ctx ??= createContext(8, 8);
    ctx.font = cssFont(variant, size);
    const m = ctx.measureText(cluster);
    // Real glyphs extend a couple of em at most; anything beyond (stacked combining marks…)
    // is clipped, so a single cluster can't allocate a huge bitmap or overflow the atlas.
    const reach = (v: number) => Math.min(Math.ceil(v), size * 2);
    const bl = reach(m.actualBoundingBoxLeft);
    const br = reach(m.actualBoundingBoxRight);
    const asc = reach(m.actualBoundingBoxAscent);
    const desc = reach(m.actualBoundingBoxDescent);
    const width = bl + br + pad * 2;
    const height = asc + desc + pad * 2;
    if (!(width > pad * 2) || !(height > pad * 2)) {
      return { data: new Uint8Array(0), width: 0, height: 0, left: 0, top: 0 };
    }
    const canvas = ctx.canvas;
    if (canvas.width < width || canvas.height < height) {
      canvas.width = Math.max(canvas.width, width);
      canvas.height = Math.max(canvas.height, height);
      ctx.font = cssFont(variant, size); // resizing resets the context state
    }
    ctx.clearRect(0, 0, width, height);
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#000';
    ctx.fillText(cluster, pad + bl, pad + asc);
    const img = ctx.getImageData(0, 0, width, height).data;
    const data = new Uint8Array(img.length);
    for (let i = 0; i < img.length; i += 4) {
      const a = img[i + 3]!;
      data[i] = (img[i]! * a + 127) / 255;
      data[i + 1] = (img[i + 1]! * a + 127) / 255;
      data[i + 2] = (img[i + 2]! * a + 127) / 255;
      data[i + 3] = a;
    }
    return { data, width, height, left: -bl - pad, top: asc + pad };
  };
}
