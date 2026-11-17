import { DirtyRanges, type BufferUpload } from './buffer-upload';
import {
  boxContainsBox,
  boxIntersects,
  isColorGlyph,
  isShape,
  layoutText,
  textArea,
  type BoardElement,
  type Box,
  type FontMeasurer,
  type FontVariant,
  type Scene,
  type SceneChanges,
  type ShapeElement,
  type TextBlock,
  type TextLayout,
} from '@apeiro/core';
import { ColorTheme } from '../color-theme';
import { textDepth } from '../depth';
import type { GlyphRasterizer } from '../text/font';
import type { GlyphAtlas, GlyphInfo } from '../text/glyph-atlas';

/**
 * Per-quad instance (interleaved, 56 bytes):
 *   0  f32 anchorX, anchorY  element center (world)
 *   8  f32 offX, offY        quad top-left relative to the center, unrotated
 *   16 f32 w, h, rotation, depth
 *   32 f32 u0, v0, u1, v1    normalized atlas coords
 *   48 f32 mode              MODE_*
 *   52 u8x4 color
 */
export const GLYPH_STRIDE = 56;
const FLOATS = GLYPH_STRIDE / 4;

export const MODE_SDF = 0;
export const MODE_COLOR = 1;
/** Solid rectangle: underline, strike-through, greeking bars. */
export const MODE_SOLID = 2;

/** Raster sizes. A glyph is drawn from the smallest tier that is at most ~1.5x magnified. */
export const SDF_TIERS = [32, 64, 128, 256, 512] as const;
/** Bitmaps don't scale down as well as distance fields: small emoji get their own tier. */
export const COLOR_TIERS = [16, 32, 64, 128, 256] as const;
const MAX_MAGNIFICATION = 1.5;
/** Memory for quads kept per element between builds (oldest blocks are dropped first). */
const BLOCK_CACHE_BYTES = 32 * 1024 * 1024;

export interface TextLayerOptions {
  /** Below this on-screen font size (CSS px) glyphs are replaced by line bars. */
  minGlyphPx?: number;
  /** Below this on-screen font size text is not drawn at all. */
  minGreekPx?: number;
  /** Upper bound of quads per build. */
  maxQuads?: number;
  /**
   * Time per frame spent on actual work (layout, rasterization); the rest continues next frame.
   * Iterating already prepared text does not count, so progress never starves.
   */
  budgetMs?: number;
  /** Work units per frame: one per layout, one per 64x64 rasterized px. Guards coarse timers. */
  budgetUnits?: number;
  /** Max cached layouts (FIFO eviction). */
  layoutCacheSize?: number;
}

export interface TextRasterizers {
  sdf: GlyphRasterizer;
  color: GlyphRasterizer;
}

interface CachedLayout {
  w: number;
  h: number;
  layout: TextLayout;
}

/** Everything `textArea` and the layout depend on: if any of it changes, text is laid out again. */
interface LayoutInputs {
  text: TextBlock;
  w: number;
  h: number;
  strokeWidth: number;
  type: ShapeElement['type'];
  sides: ShapeElement['sides'];
}

/** Quads emitted for an element in the current build (empty if it was too small). */
interface Range extends LayoutInputs {
  start: number;
  end: number;
}

/**
 * An element's quads from an earlier build, ready to be copied into the next one. Anchor,
 * rotation and depth are patched when the element moved; anything else that changes the
 * quads (text, size, raster tier, atlas contents, colours) makes the block invalid.
 */
interface QuadBlock extends LayoutInputs {
  /** `layout.maxFontSize`: picks glyphs, bars or nothing without the layout. */
  maxFontSize: number;
  greek: boolean;
  /** Device px per world unit over which every glyph keeps its raster tier: (minPx, maxPx]. */
  minPx: number;
  maxPx: number;
  tierCap: number;
  generations: string;
  theme: ColorTheme;
  cx: number;
  cy: number;
  rotation: number;
  depth: number;
  /** Null for text that was too small to draw: only its `maxFontSize` is kept. */
  quads: Float32Array | null;
}

/** Bytes a block without quads is counted as in the cache budget. */
const SIZE_ONLY_BYTES = 256;

export type TextUpload = BufferUpload;

