import {
  enterCrop,
  HANDLE_SIGNS,
  hitTestElement,
  imageRect,
  imageSize,
  shapeFrame,
  worldToFrame,
  type ResizeHandle,
  type ShapeElement,
  type Vec2,
} from '@apeiro/core';
import { transformHandleAt } from '../overlay/handles';
import { IMAGE_HANDLE_HIT_PX } from './constants';
import type { InputContext } from './context';
import type { CropAction } from './modes';

// Crop mode of an image (Figma: double click or Enter): the crop frame's sides resize what
// is shown, the image inside pans, the image's own corners scale it.

/** The image in crop mode, if it still is one. */
export function cropTarget(c: InputContext): ShapeElement | null {
  const s = c.overlay.cropping ? c.getShape(c.overlay.cropping) : undefined;
  return s && s.type === 'image' && s.media ? s : null;
}

/** Enters crop mode: the image switches to `crop`, showing the same part as before. */
export function startCrop(c: InputContext, id: string): void {
  const s = c.getShape(id);
  if (!s || s.type !== 'image' || !s.media || c.locked(id)) return;
  if (s.imageFit !== 'crop' || !s.crop) c.scene.update(id, enterCrop(s, imageSize(s)));
  c.overlay.cropping = id;
  c.overlay.selection = new Set([id]);
  c.clearDots();
  c.overlay.request();
  c.hooks.onCrop?.(id);
}

/** Leaves crop mode; false if it was not on. */
export function stopCrop(c: InputContext): boolean {
  if (!c.overlay.cropping) return false;
  c.overlay.cropping = null;
  c.overlay.request();
  c.hooks.onCrop?.(null);
  return true;
}

/** Crop mode on, or off for the image already in it. */
export function toggleCrop(c: InputContext, id: string): void {
  if (c.overlay.cropping === id) stopCrop(c);
  else startCrop(c, id);
}

/**
 * Corner of the image itself (crop mode) under a world point, as resize signs. Where it
 * coincides with a frame corner, a press just outside the frame takes the image.
 */
function imageCornerAt(
  c: InputContext,
  s: ShapeElement,
  world: Vec2,
): readonly [number, number] | null {
  const l = worldToFrame(shapeFrame(s), world);
  const x = l.x + s.w / 2;
  const y = l.y + s.h / 2;
  const r = imageRect(s, imageSize(s));
  const hit = c.px(IMAGE_HANDLE_HIT_PX);
  for (const sx of [-1, 1] as const) {
    for (const sy of [-1, 1] as const) {
      const cx = sx > 0 ? r.x + r.w : r.x;
      const cy = sy > 0 ? r.y + r.h : r.y;
      if (Math.hypot(x - cx, y - cy) <= hit) return [sx, sy];
    }
  }
  return null;
}

/** Side or corner of the crop frame under a world point. */
function cropHandleAt(c: InputContext, s: ShapeElement, world: Vec2): ResizeHandle | null {
  const hit = transformHandleAt(shapeFrame(s), world, c.camera.zoom);
  return hit?.kind === 'resize' ? hit.handle : null;
}

/** What a press in crop mode grabs: the image's corner, a frame side, or the image. */
export function cropGrabAt(
  c: InputContext,
  s: ShapeElement,
  world: Vec2,
): { action: CropAction; signs: readonly [number, number] } | null {
  const corner = imageCornerAt(c, s, world);
  const handle = cropHandleAt(c, s, world);
  const inside = hitTestElement(s, world, 0);
  if (corner && (!handle || !inside)) return { action: 'scale', signs: corner };
  if (handle) return { action: 'resize', signs: HANDLE_SIGNS[handle] };
  if (inside) return { action: 'pan', signs: [0, 0] };
  return null;
}

/** The resize handle whose signs these are (for its cursor). */
export const handleOfSigns = (signs: readonly [number, number]): ResizeHandle =>
  (Object.keys(HANDLE_SIGNS) as ResizeHandle[]).find(
    (k) => HANDLE_SIGNS[k][0] === signs[0] && HANDLE_SIGNS[k][1] === signs[1],
  )!;
