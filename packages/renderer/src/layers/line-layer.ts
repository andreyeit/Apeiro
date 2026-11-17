import { DirtyRanges, type BufferUpload } from './buffer-upload';
import {
  capSize,
  inkWorldPoints,
  smoothStroke,
  isConnector,
  isShape,
  type CapKind,
  type ConnectorArc,
  type ConnectorElement,
  type ConnectorGeometry,
  type Scene,
  type ShapeElement,
  type Vec2,
} from '@apeiro/core';
import { ColorTheme } from '../color-theme';
import { shapeDepth } from '../depth';

/**
 * Per-instance layout (interleaved, 52 bytes):
 *   0  f32 x0, y0, x1, y1          segment ends; for caps: tip and the point `size` behind it;
 *                                  for arcs: center x, y, radius, start angle
 *   16 f32 halfWidth, mode, dash, gap
 *   32 f32 dashOffset, depth, capSize (arcs: sweep), joins
 *   48 u8x4 color
 *
 * `joins`: how a segment or arc meets the previous and the next piece of the same line,
 * `start + end * JOIN_END`, each 0 (a free end, drawn round) or JOIN_FLAG + an 11-bit angle.
 * A joint is split between its two pieces by the line through it along the bisector of
 * their directions (the radius at a rounded bend): each pixel is drawn by one piece only.
 * The angle is that line's normal relative to the piece's own direction, in (-π/2, π/2).
 */
export const LINE_STRIDE = 52;
const FLOATS = LINE_STRIDE / 4;
/** Floats of an instance before its color. */
const ITEM = 12;

export const JOIN_FLAG = 2048;
export const JOIN_END = 4096;
/** Beyond this turn (radians) a line doubles back: no useful split, the ends just overlap. */
const MAX_JOIN_TURN = Math.PI * 0.95;

/** Bits of one joined end: the flag and the split line's angle quantized to 11 bits. */
export function joinBits(angle: number): number {
  const t = Math.max(-1, Math.min(1, angle / (Math.PI / 2)));
  return JOIN_FLAG + Math.round((t * 0.5 + 0.5) * (JOIN_FLAG - 1));
}

export const LINE_HIDDEN = -1;
export const LINE_SEGMENT = 0;
/** A rounded bend, drawn as an exact circular arc (smooth at any zoom). */
export const LINE_ARC = 5;
export const CAP_MODE: Record<Exclude<CapKind, 'none'>, number> = {
  arrow: 1,
  triangle: 2,
  circle: 3,
  diamond: 4,
};

interface Range {
  start: number;
  capacity: number;
}

export type LineUpload = BufferUpload;

/** Dash pattern in world units: core length of a dash (without round ends) and period gap. */
function dashPattern(c: ConnectorElement): [number, number] {
  const w = Math.max(c.strokeWidth, 0.5);
  if (c.dash === 'dashed') return [w * 4, w * 4];
  if (c.dash === 'dotted') return [0, w * 2.5];
  return [0, 0];
}

/**
 * CPU side of connector (and pen stroke) rendering. Each line owns a range of instances
 * (segments + caps), rewritten in place when it moves; if it grows beyond its
 * range it moves to the end and leaves a hole, compacted on the next rebuild. A range keeps
 * room to grow by half, so a pen stroke growing point by point moves only now and then.
 */
export class LineLayer {
  /** Colors drawn in place of the stored ones (set by the renderer). */
  theme = new ColorTheme();
  private buffer = new ArrayBuffer(1024 * LINE_STRIDE);
  private f32 = new Float32Array(this.buffer);
  private u8 = new Uint8Array(this.buffer);
  private ranges = new Map<string, Range>();
  private used = 0;
  private holes = 0;
  private dirty = new DirtyRanges();
  /** Instances of the line being written (ITEM floats each), copied into its range by `place`. */
  private scratch = new Float32Array(64 * ITEM);
  private items = 0;

  /** Instances to draw (holes included, they are degenerate). */
  get count(): number {
    return this.used;
  }
  get data(): ArrayBuffer {
    return this.buffer;
  }

  takeUpload(): LineUpload {
    return this.dirty.take();
  }

  markUploadAll(): void {
    this.dirty.markAll();
  }

  needsCompaction(): boolean {
    return this.holes > 4096 && this.holes > this.used * 0.3;
  }

  /** Rewrites everything, e.g. after paint order (and therefore depths) changed. */
  rebuild(scene: Scene, slotOf: (id: string) => number | undefined): void {
    this.ranges.clear();
    this.used = 0;
    this.holes = 0;
    for (const el of scene.all()) {
      if (isConnector(el)) this.set(el, scene.connectorGeometry(el.id), slotOf(el.id));
      else if (el.type === 'ink') this.setInk(el, slotOf(el.id));
    }
    this.dirty.markAll();
  }

