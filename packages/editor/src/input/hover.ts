import { hitTestAudio, isShape, resizeCursor, type Vec2 } from '@apeiro/core';
import { ROTATE_CURSOR } from '../overlay/handles';
import {
  ANCHOR_KEEP_PX,
  AUDIO_HIT_PX,
  ERASER_CURSOR,
  ERASER_PX,
  HIT_TOLERANCE_PX,
} from './constants';
import type { InputContext } from './context';
import { cropGrabAt, cropTarget, handleOfSigns } from './crop';
import {
  connectorHandleAt,
  countHandleAt,
  dotAt,
  radiusHandleAt,
  transformAt,
} from './hit-targets';

/** Cursor while no gesture runs and nothing in particular is under the pointer. */
export function idleCursor(c: InputContext): string {
  const { tools } = c;
  if (c.spaceDown || tools.tool === 'hand') return 'grab';
  const custom = tools.customTool();
  if (custom) return custom.cursor ?? 'crosshair';
  switch (tools.tool) {
    case 'text':
      return 'text';
    case 'eraser':
      return ERASER_CURSOR;
    case 'select':
      return '';
    default:
      return 'crosshair';
  }
}

/** Sets the overlay's hover state; redraws only when something changed. */
function setHover(c: InputContext, hover: string | null, anchorsFor: string | null): void {
  const { overlay } = c;
  if (overlay.hover === hover && overlay.anchorsFor === anchorsFor && !overlay.hoverDot) return;
  overlay.hover = hover;
  overlay.anchorsFor = anchorsFor;
  overlay.hoverDot = null;
  overlay.request();
}

/**
 * Pointer moving with no gesture: hover outlines, connection dots, handle highlights and
 * the cursor for whatever a press at `p` would grab.
 */
export function hover(c: InputContext, p: Vec2): void {
  const { overlay, scene, tools } = c;
  const world = c.world(p);

  const cropping = cropTarget(c);
  if (cropping) {
    // Crop mode: no connection dots or hover outlines, only the crop frame.
    if (overlay.anchorsFor || overlay.hoverDot || overlay.hover) setHover(c, null, null);
    const grab = cropGrabAt(c, cropping, world);
    c.setCursor(
      !grab
        ? idleCursor(c)
        : grab.action === 'pan'
          ? 'grab'
          : resizeCursor(handleOfSigns(grab.signs), cropping.rotation),
    );
    return;
  }

  // Drawing and placing tools don't point at elements: no hover outline, no dots.
  if (tools.tool !== 'select' && tools.tool !== 'connector' && tools.tool !== 'text') {
    const hit = tools.tool === 'eraser' ? scene.hitTest(world, c.px(ERASER_PX)) : null;
    setHover(c, hit?.type === 'ink' && !c.locked(hit.id) ? hit.id : null, null);
    c.setCursor(idleCursor(c));
    return;
  }

  const onCount = countHandleAt(c, p) !== null;
  if (onCount !== overlay.countActive) {
    overlay.countActive = onCount;
    overlay.request();
  }
  if (onCount) {
    c.setCursor('pointer');
    return;
  }
  const onRadius = radiusHandleAt(c, p) !== null;
  if (onRadius !== overlay.radiusActive) {
    overlay.radiusActive = onRadius;
    overlay.request();
  }
  if (onRadius) {
    c.setCursor('pointer');
    return;
  }

  const transform = transformAt(c, world);
  if (transform) {
    const { hit, frame } = transform;
    c.setCursor(hit.kind === 'rotate' ? ROTATE_CURSOR : resizeCursor(hit.handle, frame.rotation));
    if (overlay.anchorsFor || overlay.hoverDot) {
      c.clearDots();
      overlay.request();
    }
    return;
  }

  // A connection dot under the pointer wins over anything else: the shape keeps its dots
  // even if the pointer crosses a neighbour on the way to the dot.
  const dot = dotAt(c, p);
  if (dot) {
    if (overlay.hoverDot !== dot.anchor || overlay.hover !== dot.shape.id) {
      overlay.hoverDot = dot.anchor;
      overlay.hover = dot.shape.id;
      overlay.request();
    }
    c.setCursor('crosshair');
    return;
  }

  const handle = connectorHandleAt(c, p);
  const hit = scene.hitTest(world, c.px(HIT_TOLERANCE_PX));
  const select = tools.tool === 'select';
  let anchorsFor =
    hit &&
    isShape(hit) &&
    select &&
    !c.overlay.selection.has(hit.id) && // selected: handles instead of connection dots
    c.showsDots(hit) &&
    !c.locked(hit.id) &&
    !c.readOnly()
      ? hit.id
      : null;
  if (!anchorsFor && overlay.anchorsFor && !overlay.selection.has(overlay.anchorsFor)) {
    // Keep the dots while the pointer travels from the shape out to a dot.
    const b = scene.getBounds(overlay.anchorsFor);
    const pad = c.px(ANCHOR_KEEP_PX);
    if (
      b &&
      world.x > b.minX - pad &&
      world.x < b.maxX + pad &&
      world.y > b.minY - pad &&
      world.y < b.maxY + pad
    ) {
      anchorsFor = overlay.anchorsFor;
    }
  }
  setHover(c, hit?.id ?? null, anchorsFor);

  const onControl =
    hit &&
    isShape(hit) &&
    (hitTestAudio(hit, world, c.px(AUDIO_HIT_PX)) || (select && c.hooks.linkAt?.(hit.id, world)));
  c.setCursor(
    handle
      ? 'grab'
      : onControl
        ? 'pointer'
        : hit && select && !c.modifiers.deep && !c.readOnly() // Ctrl/⌘: the plain arrow
          ? 'move'
          : idleCursor(c),
  );
}
