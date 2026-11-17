import {
  audioSeekAt,
  audioVolumeAt,
  bendConnector,
  boxFromPoints,
  cropPan,
  cropResize,
  cropScale,
  expandToGroups,
  imageSize,
  isConnector,
  maxCornerRadius,
  polygonSides,
  radiusAfterDrag,
  rotateElements,
  snapAngle,
  worldToFrame,
  type ConnectorEnd,
  type Vec2,
} from '@apeiro/core';
import { countAtAngle, ROTATE_CURSOR } from '../overlay/handles';
import { CLICK_SLOP_PX, TEXTBOX_DRAG_PX } from './constants';
import type { InputContext } from './context';
import { updateDraggedEnd } from './connect';
import { alongBisector } from './hit-targets';
import { eraseAlong, extendInk } from './ink';
import type { ModeOf } from './modes';
import { dragStep, resizeStep, type SnapContext } from './transform-gestures';

const moveEnd = (end: ConnectorEnd, dx: number, dy: number): ConnectorEnd =>
  end.kind === 'point' ? { kind: 'point', x: end.x + dx, y: end.y + dy } : end;

const snapContext = (c: InputContext): SnapContext => ({
  zoom: c.camera.zoom,
  snapping: !!c.hooks.snapping,
  shift: c.modifiers.shift,
  alt: c.modifiers.alt,
  deep: c.modifiers.deep,
});

/** Moves the dragged elements with the pointer, snapping to smart guides and the grid. */
function drag(c: InputContext, m: ModeOf<'drag'>, p: Vec2): void {
  if (!m.moved && c.screenDist(p, m.start) >= CLICK_SLOP_PX) m.moved = true;
  // Smart guides and the grid; Ctrl/⌘ held places freely.
  const step = dragStep(m.start, c.world(p), m.box, m.targets, m.moved, snapContext(c));
  c.overlay.guides = step.guides;
  c.overlay.spacing = step.spacing;
  const { dx, dy } = step;
  c.scene.transact(() => {
    for (const [id, o] of m.origin) {
      // Attached connector ends follow their shapes by themselves; only free ends move.
      if (o.kind === 'shape') c.scene.update(id, { x: o.x + dx, y: o.y + dy });
      else c.scene.update(id, { start: moveEnd(o.start, dx, dy), end: moveEnd(o.end, dx, dy) });
    }
  });
}

function crop(c: InputContext, m: ModeOf<'crop'>, p: Vec2): void {
  const l = worldToFrame(m.frame, c.world(p));
  const delta = { x: l.x - m.start.x, y: l.y - m.start.y };
  const size = imageSize(m.original);
  const patch =
    m.action === 'pan'
      ? cropPan(m.original, size, delta)
      : m.action === 'scale'
        ? cropScale(m.original, size, m.signs, delta)
        : cropResize(m.original, size, m.signs, delta, c.px(4));
  c.scene.update(m.original.id, patch);
}

function marquee(c: InputContext, m: ModeOf<'marquee'>, p: Vec2): void {
  const box = boxFromPoints(m.start, c.world(p));
  c.overlay.marquee = box;
  const next = new Set(m.base);
  // Touching one element of a group selects the whole group; with Ctrl/⌘ (deep select)
  // only the elements touched.
  const hits = c.scene.queryBox(box, 'intersect').map((hit) => hit.id);
  for (const id of c.modifiers.deep ? hits : expandToGroups(c.scene, hits)) next.add(id);
  c.overlay.selection = next;
}

function radius(c: InputContext, m: ModeOf<'radius'>, p: Vec2): void {
  const el = c.getShape(m.id);
  if (!el) return;
  const along = alongBisector(el, c.world(p));
  const r = radiusAfterDrag(el, m.startRadius, along - m.startAlong);
  // Whole units like Figma, but keep fractions on tiny shapes (zoomed in a lot).
  const rounded = maxCornerRadius(el) >= 20 ? Math.round(r) : r;
  if (rounded !== el.radius) c.scene.update(m.id, { radius: rounded });
}

function count(c: InputContext, m: ModeOf<'count'>, p: Vec2): void {
  const el = c.getShape(m.id);
  if (!el) return;
  const sides = countAtAngle(el, c.world(p));
  c.overlay.countLabel = sides;
  if (sides !== polygonSides(el)) c.scene.update(m.id, { sides });
}

function rotate(c: InputContext, m: ModeOf<'rotate'>, p: Vec2): void {
  const w = c.world(p);
  let angle = Math.atan2(w.y - m.center.y, w.x - m.center.x) - m.startAngle;
  if (c.modifiers.shift) angle = snapAngle(m.base + angle, Math.PI / 12) - m.base;
  c.applyPatches(rotateElements(m.originals, m.center, angle));
  const degrees = Math.round(((m.base + angle) * 180) / Math.PI);
  c.overlay.badge = `${((degrees % 360) + 360) % 360}°`;
  c.setCursor(ROTATE_CURSOR);
}

/** Applies the current gesture for a pointer at screen point `p`. */
export function moveGesture(c: InputContext, p: Vec2): void {
  const { mode: m, overlay } = c;
  switch (m.kind) {
    case 'drag':
      drag(c, m, p);
      break;
    case 'crop':
      crop(c, m, p);
      break;
    case 'textbox': {
      // The width of the text box being drawn (its height follows the text).
      const dragged = Math.abs(p.x - m.down.x) >= TEXTBOX_DRAG_PX;
      overlay.marquee = dragged ? boxFromPoints(m.start, c.world(p)) : null;
      break;
    }
    case 'marquee':
      marquee(c, m, p);
      break;
    case 'bend': {
      const connector = c.scene.get(m.id);
      if (connector && isConnector(connector)) {
        const patch = bendConnector(connector, c.world(p), c.getShape);
        if (patch) c.scene.update(m.id, patch);
      }
      break;
    }
    case 'seek': {
      const el = c.getShape(m.id);
      if (el) c.hooks.audio?.seek(m.id, audioSeekAt(el, c.world(p)));
      return;
    }
    case 'volume': {
      const el = c.getShape(m.id);
      if (el) c.scene.update(m.id, { volume: audioVolumeAt(el, c.world(p)) });
      return;
    }
    case 'radius':
      radius(c, m, p);
      break;
    case 'count':
      count(c, m, p);
      break;
    case 'resize': {
      const step = resizeStep(
        m,
        worldToFrame(m.frame, c.world(p)),
        snapContext(c),
        c.hooks.measurer,
      );
      overlay.guides = step.guides;
      overlay.badge = step.badge;
      c.applyPatches(step.patches);
      break;
    }
    case 'rotate':
      rotate(c, m, p);
      break;
    case 'connect':
      updateDraggedEnd(c, m, p);
      break;
    case 'place':
      overlay.marquee =
        c.screenDist(p, m.start) >= CLICK_SLOP_PX ? boxFromPoints(m.start, c.world(p)) : null;
      break;
    case 'ink':
      if (!extendInk(c, m, [p])) return;
      break;
    case 'erase':
      eraseAlong(c, m, p);
      break;
    default:
      return;
  }
  overlay.request();
}
