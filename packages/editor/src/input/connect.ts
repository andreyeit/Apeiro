import {
  anchorAt,
  boxIntersects,
  freezeConnectorEnds,
  isConnector,
  isShape,
  isSideMidpoint,
  type ConnectorEnd,
  type ShapeElement,
  type Vec2,
} from '@apeiro/core';
import { newId } from '../ids';
import { CLICK_SLOP_PX, EDGE_PX, QUICK_GAP, SNAP_PX, SNAP_RELEASE } from './constants';
import type { InputContext } from './context';
import type { ModeOf } from './modes';

// Dragging a connector end: attaching it to shapes (with side-midpoint magnets), and the
// quick-create click on a connection dot.

/** Points the dragged end at the shape under the cursor (snapping to side midpoints), or at the cursor. */
export function updateDraggedEnd(c: InputContext, m: ModeOf<'connect'>, p: Vec2): void {
  const { scene, overlay } = c;
  const connector = scene.get(m.id);
  if (!connector || !isConnector(connector)) return;
  const world = c.world(p);
  const other = m.which === 'start' ? connector.end : connector.start;
  const otherShape = other.kind === 'element' ? other.id : null;
  // Shapes within the magnet radius count as targets, so the end can snap from outside.
  // While snapped to a side middle, the radius grows so the end doesn't flicker at its edge.
  const holding = overlay.target !== null && overlay.snap !== null && isSideMidpoint(overlay.snap);
  const radius = c.px(SNAP_PX * (holding ? SNAP_RELEASE : 1));
  const target = scene.hitTestShape(
    world,
    radius,
    (id) => id === otherShape || c.notConnectable(id),
  );
  const held = holding && target?.id === overlay.target;
  const snap = held ? radius : c.px(SNAP_PX);
  const anchor = target ? anchorAt(target, world, snap, c.px(EDGE_PX)) : undefined;
  const end: ConnectorEnd = target
    ? anchor
      ? { kind: 'element', id: target.id, anchor }
      : { kind: 'element', id: target.id }
    : { kind: 'point', x: world.x, y: world.y };
  scene.update(m.id, m.which === 'start' ? { start: end } : { end });
  overlay.target = target?.id ?? null;
  overlay.snap = anchor ?? null;
}

/**
 * Ends a connector drag at screen point `p`. A click on a connection dot (no drag) removes
 * the new connector and quick-creates a connected copy of the shape instead.
 */
export function finishConnect(c: InputContext, m: ModeOf<'connect'>, p: Vec2): void {
  const moved = Math.hypot(p.x - m.down.x, p.y - m.down.y);
  if (m.original === null && moved < CLICK_SLOP_PX) {
    c.scene.remove(m.id); // a click, not a drag
    const source = m.fromDot ? c.getShape(m.fromDot.shape) : undefined;
    if (source && m.fromDot) quickCreate(c, source, m.fromDot.anchor);
    return;
  }
  // Rigid attachment: ends dropped inside a shape stay where they landed on its outline.
  const connector = c.scene.get(m.id);
  const frozen =
    connector && isConnector(connector) ? freezeConnectorEnds(connector, c.getShape) : null;
  if (frozen) c.scene.update(m.id, frozen);
  c.overlay.selection = new Set([m.id]);
}

/** Click on a connection dot: a copy of the shape next to it, connected by an arrow. */
function quickCreate(c: InputContext, source: ShapeElement, anchor: Vec2): void {
  const { scene } = c;
  const local = { x: (anchor.x - 0.5) * 2, y: (anchor.y - 0.5) * 2 };
  const cos = Math.cos(source.rotation);
  const sin = Math.sin(source.rotation);
  const dir = { x: local.x * cos - local.y * sin, y: local.x * sin + local.y * cos };
  const step = (Math.abs(local.x) > 0 ? source.w : source.h) + QUICK_GAP;
  const cx = source.x + source.w / 2;
  const cy = source.y + source.h / 2;
  const at = (k: number) => ({
    x: cx + dir.x * step * k - source.w / 2,
    y: cy + dir.y * step * k - source.h / 2,
  });
  // Walk further out until the spot is free.
  let k = 1;
  for (; k < 8; k++) {
    const { x, y } = at(k);
    const box = { minX: x, minY: y, maxX: x + source.w, maxY: y + source.h };
    const taken = scene
      .queryBox(box)
      .some((e) => isShape(e) && boxIntersects(scene.getBounds(e.id)!, box));
    if (!taken) break;
  }
  const id = newId('s');
  const copy: ShapeElement = {
    ...source,
    id,
    ...at(k),
    z: scene.maxZ() + 1,
    text: source.text ? { ...source.text, runs: [{ text: '' }] } : undefined,
    groupId: undefined,
  };
  const opposite = { x: 1 - anchor.x, y: 1 - anchor.y };
  scene.transact(() => {
    scene.add(copy);
    c.createConnector(
      { kind: 'element', id: source.id, anchor },
      { kind: 'element', id, anchor: opposite },
    );
  });
  c.overlay.selection = new Set([id]);
  c.clearDots();
  c.hooks.onQuickCreate?.(id);
}