/**
 * Builds quads for text that is visible right now. Cost is bounded by the screen,
 * not the board: only elements in the viewport (+50%) are considered, tiny text
 * becomes line bars, and invisible text costs nothing.
 *
 * Geometry-only changes (dragging) patch the element's quads in place; anything
 * else triggers a rebuild of the visible set. A rebuild copies each element's quads from
 * the previous build when they are still valid, so panning and zooming mostly copy memory.
 * Text that ran out of the frame budget (layout, rasterization) is finished in later
 * frames by appending just that text, not by building everything again.
 */
export class TextLayer {
  /** Colors drawn in place of the stored ones (set by the renderer). */
  theme = new ColorTheme();
  readonly options: Required<TextLayerOptions>;
  private layouts = new Map<TextBlock, CachedLayout>();
  private blocks = new Map<string, QuadBlock>();
  private blockBytes = 0;
  private buffer = new ArrayBuffer(4096 * GLYPH_STRIDE);
  private f32 = new Float32Array(this.buffer);
  private u8 = new Uint8Array(this.buffer);
  private _count = 0;
  private covered: Box | null = null;
  private builtZoom = 0;
  private builtDpr = 0;
  private builtGenerations = '';
  private builtTierCap = SDF_TIERS.length - 1;
  private dirty = true;
  private incomplete = false;
  /** The quad budget ran out in this build: the rest of the text is skipped. */
  private full = false;
  /** Elements to finish in a later frame: their layout or the wanted glyph tier was missing. */
  private pending: string[] = [];
  private considered = new Map<string, Range>();
  private hidden = new Set<string>();
  private changed = new DirtyRanges();
  private spentMs = 0;
  private spentUnits = 0;
  /**
   * Upper bound of the font sizes on the board (-1: not computed yet). Only grows: when even
   * the largest text is too small to draw, a build skips the board entirely.
   */
  private maxTextSize = -1;
  /** Set when a glyph came from another tier than wanted (or was missing): don't cache it. */
  private usedFallback = false;
  /** Tier validity of the glyphs emitted for the current element, see `QuadBlock`. */
  private minPx = 0;
  private maxPx = Infinity;
  lastBuildMs = 0;

  constructor(
    private readonly sdfAtlas: GlyphAtlas,
    private readonly colorAtlas: GlyphAtlas,
    private readonly measurer: FontMeasurer,
    private readonly rasterizers: TextRasterizers,
    options: TextLayerOptions = {},
  ) {
    this.options = {
      minGlyphPx: options.minGlyphPx ?? 2.5,
      minGreekPx: options.minGreekPx ?? 1,
      maxQuads: options.maxQuads ?? 400_000,
      budgetMs: options.budgetMs ?? 6,
      budgetUnits: options.budgetUnits ?? 400,
      layoutCacheSize: options.layoutCacheSize ?? 20_000,
    };
  }

  get count(): number {
    return this._count;
  }
  get data(): ArrayBuffer {
    return this.buffer;
  }
  /** True while glyphs or layouts are still being produced over several frames. */
  get needsMoreFrames(): boolean {
    return this.incomplete;
  }

  /** Returns what changed in the CPU buffer since the last call. */
  takeUpload(): TextUpload {
    return this.changed.take();
  }

  /** Forces a full upload (e.g. after a lost context). */
  markUploadAll(): void {
    this.changed.markAll();
  }

  setHidden(id: string, hidden: boolean): void {
    if (hidden ? this.hidden.has(id) : !this.hidden.has(id)) return;
    if (hidden) this.hidden.add(id);
    else this.hidden.delete(id);
    this.dirty = true;
  }

  markDirty(): void {
    this.dirty = true;
  }

  /** Drops cached layouts, e.g. after a font finished loading. */
  resetLayouts(): void {
    this.layouts.clear();
    this.blocks.clear();
    this.blockBytes = 0;
    this.dirty = true;
  }

  /** Cached layout of an element's text (computed synchronously if missing). */
  layoutOf(el: ShapeElement): TextLayout | undefined {
    if (!el.text) return undefined;
    return this.layout(el, el.text, true);
  }

