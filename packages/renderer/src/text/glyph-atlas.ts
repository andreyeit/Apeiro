/** A rasterized glyph bitmap (SDF or color), ready to be packed. */
export interface RasterGlyph {
  /** `width * height * channels` bytes; empty for whitespace. */
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
  /** Bitmap top-left relative to the pen position at the baseline, in raster px (x right, y up for top). */
  left: number;
  top: number;
}

export interface GlyphInfo {
  /** Atlas position in texels. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Bitmap top-left relative to the pen position, raster px. */
  left: number;
  top: number;
  /** Font size the glyph was rasterized at; display scale = fontSize / rasterSize. */
  rasterSize: number;
}

export interface AtlasUpload {
  x: number;
  y: number;
  width: number;
  height: number;
  data: Uint8Array;
}

export interface AtlasOptions {
  /** 1 for SDF (R8), 4 for color glyphs (RGBA8, premultiplied). */
  channels: 1 | 4;
  initialSize?: number;
  maxSize?: number;
}

const PADDING = 1; // texels between glyphs to avoid bleeding under linear filtering

/**
 * Glyph atlas filled on demand with shelf packing. Grows by doubling up to
 * `maxSize`; when full at max size it is cleared and `generation` changes,
 * so consumers know previously returned positions are stale.
 *
 * Rasterization is done by the caller: the atlas only stores bitmaps. That lets
 * the caller spread expensive rasterization over frames.
 */
export class GlyphAtlas {
  readonly channels: 1 | 4;
  private readonly maxSize: number;
  private glyphs = new Map<string, GlyphInfo>();
  private _size: number;
  private _data: Uint8Array;
  private _generation = 0;
  private shelfX = 0;
  private shelfY = 0;
  private shelfH = 0;
  private uploads: AtlasUpload[] = [];
  private fullUpload = true;

  constructor(options: AtlasOptions) {
    this.channels = options.channels;
    this._size = options.initialSize ?? 1024;
    this.maxSize = options.maxSize ?? 4096;
    this._data = new Uint8Array(this._size * this._size * this.channels);
  }

  get size(): number {
    return this._size;
  }
  get data(): Uint8Array {
    return this._data;
  }
  /** Changes whenever previously returned glyph positions become invalid. */
  get generation(): number {
    return this._generation;
  }
  get glyphCount(): number {
    return this.glyphs.size;
  }

  peek(key: string): GlyphInfo | undefined {
    return this.glyphs.get(key);
  }

  /**
   * Stores a bitmap under `key`. May grow the atlas, or reset it when full
   * (check `generation`). Returns the stored position.
   */
  insert(key: string, raster: RasterGlyph, rasterSize: number): GlyphInfo {
    const info: GlyphInfo = {
      x: 0,
      y: 0,
      width: raster.width,
      height: raster.height,
      left: raster.left,
      top: raster.top,
      rasterSize,
    };
    const fits = raster.width + PADDING <= this.maxSize && raster.height + PADDING <= this.maxSize;
    // A cluster that can't fit even an empty atlas (e.g. hundreds of stacked combining marks)
    // is stored as empty: text comes from users, it must never break rendering.
    if (fits && raster.width > 0 && raster.height > 0 && raster.data.length > 0) {
      const pos = this.allocate(raster.width, raster.height);
      info.x = pos.x;
      info.y = pos.y;
      this.blit(info.x, info.y, raster.width, raster.height, raster.data);
    } else {
      info.width = 0; // whitespace, unsupported or oversized: nothing to draw
      info.height = 0;
    }
    this.glyphs.set(key, info);
    return info;
  }

  /** Drops all glyphs, e.g. after a web font finished loading. */
  reset(): void {
    this.glyphs.clear();
    this._data.fill(0);
    this.shelfX = this.shelfY = this.shelfH = 0;
    this._generation++;
    this.uploads = [];
    this.fullUpload = true;
  }

  /** Forces a full texture upload, e.g. after a lost WebGL context. */
  markFullUpload(): void {
    this.fullUpload = true;
    this.uploads = [];
  }

  /** Pending texture updates since the last call. `full` means re-upload the whole texture. */
  takeUploads(): { full: boolean; rects: AtlasUpload[] } {
    const result = { full: this.fullUpload, rects: this.fullUpload ? [] : this.uploads };
    this.uploads = [];
    this.fullUpload = false;
    return result;
  }

  private allocate(w: number, h: number): { x: number; y: number } {
    if (w + PADDING > this.maxSize || h + PADDING > this.maxSize) {
      throw new Error(`Glyph ${w}x${h} does not fit an atlas of ${this.maxSize}`);
    }
    if (this.shelfX + w + PADDING > this._size) {
      this.shelfY += this.shelfH + PADDING;
      this.shelfX = 0;
      this.shelfH = 0;
    }
    if (this.shelfY + h + PADDING > this._size) {
      if (this._size < this.maxSize) this.grow();
      else this.reset(); // full at max size: start over, consumers rebuild via `generation`
      return this.allocate(w, h);
    }
    const pos = { x: this.shelfX, y: this.shelfY };
    this.shelfX += w + PADDING;
    this.shelfH = Math.max(this.shelfH, h);
    return pos;
  }

  /** Doubles width and height; existing glyph positions stay valid. */
  private grow(): void {
    const c = this.channels;
    const next = this._size * 2;
    const data = new Uint8Array(next * next * c);
    const rowBytes = this._size * c;
    for (let row = 0; row < this._size; row++) {
      data.set(this._data.subarray(row * rowBytes, (row + 1) * rowBytes), row * next * c);
    }
    this._size = next;
    this._data = data;
    this.fullUpload = true;
    this.uploads = [];
  }

  private blit(
    x: number,
    y: number,
    w: number,
    h: number,
    src: Uint8ClampedArray | Uint8Array,
  ): void {
    const c = this.channels;
    const rowBytes = w * c;
    for (let row = 0; row < h; row++) {
      this._data.set(
        src.subarray(row * rowBytes, (row + 1) * rowBytes),
        ((y + row) * this._size + x) * c,
      );
    }
    if (!this.fullUpload) {
      this.uploads.push({
        x,
        y,
        width: w,
        height: h,
        data: new Uint8Array(src.buffer, src.byteOffset, w * h * c),
      });
    }
  }
}