  /** Writes (or hides, if geometry is null) a connector. */
  set(c: ConnectorElement, g: ConnectorGeometry | null, slot: number | undefined): void {
    this.items = 0;
    if (g && slot !== undefined) this.instancesFor(c, g, shapeDepth(slot));
    this.place(c.id, this.theme.of(c.type, c.stroke));
  }

  /** Writes a pen stroke: a smooth curve through its points, as round-ended segments. */
  setInk(el: ShapeElement, slot: number | undefined): void {
    this.items = 0;
    if (slot !== undefined && isShape(el) && el.strokeWidth > 0) {
      const depth = shapeDepth(slot);
      const hw = el.strokeWidth / 2;
      // Smoothed, so the stroke has no kinks between the points the pointer reported.
      const pts = smoothStroke(inkWorldPoints(el), Math.max(hw, 1.5));
      // A dot (a click without moving) is a zero-length segment: just its round ends.
      if (pts.length === 1) pts.push({ ...pts[0]! });
      const dirs: number[] = [];
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i]!;
        const b = pts[i + 1]!;
        this.item(a.x, a.y, b.x, b.y, hw, LINE_SEGMENT, 0, 0, 0, depth, 0);
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const dx = len > 1e-9 ? (b.x - a.x) / len : 0;
        const dy = len > 1e-9 ? (b.y - a.y) / len : 0;
        dirs.push(dx, dy, dx, dy);
      }
      this.joinPieces(dirs);
    }
    this.place(el.id, this.theme.of(el.type, el.stroke));
  }

  /** Appends an instance to `scratch`; the last float of an item is unused. */
  private item(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    halfWidth: number,
    mode: number,
    dash: number,
    gap: number,
    dashOffset: number,
    depth: number,
    size: number,
  ): void {
    let s = this.scratch;
    const at = this.items * ITEM;
    if (at + ITEM > s.length) {
      const next = new Float32Array(s.length * 2);
      next.set(s);
      this.scratch = s = next;
    }
    s[at] = x0;
    s[at + 1] = y0;
    s[at + 2] = x1;
    s[at + 3] = y1;
    s[at + 4] = halfWidth;
    s[at + 5] = mode;
    s[at + 6] = dash;
    s[at + 7] = gap;
    s[at + 8] = dashOffset;
    s[at + 9] = depth;
    s[at + 10] = size;
    s[at + 11] = 0;
    this.items++;
  }

  /**
   * Splits every joint between consecutive pieces in `scratch` (all of them so far, in path
   * order) between its two pieces; `dirs` has each piece's direction in and out (x, y, x, y).
   * Without it, both pieces draw the joint and its translucent edge pixels are blended twice:
   * a knot at every bend, plainly visible once the line is a pixel or two wide on screen.
   */
  private joinPieces(dirs: readonly number[]): void {
    const s = this.scratch;
    for (let i = 0; i + 1 < this.items; i++) {
      const ax = dirs[i * 4 + 2]!;
      const ay = dirs[i * 4 + 3]!;
      const bx = dirs[i * 4 + 4]!;
      const by = dirs[i * 4 + 5]!;
      if ((ax === 0 && ay === 0) || (bx === 0 && by === 0)) continue; // a zero-length piece
      // The split line's normal is the bisector of the two directions: half the turn from
      // the first piece's direction, minus half the turn from the second's.
      const turn = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
      if (Math.abs(turn) > MAX_JOIN_TURN) continue;
      // Arcs split at their own end radius (only their flag is read); bends are tangent.
      const arcBefore = s[i * ITEM + 5] === LINE_ARC;
      const arcAfter = s[(i + 1) * ITEM + 5] === LINE_ARC;
      const end = i * ITEM + 11;
      const start = (i + 1) * ITEM + 11;
      s[end] = s[end]! + joinBits(arcBefore ? 0 : turn / 2) * JOIN_END;
      s[start] = s[start]! + joinBits(arcAfter ? 0 : -turn / 2);
    }
  }

  /** Moves the `scratch` instances into the line's range, growing (moving) it if needed. */
  private place(id: string, color: number): void {
    const n = this.items;
    let range = this.ranges.get(id);
    if (!range || n > range.capacity) {
      if (range) this.hide(range, range.capacity, true);
      // Slack: a line switching between e.g. 3 and 5 elbow segments stays in place, and a
      // stroke being drawn moves O(log n) times instead of on almost every point.
      const capacity = n === 0 ? 0 : n + Math.max(4, n >> 1);
      range = { start: this.used, capacity };
      this.ensureCapacity(this.used + capacity);
      this.used += capacity;
      this.ranges.set(id, range);
    }
    const r = (color >>> 24) & 255;
    const g = (color >>> 16) & 255;
    const b = (color >>> 8) & 255;
    const a = color & 255;
    for (let i = 0; i < n; i++) {
      const slot = range.start + i;
      this.f32.set(this.scratch.subarray(i * ITEM, i * ITEM + ITEM), slot * FLOATS);
      const c = slot * LINE_STRIDE + 48;
      this.u8[c] = r;
      this.u8[c + 1] = g;
      this.u8[c + 2] = b;
      this.u8[c + 3] = a;
    }
    for (let i = n; i < range.capacity; i++) this.f32[(range.start + i) * FLOATS + 5] = LINE_HIDDEN;
    this.mark(range.start, range.start + range.capacity);
  }

  remove(id: string): void {
    const range = this.ranges.get(id);
    if (!range) return;
    this.hide(range, range.capacity, true);
    this.ranges.delete(id);
  }

  private hide(range: Range, n: number, countAsHoles: boolean): void {
    for (let i = 0; i < n; i++) this.f32[(range.start + i) * FLOATS + 5] = LINE_HIDDEN;
    if (countAsHoles) this.holes += range.capacity;
    this.mark(range.start, range.start + n);
  }

  /** Writes a connector's segments, arcs and caps into `scratch`. */
  private instancesFor(c: ConnectorElement, g: ConnectorGeometry, depth: number): void {
    const hw = c.strokeWidth / 2;
    const size = capSize(c.strokeWidth);
    const [dash, gap] = dashPattern(c);
    const pts = g.points.map((p) => ({ ...p }));

    // Filled caps cover the line end: stop the line inside them so it doesn't poke out of the tip.
    const shorten = (cap: CapKind, idx: number, nextIdx: number, dir: Vec2) => {
      if (cap === 'none' || cap === 'arrow') return;
      const p = pts[idx]!;
      const q = pts[nextIdx]!;
      const segLen = Math.hypot(p.x - q.x, p.y - q.y);
      const k = Math.min(size * 0.7, segLen);
      p.x -= dir.x * k;
      p.y -= dir.y * k;
    };
    shorten(c.startCap, 0, 1, g.startDir);
    shorten(c.endCap, pts.length - 1, pts.length - 2, g.endDir);

    // Rounded bends are one exact arc each instead of their flattened points.
    const arcAt = new Map<number, ConnectorArc>();
    for (const arc of g.arcs ?? []) arcAt.set(arc.from, arc);
    let offset = 0;
    // Direction in and out of every piece, for the joints between them.
    const dirs: number[] = [];
    for (let i = 0; i + 1 < pts.length;) {
      const arc = arcAt.get(i);
      if (arc) {
        this.item(
          arc.cx,
          arc.cy,
          arc.r,
          arc.start,
          hw,
          LINE_ARC,
          dash,
          gap,
          offset,
          depth,
          arc.sweep,
        );
        // Tangents at the ends: the radius turned a quarter in the direction of travel.
        const s = arc.sweep < 0 ? -1 : 1;
        const a1 = arc.start + arc.sweep;
        dirs.push(
          -Math.sin(arc.start) * s,
          Math.cos(arc.start) * s,
          -Math.sin(a1) * s,
          Math.cos(a1) * s,
        );
        offset += arc.r * Math.abs(arc.sweep); // dashes continue along the arc's true length
        i = arc.to;
        continue;
      }
      const a = pts[i]!;
      const b = pts[i + 1]!;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      i++;
      if (len < 1e-6) continue;
      this.item(a.x, a.y, b.x, b.y, hw, LINE_SEGMENT, dash, gap, offset, depth, size);
      const dx = (b.x - a.x) / len;
      const dy = (b.y - a.y) / len;
      dirs.push(dx, dy, dx, dy);
      offset += len;
    }
    this.joinPieces(dirs);
    const cap = (kind: CapKind, tip: Vec2, dir: Vec2) => {
      if (kind === 'none') return;
      this.item(
        tip.x,
        tip.y,
        tip.x - dir.x * size,
        tip.y - dir.y * size,
        hw,
        CAP_MODE[kind],
        0,
        0,
        0,
        depth,
        size,
      );
    };
    cap(c.startCap, g.points[0]!, g.startDir);
    cap(c.endCap, g.points[g.points.length - 1]!, g.endDir);
  }

  private mark(from: number, to: number): void {
    this.dirty.mark(from, to);
  }

  private ensureCapacity(n: number): void {
    if (n * LINE_STRIDE <= this.buffer.byteLength) return;
    const next = new ArrayBuffer(Math.max(n * LINE_STRIDE, this.buffer.byteLength * 2));
    new Uint8Array(next).set(this.u8);
    this.buffer = next;
    this.f32 = new Float32Array(next);
    this.u8 = new Uint8Array(next);
    this.dirty.markAll();
  }
}