  /**
   * Applies scene changes: moves quads of elements that only moved/rotated,
   * and schedules a rebuild for anything else that affects visible text.
   */
  applyChanges(c: SceneChanges): void {
    for (const id of c.removed) this.forgetBlock(id);
    if (this.maxTextSize >= 0) {
      for (const el of c.added) this.noteTextSize(el);
      for (const el of c.updated) this.noteTextSize(el);
    }
    if (this.dirty || !this.covered) return;
    const covered = this.covered;
    for (const id of c.removed) {
      const range = this.considered.get(id);
      if (range) this.hideRange(range);
      this.considered.delete(id);
    }
    for (const el of c.added) {
      if (isShape(el) && el.text && this.overlaps(el, covered)) {
        this.dirty = true;
        return;
      }
    }
    for (const el of c.updated) {
      if (!isShape(el)) continue;
      const range = this.considered.get(el.id);
      if (!range) {
        if (el.text && this.overlaps(el, covered)) {
          this.dirty = true;
          return;
        }
        continue;
      }
      if (!sameLayoutInputs(range, el)) {
        this.dirty = true;
        return;
      }
      this.moveRange(range, el);
    }
  }

  /** Rebuilds quads if the view left the built region, zoom changed notably, or content changed. */
  update(
    scene: Scene,
    view: Box,
    zoom: number,
    dpr: number,
    slotOf: (id: string) => number | undefined,
  ): void {
    const zoomChanged = zoom > this.builtZoom * 1.25 || zoom < this.builtZoom / 1.25;
    const sameView =
      !zoomChanged &&
      dpr === this.builtDpr &&
      this.builtGenerations === this.generations() &&
      this.covered !== null &&
      boxContainsBox(this.covered, view);
    if (!this.dirty && !this.incomplete && sameView) return;
    const t0 = performance.now();
    this.spentMs = 0;
    this.spentUnits = 0;
    if (this.maxTextSize < 0) {
      this.maxTextSize = 0;
      for (const el of scene.all()) this.noteTextSize(el);
    }
    if (!this.dirty && sameView) {
      // Only work left over from earlier frames: add it to what is already built.
      this.resume(scene, zoom, dpr, slotOf);
      this.lastBuildMs = performance.now() - t0;
      return;
    }
    // An atlas change mid-build invalidates already written UVs (they are normalized by the
    // atlas size): build again. If an atlas had to start over, cap the tier so the visible
    // set fits.
    let tierCap = SDF_TIERS.length - 1;
    let settled = false;
    for (let attempt = 0; attempt < 3 && !settled; attempt++) {
      const before = this.generations();
      const resets = this.resets();
      this.build(scene, view, zoom, dpr, slotOf, tierCap);
      settled = this.generations() === before;
      if (this.resets() !== resets) tierCap = Math.max(0, tierCap - 1);
    }
    // The last attempt still changed an atlas: some quads point at stale atlas positions.
    // Build again next frame rather than keep them.
    if (!settled) {
      this.dirty = true;
      this.incomplete = true;
    }
    this.lastBuildMs = performance.now() - t0;
  }

  /** Changes whenever written atlas UVs become stale: a reset, or growth (UVs are normalized). */
  private generations(): string {
    const { sdfAtlas: s, colorAtlas: c } = this;
    return `${s.generation}:${s.size}:${c.generation}:${c.size}`;
  }

  private resets(): string {
    return `${this.sdfAtlas.generation}:${this.colorAtlas.generation}`;
  }

  private build(
    scene: Scene,
    view: Box,
    zoom: number,
    dpr: number,
    slotOf: (id: string) => number | undefined,
    tierCap: number,
  ): void {
    const mx = (view.maxX - view.minX) * 0.5;
    const my = (view.maxY - view.minY) * 0.5;
    const covered = {
      minX: view.minX - mx,
      minY: view.minY - my,
      maxX: view.maxX + mx,
      maxY: view.maxY + my,
    };
    this._count = 0;
    this.considered.clear();
    this.incomplete = false;
    this.full = false;
    this.pending = [];
    const generations = this.generations();

    // Zoomed out so far that even the largest text on the board is invisible: nothing to visit.
    if (this.maxTextSize * zoom >= this.options.minGreekPx) {
      for (const el of scene.queryBox(covered)) {
        this.place(el, zoom, zoom * dpr, tierCap, generations, slotOf);
      }
    }

    this.covered = covered;
    this.builtZoom = zoom;
    this.builtDpr = dpr;
    this.builtTierCap = tierCap;
    this.builtGenerations = this.generations();
    this.dirty = false;
    this.changed.markAll();
  }

