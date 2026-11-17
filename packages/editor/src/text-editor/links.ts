import { textArea, type ShapeElement, type TextLayout, type Vec2 } from '@apeiro/core';
import { worldToLocal } from '../overlay/handles';

/** The link of an element's laid out text under a world point, or null. */
export function linkAtPoint(
  el: ShapeElement,
  layout: TextLayout | undefined,
  world: Vec2,
  slop = 0,
): string | null {
  if (!layout || layout.links.length === 0) return null;
  const local = worldToLocal(el, world);
  const area = textArea(el);
  // Text-box coordinates: from the top-left of the text area, unrotated.
  const x = local.x + el.w / 2 - area.minX;
  const y = local.y + el.h / 2 - area.minY;
  for (const l of layout.links) {
    if (
      x >= l.x - slop &&
      x <= l.x + l.width + slop &&
      y >= l.y - slop &&
      y <= l.y + l.height + slop
    )
      return l.href;
  }
  return null;
}
