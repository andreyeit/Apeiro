import {
  imageRect,
  imageSize,
  groupOf,
  anchorPoint,
  boxIntersects,
  CORNER_HANDLES,
  effectiveRadius,
  HANDLE_SIGNS,
  isShape,
  polygonSides,
  polygonVertices,
  type Box,
  type Frame,
  type Camera,
  type Scene,
  type ShapeElement,
  type Vec2,
  type SnapGuide,
  type SpacingGuide,
} from '@apeiro/core';
import { CanvasSize, MAX_PIXEL_RATIO } from '@apeiro/renderer';
import { enteredGroup } from '../selection/grouping';
import {
  ANCHOR_DOT_RADIUS_PX,
  anchorDot,
  CORNER_HANDLE_PX,
  COUNT_HANDLE_PX,
  countHandlePoint,
  HANDLE_RADIUS_PX,
  RADIUS_HANDLE_RADIUS_PX,
  radiusHandlePoint,
  radiusHandleShape,
  selectionEdgeFrame,
  SIDE_ANCHORS,
} from './handles';

/** color/accent-solid of the design: selection, handles, hover (see `Overlay.accent`). */
export const SELECTION_COLOR = '#2563eb';
/** The accent on a dark board. */
export const SELECTION_COLOR_DARK = '#4f8bff';
/** Inside of handles: color/background of the design, light and dark. */
export const HANDLE_FILL = '#ffffff';
export const HANDLE_FILL_DARK = '#0e0e10';
/** Length of the crop frame's corner brackets (screen px). */
const CROP_HANDLE_PX = 14;
/** Smart guides: Figma's red, distinct from the selection blue. */
const GUIDE = '#f24822';
/** Beyond this many visible selected elements, draw one bounding box instead of outlines. */
const MAX_OUTLINES = 2000;
const CORNER_HANDLE_RADIUS_PX = 2;
/** Border of the selection frame and its handles (screen px). */
const HANDLE_BORDER_PX = 1.5;

/** Adds the shape's outline (rounded corners, polygon, ellipse) to the path, in local coordinates. */
export function traceShape(ctx: CanvasRenderingContext2D, s: ShapeElement, grow = 0): void {
  const hw = s.w / 2 + grow;
  const hh = s.h / 2 + grow;
  if (s.type === 'ellipse') {
    ctx.ellipse(0, 0, hw, hh, 0, 0, Math.PI * 2);
    return;
  }
  const r = effectiveRadius(s);
  if (s.type === 'polygon') {
    const v = polygonVertices(s.w, s.h, polygonSides(s));
    const n = v.length;
    // Tangent arcs at every corner: the same rounding the shader draws.
    const mid = (a: Vec2, b: Vec2) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const start = mid(v[n - 1]!, v[0]!);
    ctx.moveTo(start.x, start.y);
    for (let i = 0; i < n; i++) {
      const p = v[i]!;
      const q = v[(i + 1) % n]!;
      ctx.arcTo(p.x, p.y, q.x, q.y, r);
    }
    ctx.closePath();
    return;
  }
  if (r > 0) ctx.roundRect(-hw, -hh, hw * 2, hh * 2, r + grow);
  else ctx.rect(-hw, -hh, hw * 2, hh * 2);
}

/**
 * Lightweight 2D canvas on top of the WebGL canvas for transient UI: selection,
 * marquee, hover, connection dots and drop targets. Few elements, redrawn on change.
 */
/** Extra drawing on the overlay, see `Overlay.addLayer`. */
export type OverlayLayer = (ctx: CanvasRenderingContext2D, zoom: number) => void;

export class Overlay {
  private ctx: CanvasRenderingContext2D;
  private frame = 0;
  private selected = new Set<string>();
  /**
   * Elements this user may not select or edit (another participant is working on them).
   * Assigning `selection` drops them; call `releaseLocked` when the answer changes.
   */
  isLocked: (id: string) => boolean = () => false;

  /** Selected element ids. Locked elements (see `isLocked`) are left out when assigned. */
  get selection(): Set<string> {
    return this.selected;
  }