  /**
   * Finishes text left over by earlier frames: drops its provisional quads (borrowed glyph
   * tiers) and appends new ones. Only the appended and hidden quads are uploaded.
   */
  private resume(
    scene: Scene,
    zoom: number,
    dpr: number,
    slotOf: (id: string) => number | undefined,
  ): void {
    const ids = this.pending;
    this.pending = [];
    this.incomplete = false;
    const generations = this.generations();
    for (let i = 0; i < ids.length; i++) {
      if (!this.canWork()) {
        // This frame's budget is spent: the rest waits for the next one, untouched.
        for (let j = i; j < ids.length; j++) this.defer(ids[j]!);
        break;
      }
      const id = ids[i]!;
      const old = this.considered.get(id);
      if (old) {
        this.hideRange(old);
        this.considered.delete(id);
      }
      const el = scene.get(id);
      if (!el) continue;
      const start = this._count;
      this.place(el, zoom, zoom * dpr, this.builtTierCap, generations, slotOf);
      if (this._count > start) this.changed.mark(start, this._count);
    }
    if (this.generations() !== generations) {
      // An atlas grew or started over: quads written before point at old positions.
      this.dirty = true;
      this.incomplete = true;
    }
    this.builtGenerations = this.generations();
  }

  /** Appends the quads of one element: copied from its cached block, or emitted. */
  private place(
    el: BoardElement,
    zoom: number,
    pxPerUnit: number,
    tierCap: number,
    generations: string,
    slotOf: (id: string) => number | undefined,
  ): void {
    if (!isShape(el)) return;
    const block = el.text;
    if (!block || block.runs.length === 0 || this.hidden.has(el.id)) return;
    const { minGlyphPx, minGreekPx, maxQuads } = this.options;
    const start = this._count;
    const cached = this.blocks.get(el.id);
    const known = cached !== undefined && sameLayoutInputs(cached, el);
    // Cheap rejection before layout: autoFit can only shrink sizes.
    if (this.full || (known ? cached.maxFontSize : largestSize(block)) * zoom < minGreekPx) {
      this.considered.set(el.id, rangeOf(el, start, start));
      return;
    }
    let layout: TextLayout | undefined;
    let maxFontSize: number;
    if (known) maxFontSize = cached.maxFontSize;
    else {
      layout = this.layout(el, block, false);
      if (!layout) return this.defer(el.id); // out of budget: lay it out next frame
      maxFontSize = layout.maxFontSize;
    }
    const screenSize = maxFontSize * zoom;
    if (screenSize < minGreekPx) {
      // Remember its size: next builds skip this text without looking up its layout.
      if (!known) this.rememberBlock(el, maxFontSize, false, 0, null, tierCap, generations);
      this.considered.set(el.id, rangeOf(el, start, start));
      return;
    }
    const slot = slotOf(el.id);
    if (slot === undefined) return;
    const depth = textDepth(slot);
    const greek = screenSize < minGlyphPx;

    if (
      known &&
      cached.quads !== null &&
      cached.greek === greek &&
      cached.theme === this.theme &&
      (greek ||
        (cached.generations === generations &&
          cached.tierCap === tierCap &&
          pxPerUnit > cached.minPx &&
          pxPerUnit <= cached.maxPx))
    ) {
      if (!this.copyBlock(cached, cached.quads, el, depth)) this.full = true;
    } else {
      layout ??= this.layout(el, block, false);
      if (!layout) return this.defer(el.id);
      this.usedFallback = false;
      this.minPx = 0;
      this.maxPx = Infinity;
      const ok = greek
        ? this.emitGreek(el, layout, depth)
        : this.emitGlyphs(el, layout, depth, pxPerUnit, tierCap);
      if (!ok) this.full = true;
      else if (this.usedFallback) this.defer(el.id); // drawn with borrowed glyphs for now
      else {
        const quads = this.f32.slice(start * FLOATS, this._count * FLOATS);
        this.rememberBlock(el, layout.maxFontSize, greek, depth, quads, tierCap, generations);
      }
    }
    if (this._count >= maxQuads) this.full = true;
    this.considered.set(el.id, rangeOf(el, start, this._count));
  }

  private defer(id: string): void {
    this.pending.push(id);
    this.incomplete = true;
  }

