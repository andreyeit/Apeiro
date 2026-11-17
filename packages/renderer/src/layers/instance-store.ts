import { compareZ, polygonSides, type BoardElement } from '@apeiro/core';
import { DirtyRanges, type BufferUpload } from './buffer-upload';
import { ColorTheme } from '../color-theme';

/**
 * Per-instance layout (interleaved, 44 bytes):
 *   0  f32 x, y, w, h
 *   16 f32 rotation, radius, strokeWidth, kind
 *   32 u8x4 fill RGBA
 *   36 u8x4 stroke RGBA
 *   40 f32 stroke style (STROKE_STYLE_CODE)
 */
export const INSTANCE_STRIDE = 44;

/** Border pattern for the shader. */
export const STROKE_STYLE_CODE = { solid: 0, dashed: 1, dotted: 2 } as const;
const FLOATS_PER_INSTANCE = INSTANCE_STRIDE / 4;

export const KIND_HIDDEN = -1;
/**
 * Connectors get a slot too, hidden: it only gives them a depth in paint order,
 * the line pass draws them.
 */
export const KIND_CODE: Record<BoardElement['type'], number> = {
  connector: KIND_HIDDEN,
  rect: 0,
  ellipse: 1,
  sticky: 2,
  /** Base code: the slot stores POLYGON_KIND_BASE + number of corners (see `kindOf`). */
  polygon: 10,
  text: 0, // a text box's frame is a plain rect (usually transparent)
  // Drawn by the media pass; the slot gives them their place in paint order.
  image: KIND_HIDDEN,
  audio: KIND_HIDDEN,
  // Pen strokes are drawn by the line pass.
  ink: KIND_HIDDEN,
};

export const POLYGON_KIND_BASE = 10;

/** Kind value for the shader: polygons carry their corner count (no spare attribute for it). */
export const kindOf = (el: BoardElement): number =>
  el.type === 'polygon' ? POLYGON_KIND_BASE + polygonSides(el) : KIND_CODE[el.type];

/**
 * CPU mirror of the GPU instance buffer. Slots are kept in paint order
 * (bottom to top), so one instanced draw call paints everything correctly.
 *
 * - update: rewrite one slot in place
 * - remove: hide the slot (leaves a hole, compacted later)
 * - add on top: append, no re-sort
 * - anything that changes relative order: full rebuild
 */
export class InstanceStore {
  /** Colors drawn in place of the stored ones (set by the renderer). */
  theme = new ColorTheme();
  private buffer: ArrayBuffer;
  private f32: Float32Array;
  private u8: Uint8Array;
  private slotOf = new Map<string, number>();
  private top: BoardElement | undefined;
  private used = 0;
  private holes = 0;
  private dirty = new DirtyRanges();

  constructor(initialCapacity = 1024) {
    if (!Number.isSafeInteger(initialCapacity) || initialCapacity < 0)
      throw new RangeError('initialCapacity must be a non-negative safe integer');
    this.buffer = new ArrayBuffer(initialCapacity * INSTANCE_STRIDE);
    this.f32 = new Float32Array(this.buffer);
    this.u8 = new Uint8Array(this.buffer);
  }

  /** Slots in use, holes included. This is the instance count to draw. */
  get count(): number {
    return this.used;
  }
  get holeCount(): number {
    return this.holes;
  }
  get capacity(): number {
    return this.buffer.byteLength / INSTANCE_STRIDE;
  }
  get data(): ArrayBuffer {
    return this.buffer;
  }

  slot(id: string): number | undefined {
    return this.slotOf.get(id);
  }

  /** Rewrites everything from elements already sorted by z. Compacts holes. */
  rebuild(sorted: readonly BoardElement[]): void {
    this.ensureCapacity(sorted.length);
    this.slotOf.clear();
    for (let i = 0; i < sorted.length; i++) {
      const el = sorted[i]!;
      this.slotOf.set(el.id, i);
      this.writeSlot(i, el);
    }
    this.used = sorted.length;
    this.holes = 0;
    this.top = sorted[sorted.length - 1];
    this.markFull();
  }