  set selection(ids: Set<string>) {
    let locked = false;
    for (const id of ids) if (this.isLocked(id)) locked = true;
    this.selected = locked ? new Set([...ids].filter((id) => !this.isLocked(id))) : ids;
  }

  /** Drops elements that became locked from the selection; true if any were selected. */
  releaseLocked(): boolean {
    const before = this.selected.size;
    this.selection = this.selected;
    if (this.hover && this.isLocked(this.hover)) this.hover = null;
    if (this.selected.size === before) return false;
    this.request();
    return true;
  }
  marquee: Box | null = null;
  /** Smart guides of the move or resize in progress (see `snapBox`). */
  guides: SnapGuide[] = [];
  /** Equal-spacing guides of the move in progress. */
  spacing: SpacingGuide[] = [];
  /** Ctrl/⌘ held (deep select): hover outlines the element itself, not its group. */
  deep = false;
  hover: string | null = null;
  /** Shape whose connection dots are shown. */
  anchorsFor: string | null = null;
  /** The connection dot under the pointer (of `anchorsFor`), drawn highlighted. */
  hoverDot: Vec2 | null = null;
  /** Shape a dragged connector end would attach to, and the snapped anchor (if any). */
  target: string | null = null;
  snap: Vec2 | null = null;
  /** The radius handle is hovered or dragged: drawn filled. */
  radiusActive = false;
  /** The polygon's corner-count handle is hovered or dragged; `countLabel`: the count shown while dragging. */
  countActive = false;
  countLabel: number | null = null;
  /** Image in crop mode: its frame has crop handles and the rest of the image shows faded. */
  cropping: string | null = null;
  /** Images of crop mode by src (drawn faded around the frame). */
  private images = new Map<string, HTMLImageElement>();
  /** Show the transform frame around the selection (off for the connector tool). */
  transformEnabled = true;
  /** A read-only board: the selection is outlined, without handles or connection dots. */
  readOnly = false;
  /** Called after every overlay redraw, e.g. to sync a panel with the selection. */
  onDraw: (() => void) | null = null;
  /** Color of the selection, handles and hover (`SELECTION_COLOR_DARK` on a dark board). */
  accent = SELECTION_COLOR;
  /** Inside of handles: the board background (`HANDLE_FILL_DARK` on a dark board). */
  handleFill = HANDLE_FILL;
  /** Shown under the selection while it is resized or rotated: its size or angle. */
  badge: string | null = null;
  /**
   * Element whose text is being edited: drawn with just its outline, without handles or
   * connection dots (set by the text editor's `onStart`/`onStop`).
   */
  editing: string | null = null;
  private layers = new Set<OverlayLayer>();
  private readonly size: CanvasSize;
  /** Device pixels per CSS pixel of the drawing buffer (see `resize`). */
  private ratio = 1;

  constructor(
    private canvas: HTMLCanvasElement,
    private scene: Scene,
    private camera: Camera,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.size = new CanvasSize(canvas, () => this.resize());
  }

  /** Matches the drawing buffer to the canvas on screen, pixel for pixel (watched by itself too). */
  resize(): void {
    const m = this.size.measure(MAX_PIXEL_RATIO);
    this.size.apply(m);
    this.ratio = m.ratio;
    this.request();
  }