  /** Copies a cached block into the buffer (patched to where the element is now). */
  private copyBlock(block: QuadBlock, q: Float32Array, el: ShapeElement, depth: number): boolean {
    const cx = el.x + el.w / 2;
    const cy = el.y + el.h / 2;
    if (
      block.cx !== cx ||
      block.cy !== cy ||
      block.rotation !== el.rotation ||
      block.depth !== depth
    ) {
      for (let f = 0; f < q.length; f += FLOATS) {
        q[f] = cx;
        q[f + 1] = cy;
        q[f + 6] = el.rotation;
        q[f + 7] = depth;
      }
      block.cx = cx;
      block.cy = cy;
      block.rotation = el.rotation;
      block.depth = depth;
    }
    const room = this.options.maxQuads - this._count;
    const n = Math.min(q.length / FLOATS, room);
    this.ensureCapacity(this._count + n);
    // Same-type typed array copy: bytes are preserved, colours included.
    this.f32.set(n * FLOATS === q.length ? q : q.subarray(0, n * FLOATS), this._count * FLOATS);
    this._count += n;
    return n * FLOATS === q.length;
  }

  private rememberBlock(
    el: ShapeElement,
    maxFontSize: number,
    greek: boolean,
    depth: number,
    quads: Float32Array | null,
    tierCap: number,
    generations: string,
  ): void {
    this.forgetBlock(el.id);
    this.blocks.set(el.id, {
      text: el.text!,
      w: el.w,
      h: el.h,
      strokeWidth: el.strokeWidth,
      type: el.type,
      sides: el.sides,
      maxFontSize,
      greek,
      minPx: this.minPx,
      maxPx: this.maxPx,
      tierCap,
      generations,
      theme: this.theme,
      cx: el.x + el.w / 2,
      cy: el.y + el.h / 2,
      rotation: el.rotation,
      depth,
      quads,
    });
    this.blockBytes += blockSize(quads);
    for (const [id, old] of this.blocks) {
      if (this.blockBytes <= BLOCK_CACHE_BYTES) break;
      this.blocks.delete(id);
      this.blockBytes -= blockSize(old.quads);
    }
  }

  private forgetBlock(id: string): void {
    const old = this.blocks.get(id);
    if (!old) return;
    this.blocks.delete(id);
    this.blockBytes -= blockSize(old.quads);
  }

  private noteTextSize(el: BoardElement): void {
    const block = isShape(el) ? el.text : undefined;
    if (block) this.maxTextSize = Math.max(this.maxTextSize, largestSize(block));
  }

  private layout(el: ShapeElement, block: TextBlock, force: boolean): TextLayout | undefined {
    const cached = this.layouts.get(block);
    // Out of budget and nothing cached: no need to measure the text area just to say no.
    if (!cached && !force && !this.canWork()) return undefined;
    const area = textArea(el);
    const w = area.maxX - area.minX;
    const h = area.maxY - area.minY;
    if (cached && cached.w === w && cached.h === h) return cached.layout;
    if (!force && !this.canWork()) return undefined;
    const t = performance.now();
    // Auto-width text never wraps: its box may lag behind (e.g. fonts loaded after it was sized).
    const noWrap = el.type === 'text' && block.sizing === 'auto-width';
    const layout = layoutText(block, w, h, this.measurer, noWrap);
    this.spend(t, 1);
    this.layouts.delete(block);
    this.layouts.set(block, { w, h, layout });
    if (this.layouts.size > this.options.layoutCacheSize) {
      this.layouts.delete(this.layouts.keys().next().value!);
    }
    return layout;
  }

