import type { ElementPatch, ShapeElement } from './element';

/**
 * How an image fills its box, as Figma's image fill modes:
 * - `fill` (default): covers the box, cropped evenly; never distorted.
 * - `fit`: the whole image; the box hugs it (`fitBox`), keeping the image's proportions.
 * - `crop`: the `crop` part of the image, stretched to the box (the box keeps that
 *   part's proportions unless resized with Shift).
 */
export type ImageFit = 'fill' | 'fit' | 'crop';

/** Part of the image shown in `crop` mode, as fractions (0..1) of the image. */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Texture coordinates of the box: the image's (u, v) at the box's top-left corner, and how
 * much of the image (du, dv) the box spans. Outside 0..1 the box shows nothing (`fit`).
 */
export interface ImageUv {
  u: number;
  v: number;
  du: number;
  dv: number;
}

/** Box-local rectangle (origin at the element's unrotated top-left corner). */
export interface LocalRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Pixel size of the image: stored with the element, else `fallback` (e.g. the decoded file). */
export function imageSize(
  el: ShapeElement,
  fallback?: { w: number; h: number } | null,
): { w: number; h: number } {
  const w = el.media?.naturalWidth ?? fallback?.w;
  const h = el.media?.naturalHeight ?? fallback?.h;
  // Unknown: the box's own proportions, so the image shows whole.
  return w && h && w > 0 && h > 0 ? { w, h } : { w: Math.max(el.w, 1e-6), h: Math.max(el.h, 1e-6) };
}

/** Where the image lands in the element's box (see `ImageUv`). */
export function imageUv(el: ShapeElement, size: { w: number; h: number }): ImageUv {
  const fit = el.imageFit ?? 'fill';
  if (fit === 'crop' && el.crop)
    return { u: el.crop.x, v: el.crop.y, du: el.crop.w, dv: el.crop.h };
  const box = Math.max(el.w, 1e-6) / Math.max(el.h, 1e-6);
  const img = size.w / size.h;
  if (fit === 'fit') {
    // Contain: the image's longer side (relative to the box) touches the box.
    if (box > img) {
      const du = box / img;
      return { u: (1 - du) / 2, v: 0, du, dv: 1 };
    }
    const dv = img / box;
    return { u: 0, v: (1 - dv) / 2, du: 1, dv };
  }
  // Fill (cover), centered.
  if (box > img) {
    const dv = img / box;
    return { u: 0, v: (1 - dv) / 2, du: 1, dv };
  }
  const du = box / img;
  return { u: (1 - du) / 2, v: 0, du, dv: 1 };
}

/** The whole image's rectangle in box-local coordinates (it may extend past the box). */
export function imageRect(el: ShapeElement, size: { w: number; h: number }): LocalRect {
  const uv = imageUv(el, size);
  const w = el.w / uv.du;
  const h = el.h / uv.dv;
  return { x: 0 - uv.u * w, y: 0 - uv.v * h, w, h }; // 0 - …: no -0
}

/** Patch that moves the element's box to `box`, given in its current box-local coordinates. */
export function localBoxPatch(el: ShapeElement, box: LocalRect): ElementPatch {
  const c = Math.cos(el.rotation);
  const s = Math.sin(el.rotation);
  const lx = box.x + box.w / 2 - el.w / 2; // new center relative to the old one, box-local
  const ly = box.y + box.h / 2 - el.h / 2;
  const cx = el.x + el.w / 2 + lx * c - ly * s;
  const cy = el.y + el.h / 2 + lx * s + ly * c;
  return { x: cx - box.w / 2, y: cy - box.h / 2, w: box.w, h: box.h };
}

const cropOf = (box: LocalRect, img: LocalRect): CropRect => ({
  x: (box.x - img.x) / img.w,
  y: (box.y - img.y) / img.h,
  w: box.w / img.w,
  h: box.h / img.h,
});

/**
 * Switches the element to `fit`: the box shrinks around the whole image, centered where
 * the image would show inside the current box, so no empty margins are left.
 */
export function fitBox(el: ShapeElement, size: { w: number; h: number }): ElementPatch {
  const box = imageRect({ ...el, imageFit: 'fit', crop: undefined }, size);
  return { ...localBoxPatch(el, box), imageFit: 'fit', crop: undefined };
}

/**
 * Switches the element to `crop` showing what it shows now: the box keeps the visible
 * part of the image (a `fit` box shrinks to the image). The image doesn't move on screen.
 */