  request(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  /** Stops drawing and watching the canvas size (the overlay of an unmounted board). */
  dispose(): void {
    this.size.dispose();
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  /** The single selected connector, if exactly one is selected. */
  selectedConnector(): string | null {
    if (this.selection.size !== 1) return null;
    const id = this.selection.values().next().value!;
    return this.scene.get(id)?.type === 'connector' ? id : null;
  }

  draw(): void {
    const { ctx, camera } = this;
    const dpr = this.ratio;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // World → device pixels in one transform; line widths are divided by zoom to stay constant.
    const z = camera.zoom;
    ctx.setTransform(dpr * z, 0, 0, dpr * z, -camera.x * z * dpr, -camera.y * z * dpr);
    const view = camera.viewportBounds();

    // Groups: a dashed frame around the group under the pointer, and around the group
    // the selection is inside of (its elements are being picked one by one).
    const inside = enteredGroup(this.scene, this.selection);
    if (inside) this.groupFrame(inside, z, 0.7);
    // A locked element is not picked: no hover feedback for it.
    const hover = this.hover && !this.isLocked(this.hover) ? this.hover : null;
    const hovered = hover ? this.scene.get(hover) : undefined;
    const hoverGroup = hovered && !inside && !this.deep ? groupOf(this.scene, hovered) : null;
    if (hoverGroup && !hoverGroup.every((id) => this.selection.has(id)))
      this.groupFrame(hoverGroup, z, 0.6);
    else if (hover && !this.selection.has(hover) && hover !== this.editing)
      this.outline(hover, view, 1.5 / z, 0.6, this.accent);

    if (this.selection.size > 0) {
      let drawn = 0;
      for (const id of this.selection) {
        if (drawn >= MAX_OUTLINES) break;
        const b = this.scene.getBounds(id);
        if (!b || !boxIntersects(b, view)) continue;
        this.outline(id, view, 1.5 / z, 1, this.accent);
        drawn++;
      }
    }
    // Text being edited: one outline on its edge, the only focus mark (no DOM outline).
    if (this.editing && !this.selection.has(this.editing))
      this.outline(this.editing, view, 1.5 / z, 1, this.accent);

    // Transform frame with corner handles, and while resizing or rotating a badge with the
    // size or the angle. None while text is being edited: typing, not transforming.
    const frame =
      this.transformEnabled && !this.readOnly && !this.cropping && !this.editing
        ? selectionEdgeFrame(this.scene, this.selection)
        : null;
    if (frame) this.drawTransformFrame(frame, z);
    if (this.badge && this.selection.size > 0 && !this.editing) this.drawBadge(this.badge, z);

    this.drawGuides(z);
    this.drawSpacing(z);

    const connector = this.readOnly ? null : this.selectedConnector();
    if (connector) {
      const g = this.scene.connectorGeometry(connector);
      if (g) {
        this.handle(g.points[0]!, z);
        this.handle(g.points[g.points.length - 1]!, z);
        if (g.handle) this.bendHandle(g.handle.point, g.handle.axis, z);
      }
    }

    // Connection dots: not on a selected element (its handles are there instead).
    if (
      this.anchorsFor &&
      this.anchorsFor !== this.editing &&
      !this.selection.has(this.anchorsFor) &&
      !this.readOnly
    ) {
      const s = this.scene.get(this.anchorsFor);
      if (s && isShape(s)) {
        for (const a of SIDE_ANCHORS) {
          const hovered =
            this.hoverDot !== null && this.hoverDot.x === a.x && this.hoverDot.y === a.y;
          if (hovered) this.plusDot(anchorDot(s, a, z), z);
          else this.dot(anchorDot(s, a, z), z, this.accent, 1, false, ANCHOR_DOT_RADIUS_PX);
        }
      }
    }
    if (this.target) {
      // Magnets on the drop target (no outline: the dots say where the end attaches); the
      // one the end is attached to is filled.
      const s = this.scene.get(this.target);
      if (s && isShape(s)) {
        for (const a of SIDE_ANCHORS) this.dot(anchorPoint(s, a), z, this.accent, 0.5);
        if (this.snap) this.dot(anchorPoint(s, this.snap), z, this.accent, 1, true);
      }
    }

    if (this.marquee) {
      const m = this.marquee;
      ctx.fillStyle = this.accent;
      ctx.strokeStyle = this.accent;
      ctx.lineWidth = 1 / z;
      ctx.globalAlpha = 0.08;
      ctx.fillRect(m.minX, m.minY, m.maxX - m.minX, m.maxY - m.minY);
      ctx.globalAlpha = 1;
      ctx.strokeRect(m.minX, m.minY, m.maxX - m.minX, m.maxY - m.minY);
    }

    // Corner-radius handle of the selected shape, as in Figma.
    // Corner-radius handle (top-left corner, a polygon's top vertex), as in Figma.
    const rounded =
      this.cropping || this.editing || this.readOnly
        ? null
        : radiusHandleShape(this.scene, this.selection, z);
    if (rounded) {
      const p = radiusHandlePoint(rounded, z);
      ctx.beginPath();
      ctx.arc(p.x, p.y, RADIUS_HANDLE_RADIUS_PX / z, 0, Math.PI * 2);
      ctx.fillStyle = this.radiusActive ? this.accent : this.handleFill;
      ctx.fill();
      ctx.lineWidth = 1.5 / z;
      ctx.strokeStyle = this.accent;
      ctx.stroke();
      if (rounded.type === 'polygon') this.drawCountHandle(rounded, z);
    }
    this.drawCrop(z);
    for (const layer of this.layers) {
      ctx.save();
      ctx.setTransform(dpr * z, 0, 0, dpr * z, -camera.x * z * dpr, -camera.y * z * dpr);
      layer(ctx, z);
      ctx.restore();
    }
    this.onDraw?.();
  }

  /**
   * Draws `layer` on top of the overlay after every redraw, in world coordinates (divide
   * line widths and sizes by `zoom` to keep them constant on screen), e.g. other users'
   * cursors. Returns a function that removes it.
   */
  addLayer(layer: OverlayLayer): () => void {
    this.layers.add(layer);
    this.request();
    return () => {
      this.layers.delete(layer);
      this.request();
    };
  }

  /**
   * The selection's transform frame, as in the design (Selection / Handle): a 1.5px accent
   * outline and four 8×8 corner handles, radius 2, a 1.5px accent border inside, filled
   * with the board background. The edges resize and the area just outside the corners
   * rotates; the cursor shows it.
   */
  private drawTransformFrame(frame: Frame, z: number): void {
    const { ctx } = this;
    ctx.save();
    ctx.translate(frame.cx, frame.cy);
    ctx.rotate(frame.rotation);
    ctx.strokeStyle = this.accent;
    const line = HANDLE_BORDER_PX / z;
    ctx.lineWidth = line;
    // The line runs just outside the edge (the canvas strokes on the path's center line).
    const w = frame.w + line;
    const h = frame.h + line;
    ctx.strokeRect(-w / 2, -h / 2, w, h);
    // Centered on the corners. A path half a border smaller makes the border fall inside the
    // 8px, like CSS borders in the design.
    const s = (CORNER_HANDLE_PX - HANDLE_BORDER_PX) / z;
    const r = (CORNER_HANDLE_RADIUS_PX - HANDLE_BORDER_PX / 2) / z;
    ctx.fillStyle = this.handleFill;
    for (const handle of CORNER_HANDLES) {
      const [hx, hy] = HANDLE_SIGNS[handle];
      ctx.beginPath();
      ctx.roundRect((hx * w) / 2 - s / 2, (hy * h) / 2 - s / 2, s, s, r);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  /** A label under the selection (its size while resizing, its angle while rotating). */
  private drawBadge(text: string, z: number): void {
    const b = this.scene.bounds(this.selection);
    if (!b) return;
    const { ctx } = this;
    ctx.save();
    ctx.font = `600 ${11 / z}px Geist, Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width + 14 / z;
    const h = 20 / z;
    const x = (b.minX + b.maxX) / 2;
    const y = b.maxY + 14 / z + h / 2;
    ctx.fillStyle = this.accent;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - h / 2, w, h, 5 / z);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(text, x, y + 0.5 / z);
    ctx.restore();
  }

  /** The polygon's corner-count handle (a diamond), and the count while it is dragged. */
  private drawCountHandle(s: ShapeElement, z: number): void {
    const { ctx } = this;
    const p = countHandlePoint(s, z);
    const k = COUNT_HANDLE_PX / z;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(s.rotation + Math.PI / 4);
    ctx.beginPath();
    ctx.rect(-k / 2 - 0.5 / z, -k / 2 - 0.5 / z, k + 1 / z, k + 1 / z);
    ctx.fillStyle = this.countActive ? this.accent : this.handleFill;
    ctx.fill();
    ctx.lineWidth = 1.5 / z;
    ctx.strokeStyle = this.accent;
    ctx.stroke();
    ctx.restore();
    if (this.countLabel === null) return;
    const text = String(this.countLabel);
    ctx.save();
    ctx.font = `600 ${12 / z}px Geist, Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width + 12 / z;
    const h = 20 / z;
    const x = p.x + 18 / z;
    const y = p.y - 18 / z;
    ctx.fillStyle = this.accent;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - h / 2, w, h, 4 / z);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  /** The decoded image for crop mode (loads once; redraws when it arrives). */
  private imageOf(src: string): HTMLImageElement | null {
    let img = this.images.get(src);
    if (!img) {
      img = new Image();
      img.decoding = 'async';
      img.onload = () => this.request();
      img.src = src;
      this.images.set(src, img);
    }
    return img.complete && img.naturalWidth > 0 ? img : null;
  }

  /**
   * Crop mode, as in Figma: the image outside the frame shows faded with a thin outline,
   * and the frame gets crop handles (corner brackets and side bars).
   */
  private drawCrop(z: number): void {
    const el = this.cropping ? this.scene.get(this.cropping) : undefined;
    if (!el || !isShape(el) || el.type !== 'image' || !el.media) return;
    const { ctx } = this;
    const img = this.imageOf(el.media.src);
    const r = imageRect(
      el,
      imageSize(el, img ? { w: img.naturalWidth, h: img.naturalHeight } : null),
    );
    ctx.save();
    ctx.translate(el.x + el.w / 2, el.y + el.h / 2);
    ctx.rotate(el.rotation);
    ctx.translate(-el.w / 2, -el.h / 2);
    // The part of the image outside the frame: faded.
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.rect(0, 0, el.w, el.h);
    ctx.clip('evenodd');
    ctx.globalAlpha = 0.35;
    if (img) ctx.drawImage(img, r.x, r.y, r.w, r.h);
    else {
      ctx.fillStyle = 'rgba(120, 120, 128, 0.5)';
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    ctx.restore();
    ctx.lineWidth = 1 / z;
    ctx.strokeStyle = this.accent;
    ctx.globalAlpha = 0.5;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.globalAlpha = 1;
    // The image's own corner handles: drag to scale it (Figma).
    const s = CORNER_HANDLE_PX / z;
    ctx.fillStyle = this.handleFill;
    ctx.strokeStyle = this.accent;
    ctx.lineWidth = 1.5 / z;
    for (const [x, y] of [
      [r.x, r.y],
      [r.x + r.w, r.y],
      [r.x, r.y + r.h],
      [r.x + r.w, r.y + r.h],
    ] as const) {
      ctx.beginPath();
      ctx.roundRect(x - s / 2, y - s / 2, s, s, 2 / z);
      ctx.fill();
      ctx.stroke();
    }
    // The crop frame.
    ctx.lineWidth = 1.5 / z;
    ctx.strokeStyle = this.accent;
    ctx.strokeRect(0, 0, el.w, el.h);
    // Handles: white brackets with a dark edge, readable on any image.
    const len = Math.min(CROP_HANDLE_PX / z, el.w / 3, el.h / 3);
    const bar = Math.min(CROP_HANDLE_PX / z, el.w / 3, el.h / 3) / 2;
    ctx.lineCap = 'square';
    const path = () => {
      ctx.beginPath();
      for (const [x, y, dx, dy] of [
        [0, 0, 1, 1],
        [el.w, 0, -1, 1],
        [0, el.h, 1, -1],
        [el.w, el.h, -1, -1],
      ] as const) {
        ctx.moveTo(x + dx * len, y);
        ctx.lineTo(x, y);
        ctx.lineTo(x, y + dy * len);
      }
      ctx.moveTo(el.w / 2 - bar, 0);
      ctx.lineTo(el.w / 2 + bar, 0);
      ctx.moveTo(el.w / 2 - bar, el.h);
      ctx.lineTo(el.w / 2 + bar, el.h);
      ctx.moveTo(0, el.h / 2 - bar);
      ctx.lineTo(0, el.h / 2 + bar);
      ctx.moveTo(el.w, el.h / 2 - bar);
      ctx.lineTo(el.w, el.h / 2 + bar);
    };
    path();
    ctx.lineWidth = 6 / z;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.stroke();
    path();
    ctx.lineWidth = 4 / z;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.restore();
  }

  private handle(p: Vec2, z: number): void {
    const { ctx } = this;
    ctx.beginPath();
    ctx.arc(p.x, p.y, HANDLE_RADIUS_PX / z, 0, Math.PI * 2);
    ctx.fillStyle = this.handleFill;
    ctx.fill();
    ctx.lineWidth = 1.5 / z;
    ctx.strokeStyle = this.accent;
    ctx.stroke();
  }

  /** Filled handle in the middle of a line: a dot for curves, a pill across the elbow's middle segment. */
  private bendHandle(p: Vec2, axis: 'x' | 'y' | undefined, z: number): void {
    const { ctx } = this;
    ctx.beginPath();
    if (axis) {
      const long = 12 / z;
      const short = 6 / z;
      const w = axis === 'x' ? short : long;
      const h = axis === 'x' ? long : short;
      ctx.roundRect(p.x - w / 2, p.y - h / 2, w, h, short / 2);
    } else {
      ctx.arc(p.x, p.y, HANDLE_RADIUS_PX / z, 0, Math.PI * 2);
    }
    ctx.fillStyle = this.accent;
    ctx.fill();
    ctx.lineWidth = 1.5 / z;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
  }

  /** Hovered connection dot: larger, filled, with a plus — "drag to connect, click to add". */
  private plusDot(p: Vec2, z: number): void {
    const { ctx } = this;
    const r = (ANCHOR_DOT_RADIUS_PX + 3) / z;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = this.accent;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5 / z;
    const k = r * 0.5;
    ctx.beginPath();
    ctx.moveTo(p.x - k, p.y);
    ctx.lineTo(p.x + k, p.y);
    ctx.moveTo(p.x, p.y - k);
    ctx.lineTo(p.x, p.y + k);
    ctx.stroke();
  }

  private dot(
    p: Vec2,
    z: number,
    color: string,
    alpha = 1,
    filled = false,
    radiusPx = filled ? 6 : 4.5,
  ): void {
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(p.x, p.y, radiusPx / z, 0, Math.PI * 2);
    ctx.fillStyle = filled ? color : this.handleFill;
    ctx.fill();
    ctx.lineWidth = 1.5 / z;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.restore();
  }

  /** Smart guides: thin lines with small crosses at the aligned points, as in Figma. */
  private drawGuides(z: number): void {
    if (this.guides.length === 0) return;
    const { ctx } = this;
    const k = 3 / z; // half size of a cross
    ctx.save();
    ctx.strokeStyle = GUIDE;
    ctx.lineWidth = 1 / z;
    ctx.beginPath();
    for (const g of this.guides) {
      if (g.axis === 'x') {
        ctx.moveTo(g.at, g.from);
        ctx.lineTo(g.at, g.to);
        for (const m of g.marks) {
          ctx.moveTo(g.at - k, m - k);
          ctx.lineTo(g.at + k, m + k);
          ctx.moveTo(g.at + k, m - k);
          ctx.lineTo(g.at - k, m + k);
        }
      } else {
        ctx.moveTo(g.from, g.at);
        ctx.lineTo(g.to, g.at);
        for (const m of g.marks) {
          ctx.moveTo(m - k, g.at - k);
          ctx.lineTo(m + k, g.at + k);
          ctx.moveTo(m + k, g.at - k);
          ctx.lineTo(m - k, g.at + k);
        }
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Equal spacing, as in Figma: each equal gap gets a line across it with end ticks and
   * a label with the distance.
   */
  private drawSpacing(z: number): void {
    if (this.spacing.length === 0) return;
    const { ctx } = this;
    const tick = 4 / z;
    ctx.save();
    ctx.strokeStyle = GUIDE;
    ctx.lineWidth = 1 / z;
    ctx.beginPath();
    for (const g of this.spacing) {
      for (const s of g.segments) {
        if (g.axis === 'x') {
          ctx.moveTo(s.from, s.at);
          ctx.lineTo(s.to, s.at);
          for (const e of [s.from, s.to]) {
            ctx.moveTo(e, s.at - tick);
            ctx.lineTo(e, s.at + tick);
          }
        } else {
          ctx.moveTo(s.at, s.from);
          ctx.lineTo(s.at, s.to);
          for (const e of [s.from, s.to]) {
            ctx.moveTo(s.at - tick, e);
            ctx.lineTo(s.at + tick, e);
          }
        }
      }
    }
    ctx.stroke();
    // Labels: white text on a red pill, centered on each gap.
    ctx.font = `500 ${11 / z}px Geist, Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const g of this.spacing) {
      const text = String(Math.round(g.distance));
      const w = ctx.measureText(text).width + 8 / z;
      const h = 16 / z;
      for (const s of g.segments) {
        const mid = (s.from + s.to) / 2;
        const [cx, cy] = g.axis === 'x' ? [mid, s.at + h] : [s.at + w / 2 + 6 / z, mid];
        ctx.fillStyle = GUIDE;
        ctx.beginPath();
        ctx.roundRect(cx - w / 2, cy - h / 2, w, h, 3 / z);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillText(text, cx, cy);
      }
    }
    ctx.restore();
  }

  /** Dashed box around a group's elements. */
  private groupFrame(ids: readonly string[], z: number, alpha: number): void {
    const b = this.scene.bounds(ids);
    if (!b) return;
    const pad = 4 / z;
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = this.accent;
    ctx.lineWidth = 1 / z;
    ctx.setLineDash([4 / z, 3 / z]);
    ctx.strokeRect(
      b.minX - pad,
      b.minY - pad,
      b.maxX - b.minX + pad * 2,
      b.maxY - b.minY + pad * 2,
    );
    ctx.restore();
  }

  /**
   * Another participant's selection: the same element outlines and frame as a selection
   * here, in their color, without handles. For an overlay layer (world transform set).
   */
  drawForeignSelection(ids: ReadonlySet<string>, color: string): void {
    if (ids.size === 0) return;
    const { ctx, camera } = this;
    const z = camera.zoom;
    const view = camera.viewportBounds();
    let drawn = 0;
    for (const id of ids) {
      if (drawn >= MAX_OUTLINES) break;
      const b = this.scene.getBounds(id);
      if (!b || !boxIntersects(b, view)) continue;
      this.outline(id, view, 1.5 / z, 1, color);
      drawn++;
    }
    const frame = selectionEdgeFrame(this.scene, ids);
    if (!frame) return;
    ctx.save();
    ctx.translate(frame.cx, frame.cy);
    ctx.rotate(frame.rotation);
    ctx.strokeStyle = color;
    const line = HANDLE_BORDER_PX / z;
    ctx.lineWidth = line;
    ctx.strokeRect(-(frame.w + line) / 2, -(frame.h + line) / 2, frame.w + line, frame.h + line);
    ctx.restore();
  }

  private outline(id: string, view: Box, width: number, alpha: number, color: string): void {
    const el = this.scene.get(id);
    const b = this.scene.getBounds(id);
    if (!el || !b || !boxIntersects(b, view)) return;
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    if (isShape(el)) {
      ctx.translate(el.x + el.w / 2, el.y + el.h / 2);
      ctx.rotate(el.rotation);
      // Just outside the shape's outer edge (its border included), not over it.
      traceShape(ctx, el, el.strokeWidth / 2 + width / 2);
      ctx.stroke();
    } else {
      // A halo along the line, wider than the stroke.
      const g = this.scene.connectorGeometry(id);
      if (g) {
        ctx.lineWidth = el.strokeWidth + width * 4;
        ctx.globalAlpha = alpha * 0.35;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.moveTo(g.points[0]!.x, g.points[0]!.y);
        for (const p of g.points.slice(1)) ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}
