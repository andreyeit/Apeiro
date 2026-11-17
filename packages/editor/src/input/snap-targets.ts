import { boxUnion, elementBounds, isShape, type Box } from '@apeiro/core';
import { MAX_SNAP_TARGETS } from './constants';
import type { InputContext } from './context';

/** Box of an element for snapping: its geometry, without the stroke (like Figma). */
function geometryBox(c: InputContext, id: string): Box | null {
  const el = c.scene.get(id);
  if (!el) return null;
  return isShape(el) ? elementBounds({ ...el, strokeWidth: 0 }) : (c.scene.getBounds(id) ?? null);
}

/** Box of the elements being moved. */
export function snapBoxOf(c: InputContext, ids: Iterable<string>): Box | null {
  let out: Box | null = null;
  for (const id of ids) {
    const b = geometryBox(c, id);
    if (b) out = out ? boxUnion(out, b) : b;
  }
  return out;
}

/**
 * Shapes on and around the screen to snap to (not the moving ones, nor connectors, whose
 * attached ends move along). Taken once per gesture: the others don't move meanwhile.
 */
export function snapTargets(c: InputContext, moving: ReadonlySet<string>): Box[] {
  const v = c.camera.viewportBounds();
  const mx = v.maxX - v.minX;
  const my = v.maxY - v.minY;
  const area = { minX: v.minX - mx, minY: v.minY - my, maxX: v.maxX + mx, maxY: v.maxY + my };
  const out: Box[] = [];
  for (const el of c.scene.queryBox(area)) {
    if (moving.has(el.id) || !isShape(el)) continue;
    const b = geometryBox(c, el.id);
    if (b) out.push(b);
    if (out.length >= MAX_SNAP_TARGETS) break;
  }
  return out;
}
