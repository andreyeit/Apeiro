import {
  anchorPoint,
  boxFrame,
  CORNER_HANDLES,
  HANDLE_SIGNS,
  hasCornerRadius,
  isShape,
  polygonSides,
  polygonVertices,
  radiusHandleLocal,
  shapeFrame,
  worldToFrame,
  type Frame,
  type ResizeHandle,
  type Scene,
  type ShapeElement,
  type Vec2,
} from '@apeiro/core';

// Where the selection's handles are, in world space, and which one a point grabs. Shared
// by the overlay (which draws them) and the input controls (which hit-test them).

export const SIDE_ANCHORS: readonly Vec2[] = [
  { x: 0.5, y: 0 },
  { x: 1, y: 0.5 },
  { x: 0.5, y: 1 },
  { x: 0, y: 0.5 },
];
/** Connection dots sit this far outside the shape (screen px) so they don't fight with dragging. */
export const ANCHOR_DOT_OFFSET_PX = 16;
export const ANCHOR_DOT_RADIUS_PX = 6;
export const HANDLE_RADIUS_PX = 5;

/** Screen-space position of the connection dot for a side anchor. */
export function anchorDot(s: ShapeElement, anchor: Vec2, zoom: number): Vec2 {
  const p = anchorPoint(s, anchor);
  const local = { x: anchor.x - 0.5, y: anchor.y - 0.5 };
  const len = Math.hypot(local.x, local.y) || 1;
  const c = Math.cos(s.rotation);
  const sn = Math.sin(s.rotation);
  const dir = { x: (local.x * c - local.y * sn) / len, y: (local.x * sn + local.y * c) / len };
  const off = ANCHOR_DOT_OFFSET_PX / zoom;
  return { x: p.x + dir.x * off, y: p.y + dir.y * off };
}

/** Radius handle: never closer than this to the corner (screen px), so it's grabbable at 0. */
export const RADIUS_HANDLE_MIN_PX = 14;
export const RADIUS_HANDLE_RADIUS_PX = 4.5;
/** Shapes smaller than this on screen get no radius handle (it would cover them). */
export const RADIUS_HANDLE_MIN_SHAPE_PX = 48;

/** Element-local (centered, unrotated) point → world. */
export function localToWorld(s: ShapeElement, p: Vec2): Vec2 {
  const c = Math.cos(s.rotation);
  const sn = Math.sin(s.rotation);
  return { x: s.x + s.w / 2 + p.x * c - p.y * sn, y: s.y + s.h / 2 + p.x * sn + p.y * c };
}

/** World point → element-local (centered, unrotated). */
export function worldToLocal(s: ShapeElement, p: Vec2): Vec2 {
  const c = Math.cos(-s.rotation);
  const sn = Math.sin(-s.rotation);
  const dx = p.x - (s.x + s.w / 2);
  const dy = p.y - (s.y + s.h / 2);
  return { x: dx * c - dy * sn, y: dx * sn + dy * c };
}

/** World position of the corner-radius handle of a shape at this zoom. */
export function radiusHandlePoint(s: ShapeElement, zoom: number): Vec2 {
  return localToWorld(s, radiusHandleLocal(s, RADIUS_HANDLE_MIN_PX / zoom));
}

/** The corner-count handle of a polygon sits this far inside the middle of its first side (screen px). */
export const COUNT_HANDLE_INSET_PX = 16;
export const COUNT_HANDLE_PX = 5;

/**
 * World position of a polygon's corner-count handle: inside the middle of the side
 * between the top vertex and the next one, as Figma's count handle. Dragging it around
 * the center adds or removes corners.
 */
export function countHandlePoint(s: ShapeElement, zoom: number): Vec2 {
  const v = polygonVertices(s.w, s.h, polygonSides(s));
  const m = { x: (v[0]!.x + v[1]!.x) / 2, y: (v[0]!.y + v[1]!.y) / 2 };
  const l = Math.hypot(m.x, m.y) || 1;
  const inset = Math.min(COUNT_HANDLE_INSET_PX / zoom, l * 0.5);
  return localToWorld(s, { x: m.x - (m.x / l) * inset, y: m.y - (m.y / l) * inset });
}

/**
 * Corner count for a pointer dragged around a polygon's center: the count handle sits at
 * an angle of π / n from the top vertex (measured in the box stretched to a square), so
 * an angle θ means n = π / θ. Clamped to 3..12.
 */
export function countAtAngle(s: ShapeElement, world: Vec2): number {
  const l = worldToLocal(s, world);
  const theta = Math.atan2(l.x / Math.max(s.w / 2, 1e-6), -l.y / Math.max(s.h / 2, 1e-6));
  if (theta <= 0) return 12;
  return Math.min(12, Math.max(3, Math.round(Math.PI / theta)));
}

