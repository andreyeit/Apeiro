/**
 * The math of the two heaviest pointer gestures, moving and resizing the selection: pure
 * functions of the gesture's start, the pointer and the modifier keys, so `controls.ts`
 * only applies their result (and they can be tested without a DOM).
 */
import {
  fitTextPatch,
  gridStep,
  isShape,
  HANDLE_SIGNS,
  resizeFrame,
  scaleElements,
  snapBox,
  type BoardElement,
  type Box,
  type ElementPatch,
  type FontMeasurer,
  type Frame,
  type ResizeHandle,
  type ShapeElement,
  type SnapGuide,
  type SpacingGuide,
  type Vec2,
} from '@apeiro/core';

/** Smart guides catch an edge this close, screen px. */
export const GUIDE_SNAP_PX = 6;

/** What snapping depends on besides the gesture itself. */
export interface SnapContext {
  zoom: number;
  /** Snapping is on for the board. */
  snapping: boolean;
  /** Modifier keys: Shift locks an axis (moves) or the aspect (resizes) and snaps to the grid. */
  shift: boolean;
  /** Alt resizes from the center. */
  alt: boolean;
  /** Ctrl/⌘: no snapping. */
  deep: boolean;
}

/** The offset of a move and the guides to draw. */
export interface DragStep {
  dx: number;
  dy: number;
  guides: SnapGuide[];
  spacing: SpacingGuide[];
}

/**
 * Offset of the selection being moved from world point `start` to `world`. Shift keeps the
 * dominant axis only, as in Figma; past the click slop (`moved`) the moved `box` snaps to
 * the `targets` (smart guides), and to the grid with Shift.
 */
export function dragStep(
  start: Vec2,
  world: Vec2,
  box: Box | null,
  targets: readonly Box[],
  moved: boolean,
  k: SnapContext,
): DragStep {
  let dx = world.x - start.x;
  let dy = world.y - start.y;
  let lockX = false;
  let lockY = false;
  if (k.shift) {
    if (Math.abs(dx) >= Math.abs(dy)) lockY = true;
    else lockX = true;
    if (lockY) dy = 0;
    else dx = 0;
  }
  if (!k.snapping || !box || !moved || k.deep) return { dx, dy, guides: [], spacing: [] };
  const snap = snapBox(
    { minX: box.minX + dx, minY: box.minY + dy, maxX: box.maxX + dx, maxY: box.maxY + dy },
    targets,
    {
      threshold: GUIDE_SNAP_PX / k.zoom,
      // The grid only with Shift; otherwise the move is free between guides.
      grid: k.shift ? gridStep(k.zoom) : 0,
      lockX,
      lockY,
    },
  );
  return { dx: dx + snap.dx, dy: dy + snap.dy, guides: snap.guides, spacing: snap.spacing };
}

/** A resize as it started. */
export interface ResizeStart {
  handle: ResizeHandle;
  /** The selection's frame and the elements when the drag started. */
  frame: Frame;
  originals: readonly BoardElement[];
  /** Pointer at the start, frame-local. */
  start: Vec2;
  /** Corners keep the aspect ratio by default; Shift inverts it. */
  lockAspect: boolean;
  /** Corners scale the font of text boxes; sides rewrap it. */
  scaleText: boolean;
  /** Boxes of the other elements, for snapping the dragged sides. */
  targets: readonly Box[];
}

/** The elements' patches of a resize step, the guides and the size badge. */
export interface ResizeStep {
  patches: Map<string, ElementPatch>;
  guides: SnapGuide[];
  badge: string;
}

/**
 * The selection resized by the pointer at frame-local point `local`: the frame follows the
 * handle (aspect, from the center), its dragged sides snap (unrotated frames), and the
 * elements are scaled into it; auto-sized text refits with `measurer`.
 */
export function resizeStep(
  m: ResizeStart,
  local: Vec2,
  k: SnapContext,
  measurer?: FontMeasurer,
): ResizeStep {
  const [hx, hy] = HANDLE_SIGNS[m.handle];
  const corner = hx !== 0 && hy !== 0;
  const options = {
    keepAspect: k.shift !== (m.lockAspect && corner),
    fromCenter: k.alt,
    minSize: 2 / k.zoom,
  };
  const delta = { x: local.x - m.start.x, y: local.y - m.start.y };
  const f = m.frame;
  let next = resizeFrame(f, m.handle, delta, options);
  let guides: SnapGuide[] = [];
  // With a locked aspect only the side that drives the size snaps: the other one follows.
  if (k.snapping && f.rotation === 0 && !k.deep) {
    const xDrives = !options.keepAspect || hy === 0 || (hx !== 0 && next.w / f.w >= next.h / f.h);
    const side = (s: number) => (s > 0 ? ['max' as const] : s < 0 ? ['min' as const] : []);
    const snap = snapBox(
      {
        minX: next.cx - next.w / 2,
        maxX: next.cx + next.w / 2,
        minY: next.cy - next.h / 2,
        maxY: next.cy + next.h / 2,
      },
      m.targets,
      {
        threshold: GUIDE_SNAP_PX / k.zoom,
        grid: k.shift ? gridStep(k.zoom) : 0, // the grid only with Shift
        edges: {
          x: xDrives ? side(hx) : [],
          y: !options.keepAspect || !xDrives ? side(hy) : [],
        },
      },
    );
    if (snap.dx !== 0 || snap.dy !== 0)
      next = resizeFrame(f, m.handle, { x: delta.x + snap.dx, y: delta.y + snap.dy }, options);
    guides = snap.guides;
  }
  const patches = scaleElements(m.originals, f, next, {
    scaleText: m.scaleText,
  });
  if (measurer) {
    // Auto-sized text follows its text: e.g. a narrower box wraps and grows taller.
    for (const o of m.originals) {
      const patch = patches.get(o.id);
      if (!patch || o.type !== 'text' || !isShape(o)) continue;
      const fit = fitTextPatch({ ...o, ...patch } as ShapeElement, measurer);
      if (fit) Object.assign(patch, fit);
    }
  }
  return { patches, guides, badge: `${Math.round(next.w)} × ${Math.round(next.h)}` };
}
