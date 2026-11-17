import {
  eraseStroke,
  hitTestElement,
  inkGeometry,
  inkWorldPoints,
  isShape,
  simplifyStroke,
  type ShapeElement,
  type Vec2,
} from '@apeiro/core';
import { newId } from '../ids';
import { ERASER_PX, INK_SIMPLIFY_PX, INK_STEP_PX } from './constants';
import type { InputContext } from './context';
import type { ModeOf } from './modes';

// Pen and eraser.

/** Starts a pen stroke at `world` (screen point `p`) in the current pen style. */
export function startInk(c: InputContext, world: Vec2, p: Vec2): void {
  const id = newId('i');
  c.scene.add({
    id,
    type: 'ink',
    ...inkGeometry([world]),
    rotation: 0,
    z: c.scene.maxZ() + 1,
    fill: 0,
    stroke: c.tools.pen.stroke,
    strokeWidth: c.tools.pen.strokeWidth,
    radius: 0,
  });
  c.mode = { kind: 'ink', id, points: [world], last: p };
}

/**
 * Extends the stroke through screen points `ps` (the browser's coalesced positions since the
 * last event, then the current one) with one scene update. False if the pointer barely moved.
 */
export function extendInk(c: InputContext, m: ModeOf<'ink'>, ps: readonly Vec2[]): boolean {
  let added = false;
  for (const p of ps) {
    if (Math.hypot(p.x - m.last.x, p.y - m.last.y) < INK_STEP_PX) continue;
    m.last = p;
    m.points.push(c.world(p));
    added = true;
  }
  if (added) c.scene.update(m.id, inkGeometry(m.points));
  return added;
}

/** The stroke keeps its look with fewer points: drop the ones that add nothing. */
export function finishInk(c: InputContext, m: ModeOf<'ink'>): void {
  if (m.points.length < 3) return;
  const simple = simplifyStroke(m.points, c.px(INK_SIMPLIFY_PX));
  if (simple.length < m.points.length) c.scene.update(m.id, inkGeometry(simple));
}

/**
 * Erases the ink under the eraser around screen point `p`: only the part it covers. A
 * stroke cut in the middle falls apart into separate strokes; one covered completely
 * goes away.
 */
export function eraseAt(c: InputContext, p: Vec2): void {
  const { scene, overlay } = c;
  const world = c.world(p);
  const r = c.px(ERASER_PX);
  const near = scene.queryBox({
    minX: world.x - r,
    minY: world.y - r,
    maxX: world.x + r,
    maxY: world.y + r,
  });
  const hits = near.filter(
    (e): e is ShapeElement =>
      isShape(e) && e.type === 'ink' && !c.locked(e.id) && hitTestElement(e, world, r),
  );
  if (hits.length === 0) return;
  scene.transact(() => {
    for (const e of hits) {
      // Where the eraser touches the drawn line, not just its center line.
      const pieces = eraseStroke(inkWorldPoints(e), world, r + e.strokeWidth / 2);
      if (!pieces) continue;
      if (pieces.length === 0) {
        scene.remove(e.id);
        overlay.selection.delete(e.id);
        continue;
      }
      // Fewer points: the cut added some along the stroke.
      const tidy = pieces.map((piece) => simplifyStroke(piece, c.px(INK_SIMPLIFY_PX)));
      scene.update(e.id, { ...inkGeometry(tidy[0]!), rotation: 0 });
      for (const piece of tidy.slice(1)) {
        scene.add({ ...e, id: newId('i'), ...inkGeometry(piece), rotation: 0 });
      }
    }
  });
}

/** Erases along the whole way from the last position: a fast stroke must not skip a line. */
export function eraseAlong(c: InputContext, m: ModeOf<'erase'>, p: Vec2): void {
  const from = m.last;
  const steps = Math.max(1, Math.ceil(Math.hypot(p.x - from.x, p.y - from.y) / ERASER_PX));
  for (let i = 1; i <= steps; i++) {
    eraseAt(c, {
      x: from.x + ((p.x - from.x) * i) / steps,
      y: from.y + ((p.y - from.y) * i) / steps,
    });
  }
  m.last = p;
}