/** The shape that shows a radius handle: the single selected shape with corners, large enough on screen. */
export function radiusHandleShape(
  scene: Scene,
  selection: ReadonlySet<string>,
  zoom: number,
): ShapeElement | null {
  if (selection.size !== 1) return null;
  const el = scene.get(selection.values().next().value!);
  if (!el || !isShape(el) || !hasCornerRadius(el)) return null;
  return Math.min(el.w, el.h) * zoom >= RADIUS_HANDLE_MIN_SHAPE_PX ? el : null;
}

/** Corner resize handles: drawn size and grab radius, screen px. */
export const CORNER_HANDLE_PX = 8;
const CORNER_HIT_PX = 9;
/** Edges resize within this distance of the frame (screen px). */
const EDGE_HIT_PX = 6;
/** Just outside a corner, up to this far, the pointer rotates (screen px). */
const ROTATE_ZONE_PX = 24;

/**
 * Frame that transforms the selection: one shape gets its own rotated box, several
 * elements an axis-aligned box around them. A lone connector has its own handles instead.
 */
export function selectionFrame(scene: Scene, selection: ReadonlySet<string>): Frame | null {
  if (selection.size === 0) return null;
  if (selection.size === 1) {
    const el = scene.get(selection.values().next().value!);
    if (!el || !isShape(el)) return null;
    return shapeFrame(el);
  }
  const box = scene.bounds(selection);
  return box ? boxFrame(box) : null;
}

/**
 * The transform frame as drawn and grabbed: on the outer edge of what is selected. A lone
 * shape's frame (its geometric box, through the middle of its border) grows by half the
 * border; the bounds of several elements include their borders already. Resizing still
 * works on `selectionFrame`, the geometry.
 */
export function selectionEdgeFrame(scene: Scene, selection: ReadonlySet<string>): Frame | null {
  const frame = selectionFrame(scene, selection);
  if (!frame || selection.size !== 1) return frame;
  const el = scene.get(selection.values().next().value!);
  const border = el && isShape(el) ? el.strokeWidth : 0;
  return border > 0 ? { ...frame, w: frame.w + border, h: frame.h + border } : frame;
}

export type TransformHit =
  | { kind: 'resize'; handle: ResizeHandle }
  | { kind: 'rotate'; corner: ResizeHandle };

/** Which part of the transform frame is under world point `world` at this zoom. */
export function transformHandleAt(frame: Frame, world: Vec2, zoom: number): TransformHit | null {
  const l = worldToFrame(frame, world);
  const x = l.x * zoom; // screen px in the frame's axes
  const y = l.y * zoom;
  const hw = (frame.w / 2) * zoom;
  const hh = (frame.h / 2) * zoom;
  for (const handle of CORNER_HANDLES) {
    const [sx, sy] = HANDLE_SIGNS[handle];
    if (Math.hypot(x - sx * hw, y - sy * hh) <= CORNER_HIT_PX) return { kind: 'resize', handle };
  }
  // Edges, between the corner handles (skipped when the frame is too small on screen).
  if (hw > CORNER_HIT_PX * 1.5 && Math.abs(x) <= hw - CORNER_HIT_PX) {
    if (Math.abs(y + hh) <= EDGE_HIT_PX) return { kind: 'resize', handle: 'n' };
    if (Math.abs(y - hh) <= EDGE_HIT_PX) return { kind: 'resize', handle: 's' };
  }
  if (hh > CORNER_HIT_PX * 1.5 && Math.abs(y) <= hh - CORNER_HIT_PX) {
    if (Math.abs(x + hw) <= EDGE_HIT_PX) return { kind: 'resize', handle: 'w' };
    if (Math.abs(x - hw) <= EDGE_HIT_PX) return { kind: 'resize', handle: 'e' };
  }
  for (const corner of CORNER_HANDLES) {
    const [sx, sy] = HANDLE_SIGNS[corner];
    const out = { x: (x - sx * hw) * sx, y: (y - sy * hh) * sy }; // > 0: outside that side
    if ((out.x > 0 || out.y > 0) && out.x > -CORNER_HIT_PX && out.y > -CORNER_HIT_PX) {
      if (Math.hypot(Math.max(out.x, 0), Math.max(out.y, 0)) <= ROTATE_ZONE_PX)
        return { kind: 'rotate', corner };
    }
  }
  return null;
}

/** A curved-arrow cursor for rotating (data URL SVG with a fallback). */
export const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
    '<path d="M6 15a7 7 0 1 0 2-8.5" fill="none" stroke="white" stroke-width="4" stroke-linecap="round"/>' +
    '<path d="M6 15a7 7 0 1 0 2-8.5" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round"/>' +
    '<path d="M3.5 4.5 8.5 6.5 6 11z" fill="black" stroke="white" stroke-width="1"/></svg>',
)}") 12 12, alias`;