  /** Returns false when the quad budget is exhausted. */
  private emitGlyphs(
    el: ShapeElement,
    layout: TextLayout,
    depth: number,
    /** Device pixels per world unit. */
    pxPerUnit: number,
    tierCap: number,
  ): boolean {
    const area = textArea(el);
    const cx = el.x + el.w / 2;
    const cy = el.y + el.h / 2;
    const ox = area.minX - el.w / 2;
    const oy = area.minY - el.h / 2;

    for (const g of layout.glyphs) {
      if (this._count >= this.options.maxQuads) return false;
      const color = isColorGlyph(g.char);
      const atlas = color ? this.colorAtlas : this.sdfAtlas;
      // Each glyph picks its own raster tier: sizes can differ within one text.
      const tiers = color ? COLOR_TIERS : SDF_TIERS;
      const tier = pickTier(tiers, g.size * pxPerUnit, tierCap);
      this.noteTierRange(tiers, tier, tierCap, g.size);
      const glyph = this.glyph(
        atlas,
        tiers,
        tier,
        g.char,
        g.variant,
        color ? this.rasterizers.color : this.rasterizers.sdf,
      );
      if (!glyph || glyph.width === 0) continue;
      const scale = g.size / glyph.rasterSize;
      const inv = 1 / atlas.size;
      this.write(
        cx,
        cy,
        ox + g.x + glyph.left * scale,
        oy + g.y - glyph.top * scale,
        glyph.width * scale,
        glyph.height * scale,
        el.rotation,
        depth,
        glyph.x * inv,
        glyph.y * inv,
        (glyph.x + glyph.width) * inv,
        (glyph.y + glyph.height) * inv,
        color ? MODE_COLOR : MODE_SDF,
        // Color glyphs keep their own colors; only the text color's alpha applies.
        color ? (0xffffff00 | (g.color & 255)) >>> 0 : this.theme.of(el.type, g.color),
      );
    }
    for (const d of layout.decorations) {
      if (this._count >= this.options.maxQuads) return false;
      this.solid(
        cx,
        cy,
        ox + d.x,
        oy + d.y - d.thickness / 2,
        d.width,
        d.thickness,
        el.rotation,
        depth,
        this.theme.of(el.type, d.color),
      );
    }
    return true;
  }

  /**
   * Narrows `minPx..maxPx` to the device-px-per-unit range in which `pickTier` keeps
   * choosing `tier` for a glyph of this size (the mirror image of `pickTier`'s test).
   */
  private noteTierRange(
    tiers: readonly number[],
    tier: number,
    tierCap: number,
    size: number,
  ): void {
    const last = Math.min(tierCap, tiers.length - 1);
    if (tier > 0) this.minPx = Math.max(this.minPx, (tiers[tier - 1]! * MAX_MAGNIFICATION) / size);
    if (tier < last) this.maxPx = Math.min(this.maxPx, (tiers[tier]! * MAX_MAGNIFICATION) / size);
  }

  /** Far away, each line becomes a translucent bar so the board keeps its texture. */
  private emitGreek(el: ShapeElement, layout: TextLayout, depth: number): boolean {
    const area = textArea(el);
    const cx = el.x + el.w / 2;
    const cy = el.y + el.h / 2;
    const ox = area.minX - el.w / 2;
    const oy = area.minY - el.h / 2;
    for (const line of layout.lines) {
      const size = line.size;
      if (this._count >= this.options.maxQuads) return false;
      const drawn = this.theme.of(el.type, line.color);
      const alpha = Math.round((drawn & 255) * 0.35);
      const color = ((drawn & 0xffffff00) | alpha) >>> 0;
      // A bar over the x-height of the line.
      this.solid(
        cx,
        cy,
        ox + line.x,
        oy + line.y - size * 0.6,
        line.width,
        size * 0.5,
        el.rotation,
        depth,
        color,
      );
    }
    return true;
  }

  /**
   * Finds a glyph at the wanted tier, rasterizing it if the frame budget allows.
   * Otherwise falls back to the nearest tier already in the atlas and asks for
   * another frame, so zooming never stalls on rasterization.
   */
  private glyph(
    atlas: GlyphAtlas,
    tiers: readonly number[],
    tier: number,
    cluster: string,
    variant: FontVariant,
    rasterize: GlyphRasterizer,
  ): GlyphInfo | undefined {
    const key = (t: number) => `${tiers[t]}|${variant}|${cluster}`;
    const exact = atlas.peek(key(tier));
    if (exact) return exact;
    if (this.canWork()) {
      const size = tiers[tier]!;
      const t = performance.now();
      const info = atlas.insert(key(tier), rasterize(cluster, variant, size), size);
      this.spend(t, Math.max(1, (size * size) / 4096));
      return info;
    }
    this.incomplete = true;
    this.usedFallback = true;
    for (let d = 1; d < tiers.length; d++) {
      const lower = tier - d >= 0 ? atlas.peek(key(tier - d)) : undefined;
      if (lower) return lower;
      const higher = tier + d < tiers.length ? atlas.peek(key(tier + d)) : undefined;
      if (higher) return higher;
    }
    return undefined;
  }

  private canWork(): boolean {
    return this.spentMs < this.options.budgetMs && this.spentUnits < this.options.budgetUnits;
  }

  private spend(start: number, units: number): void {
    this.spentMs += performance.now() - start;
    this.spentUnits += units;
  }