export function enterCrop(el: ShapeElement, size: { w: number; h: number }): ElementPatch {
  const img = imageRect(el, size);
  const x0 = Math.max(0, img.x);
  const y0 = Math.max(0, img.y);
  const x1 = Math.min(el.w, img.x + img.w);
  const y1 = Math.min(el.h, img.y + img.h);
  const box = { x: x0, y: y0, w: Math.max(1e-6, x1 - x0), h: Math.max(1e-6, y1 - y0) };
  return { ...localBoxPatch(el, box), imageFit: 'crop', crop: cropOf(box, img) };
}

/**
 * Crop mode, dragging a side or corner of the crop frame: the image stays in place and
 * the frame moves its dragged sides by `delta` (box-local), staying on the image.
 * `signs`: which sides move (-1 left/top, 1 right/bottom, 0 neither), as resize handles.
 */
export function cropResize(
  el: ShapeElement,
  size: { w: number; h: number },
  signs: readonly [number, number],
  delta: { x: number; y: number },
  minSize = 1,
): ElementPatch {
  const img = imageRect(el, size);
  let x0 = 0;
  let y0 = 0;
  let x1 = el.w;
  let y1 = el.h;
  const [sx, sy] = signs;
  if (sx < 0) x0 = Math.min(Math.max(img.x, delta.x), x1 - minSize);
  if (sx > 0) x1 = Math.max(Math.min(img.x + img.w, el.w + delta.x), x0 + minSize);
  if (sy < 0) y0 = Math.min(Math.max(img.y, delta.y), y1 - minSize);
  if (sy > 0) y1 = Math.max(Math.min(img.y + img.h, el.h + delta.y), y0 + minSize);
  const box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  return { ...localBoxPatch(el, box), imageFit: 'crop', crop: cropOf(box, img) };
}

/** Crop mode, dragging inside the frame: the image moves under it, never leaving a gap. */
export function cropPan(
  el: ShapeElement,
  size: { w: number; h: number },
  delta: { x: number; y: number },
): ElementPatch {
  const img = imageRect(el, size);
  const x = Math.min(0, Math.max(el.w - img.w, img.x + delta.x));
  const y = Math.min(0, Math.max(el.h - img.h, img.y + delta.y));
  return { imageFit: 'crop', crop: cropOf({ x: 0, y: 0, w: el.w, h: el.h }, { ...img, x, y }) };
}

/** The image may grow up to this many times the frame (on its larger side). */
const MAX_IMAGE_ZOOM = 50;

/**
 * Crop mode, dragging a corner of the image itself (Figma's image handles): the image
 * scales with its proportions around the opposite corner, the frame stays. It never gets
 * smaller than needed to cover the frame. `signs` pick the corner (±1, ±1); `delta` is
 * the corner's movement, box-local.
 */
export function cropScale(
  el: ShapeElement,
  size: { w: number; h: number },
  signs: readonly [number, number],
  delta: { x: number; y: number },
): ElementPatch {
  const img = imageRect(el, size);
  const [sx, sy] = signs;
  // The fixed (opposite) corner, and the dragged one where the pointer put it.
  const ax = sx > 0 ? img.x : img.x + img.w;
  const ay = sy > 0 ? img.y : img.y + img.h;
  const px = (sx > 0 ? img.x + img.w : img.x) + delta.x;
  const py = (sy > 0 ? img.y + img.h : img.y) + delta.y;
  // Follow whichever axis the pointer pulled further, like a proportional corner resize.
  let k = Math.max((sx * (px - ax)) / img.w, (sy * (py - ay)) / img.h);
  // Smallest scale that still covers the frame from the fixed corner.
  const cover = Math.max(
    sx > 0 ? (el.w - ax) / img.w : ax / img.w,
    sy > 0 ? (el.h - ay) / img.h : ay / img.h,
  );
  const most = (MAX_IMAGE_ZOOM * Math.max(el.w, el.h)) / Math.max(img.w, img.h);
  k = Math.min(Math.max(k, cover), Math.max(cover, most));
  const w = img.w * k;
  const h = img.h * k;
  const scaled = { x: sx > 0 ? ax : ax - w, y: sy > 0 ? ay : ay - h, w, h };
  const c = cropOf({ x: 0, y: 0, w: el.w, h: el.h }, scaled);
  // Rounding must not push the crop a hair outside the image.
  const x = Math.min(Math.max(c.x, 0), 1);
  const y = Math.min(Math.max(c.y, 0), 1);
  return {
    imageFit: 'crop',
    crop: { x, y, w: Math.min(c.w, 1 - x), h: Math.min(c.h, 1 - y) },
  };
}
