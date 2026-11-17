import { radiusCorner, type Frame, type ShapeElement, type Vec2 } from '@apeiro/core';
import {
  anchorDot,
  COUNT_HANDLE_PX,
  countHandlePoint,
  RADIUS_HANDLE_RADIUS_PX,
  radiusHandlePoint,
  radiusHandleShape,
  selectionEdgeFrame,
  selectionFrame,
  SIDE_ANCHORS,
  transformHandleAt,
  worldToLocal,
  type TransformHit,
} from '../overlay/handles';
import { DOT_HIT_PX, HANDLE_HIT_PX } from './constants';
import type { InputContext } from './context';

// What a pointer at a screen point would grab: the handles drawn by the overlay. Each
// returns null when the handle is not shown (another tool, a read-only board…).

/** Handles of the selection are live only with the select tool on an editable board. */
const handlesLive = (c: InputContext): boolean => c.tools.tool === 'select' && !c.readOnly();

/** Transform frame of the selection and the part of it under a world point. */
export function transformAt(
  c: InputContext,
  world: Vec2,
): { frame: Frame; hit: TransformHit } | null {
  if (!handlesLive(c)) return null;
  const frame = selectionFrame(c.scene, c.overlay.selection);
  const edge = selectionEdgeFrame(c.scene, c.overlay.selection);
  if (!frame || !edge) return null;
  // Grabbed where the handles are drawn (the outer edge); resized as geometry.
  const hit = transformHandleAt(edge, world, c.camera.zoom);
  return hit ? { frame, hit } : null;
}

/** The shape whose radius handle (top-left corner, a polygon's top vertex) is under `p`. */
export function radiusHandleAt(c: InputContext, p: Vec2): ShapeElement | null {
  if (!handlesLive(c)) return null;
  const s = radiusHandleShape(c.scene, c.overlay.selection, c.camera.zoom);
  if (!s) return null;
  const d = c.screenDist(p, radiusHandlePoint(s, c.camera.zoom));
  return d <= RADIUS_HANDLE_RADIUS_PX + 5 ? s : null;
}

/** The polygon whose corner-count handle is under screen point `p`. */
export function countHandleAt(c: InputContext, p: Vec2): ShapeElement | null {
  if (!handlesLive(c)) return null;
  const s = radiusHandleShape(c.scene, c.overlay.selection, c.camera.zoom);
  if (!s || s.type !== 'polygon') return null;
  return c.screenDist(p, countHandlePoint(s, c.camera.zoom)) <= COUNT_HANDLE_PX + 5 ? s : null;
}

/** How far a world point is from the rounded corner, measured along its bisector (local units). */
export function alongBisector(s: ShapeElement, world: Vec2): number {
  const corner = radiusCorner(s);
  const l = worldToLocal(s, world);
  return (l.x - corner.vertex.x) * corner.inward.x + (l.y - corner.vertex.y) * corner.inward.y;
}

/** Connection dot of the shape whose dots are shown, under screen point `p`. */
export function dotAt(c: InputContext, p: Vec2): { shape: ShapeElement; anchor: Vec2 } | null {
  if (!handlesLive(c) || !c.overlay.anchorsFor) return null;
  if (c.overlay.selection.has(c.overlay.anchorsFor)) return null; // no dots on a selected element
  const s = c.getShape(c.overlay.anchorsFor);
  if (!s || !c.showsDots(s)) return null;
  let best: { shape: ShapeElement; anchor: Vec2 } | null = null;
  let bestDist = DOT_HIT_PX;
  for (const anchor of SIDE_ANCHORS) {
    const d = c.screenDist(p, anchorDot(s, anchor, c.camera.zoom));
    if (d <= bestDist) {
      bestDist = d;
      best = { shape: s, anchor };
    }
  }
  return best;
}

export type ConnectorHandleHit = { kind: 'end'; which: 'start' | 'end' } | { kind: 'bend' };

/** End or bend handle of the selected connector under screen point `p`. */
export function connectorHandleAt(
  c: InputContext,
  p: Vec2,
): { id: string; hit: ConnectorHandleHit } | null {
  if (c.readOnly()) return null;
  const id = c.overlay.selectedConnector();
  const g = id ? c.scene.connectorGeometry(id) : null;
  if (!id || !g) return null;
  if (c.screenDist(p, g.points[0]!) <= HANDLE_HIT_PX)
    return { id, hit: { kind: 'end', which: 'start' } };
  if (c.screenDist(p, g.points[g.points.length - 1]!) <= HANDLE_HIT_PX)
    return { id, hit: { kind: 'end', which: 'end' } };
  if (g.handle && c.screenDist(p, g.handle.point) <= HANDLE_HIT_PX)
    return { id, hit: { kind: 'bend' } };
  return null;
}