  private solid(
    cx: number,
    cy: number,
    ox: number,
    oy: number,
    w: number,
    h: number,
    rotation: number,
    depth: number,
    color: number,
  ): void {
    this.write(cx, cy, ox, oy, w, h, rotation, depth, 0, 0, 0, 0, MODE_SOLID, color);
  }

  private write(
    ax: number,
    ay: number,
    ox: number,
    oy: number,
    w: number,
    h: number,
    rotation: number,
    depth: number,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    mode: number,
    color: number,
  ): void {
    this.ensureCapacity(this._count + 1);
    const i = this._count++;
    const f = i * FLOATS;
    const f32 = this.f32;
    f32[f] = ax;
    f32[f + 1] = ay;
    f32[f + 2] = ox;
    f32[f + 3] = oy;
    f32[f + 4] = w;
    f32[f + 5] = h;
    f32[f + 6] = rotation;
    f32[f + 7] = depth;
    f32[f + 8] = u0;
    f32[f + 9] = v0;
    f32[f + 10] = u1;
    f32[f + 11] = v1;
    f32[f + 12] = mode;
    const b = i * GLYPH_STRIDE + 52;
    this.u8[b] = (color >>> 24) & 255;
    this.u8[b + 1] = (color >>> 16) & 255;
    this.u8[b + 2] = (color >>> 8) & 255;
    this.u8[b + 3] = color & 255;
  }

  /** Updates anchor and rotation of an element's quads (drag/rotate without relayout). */
  private moveRange(range: Range, el: ShapeElement): void {
    const cx = el.x + el.w / 2;
    const cy = el.y + el.h / 2;
    for (let i = range.start; i < range.end; i++) {
      const f = i * FLOATS;
      this.f32[f] = cx;
      this.f32[f + 1] = cy;
      this.f32[f + 6] = el.rotation;
    }
    this.changed.mark(range.start, range.end);
  }

  private hideRange(range: Range): void {
    for (let i = range.start; i < range.end; i++) {
      const f = i * FLOATS;
      this.f32[f + 4] = 0;
      this.f32[f + 5] = 0;
    }
    this.changed.mark(range.start, range.end);
  }

  /** Conservative overlap test that works for any rotation. */
  private overlaps(el: ShapeElement, box: Box): boolean {
    const r = Math.hypot(el.w, el.h) / 2;
    const cx = el.x + el.w / 2;
    const cy = el.y + el.h / 2;
    return boxIntersects(box, { minX: cx - r, minY: cy - r, maxX: cx + r, maxY: cy + r });
  }

  private ensureCapacity(n: number): void {
    if (n * GLYPH_STRIDE <= this.buffer.byteLength) return;
    const next = new ArrayBuffer(Math.max(n * GLYPH_STRIDE, this.buffer.byteLength * 2));
    new Uint8Array(next).set(this.u8);
    this.buffer = next;
    this.f32 = new Float32Array(next);
    this.u8 = new Uint8Array(next);
  }
}

function sameLayoutInputs(a: LayoutInputs, el: ShapeElement): boolean {
  return (
    a.text === el.text &&
    a.w === el.w &&
    a.h === el.h &&
    a.strokeWidth === el.strokeWidth &&
    a.type === el.type &&
    a.sides === el.sides
  );
}

function rangeOf(el: ShapeElement, start: number, end: number): Range {
  return {
    start,
    end,
    text: el.text!,
    w: el.w,
    h: el.h,
    strokeWidth: el.strokeWidth,
    type: el.type,
    sides: el.sides,
  };
}

/** Largest font size a block can show (its runs may be bigger than its default size). */
function largestSize(block: TextBlock): number {
  let max = block.fontSize;
  for (const run of block.runs) if (run.size !== undefined && run.size > max) max = run.size;
  return max;
}

/** Smallest tier magnified at most MAX_MAGNIFICATION, capped by `cap`. */
export function pickTier(
  tiers: readonly number[],
  devicePx: number,
  cap = tiers.length - 1,
): number {
  const last = Math.min(cap, tiers.length - 1);
  for (let i = 0; i <= last; i++) if (tiers[i]! * MAX_MAGNIFICATION >= devicePx) return i;
  return last;
}

const blockSize = (quads: Float32Array | null) => (quads ? quads.byteLength : SIZE_ONLY_BYTES);