  /**
   * Appends elements if all of them belong above the current top element.
   * Returns false (and changes nothing) if a rebuild is required instead.
   */
  tryAppend(added: readonly BoardElement[]): boolean {
    if (added.length === 0) return true;
    const sorted = [...added].sort(compareZ);
    if (this.top && compareZ(sorted[0]!, this.top) <= 0) return false;
    this.ensureCapacity(this.used + sorted.length);
    for (const el of sorted) {
      const slot = this.used++;
      this.slotOf.set(el.id, slot);
      this.writeSlot(slot, el);
      this.markSlot(slot);
    }
    this.top = sorted[sorted.length - 1];
    return true;
  }

  /** Rewrites an existing element in place. Returns false if the id has no slot. */
  update(el: BoardElement): boolean {
    const slot = this.slotOf.get(el.id);
    if (slot === undefined) return false;
    this.writeSlot(slot, el);
    if (this.top?.id === el.id) this.top = el;
    this.markSlot(slot);
    return true;
  }

  remove(id: string): boolean {
    const slot = this.slotOf.get(id);
    if (slot === undefined) return false;
    this.slotOf.delete(id);
    this.f32[slot * FLOATS_PER_INSTANCE + 7] = KIND_HIDDEN;
    this.holes++;
    // `top` stays as an upper bound: appending above a removed top is still correct.
    this.markSlot(slot);
    return true;
  }

  /** Worth compacting when holes waste a meaningful share of vertex work. */
  needsCompaction(): boolean {
    return this.holes > 1024 && this.holes > this.used * 0.25;
  }

  /**
   * Slots that must be uploaded to the GPU since the last call (`all` after a rebuild,
   * growth or context restore), and resets.
   */
  takeDirty(): BufferUpload {
    return this.dirty.take();
  }

  /** Forces a full upload, e.g. after WebGL context restore. */
  markFull(): void {
    this.dirty.markAll();
  }

  private markSlot(slot: number): void {
    this.dirty.mark(slot, slot + 1);
  }

  private ensureCapacity(n: number): void {
    if (n <= this.capacity) return;
    let cap = Math.max(1, this.capacity);
    while (cap < n) cap *= 2;
    const next = new ArrayBuffer(cap * INSTANCE_STRIDE);
    new Uint8Array(next).set(this.u8.subarray(0, this.used * INSTANCE_STRIDE));
    this.buffer = next;
    this.f32 = new Float32Array(next);
    this.u8 = new Uint8Array(next);
    this.markFull(); // GPU buffer must be reallocated
  }

  private writeSlot(slot: number, el: BoardElement): void {
    const f = slot * FLOATS_PER_INSTANCE;
    const f32 = this.f32;
    if (el.type === 'connector') {
      f32.fill(0, f, f + FLOATS_PER_INSTANCE);
      f32[f + 7] = KIND_HIDDEN;
      return;
    }
    f32[f] = el.x;
    f32[f + 1] = el.y;
    f32[f + 2] = el.w;
    f32[f + 3] = el.h;
    f32[f + 4] = el.rotation;
    f32[f + 5] = el.radius;
    f32[f + 6] = el.strokeWidth;
    f32[f + 7] = kindOf(el);
    const b = slot * INSTANCE_STRIDE + 32;
    writeColor(this.u8, b, this.theme.of(el.type, el.fill));
    writeColor(this.u8, b + 4, this.theme.of(el.type, el.stroke));
    f32[f + 10] = STROKE_STYLE_CODE[el.strokeStyle ?? 'solid'];
  }
}

/** Writes 0xRRGGBBAA as bytes R, G, B, A regardless of platform endianness. */
function writeColor(u8: Uint8Array, offset: number, rgba: number): void {
  u8[offset] = (rgba >>> 24) & 255;
  u8[offset + 1] = (rgba >>> 16) & 255;
  u8[offset + 2] = (rgba >>> 8) & 255;
  u8[offset + 3] = rgba & 255;
}
