import type { ConnectorElement, LineDash } from '../connectors/types';
import type { CropRect, ImageFit } from './image-fit';
import type { MediaInfo } from './media';
import type { Box } from '../geometry/math';
import { polygonSides, polygonTextBox } from './shape-geometry';
import type { TextBlock } from '../text/text-block';

/**
 * `text` is a frameless text box: drawn like a rect, usually with a transparent fill.
 * `polygon` is a regular polygon with `sides` corners stretched to the box (3 = triangle).
 * `ink` is a freehand pen stroke: a polyline (`points`) in the box, drawn with `stroke`.
 */
export type ShapeKind =
  | 'rect'
  | 'ellipse'
  | 'polygon'
  | 'sticky'
  | 'text'
  | 'image'
  | 'audio'
  | 'ink';

/**
 * A board element. Plain data: the engine never stores behaviour on elements,
 * so they map 1:1 to whatever the sync layer (Yjs) persists.
 *
 * Geometry: (x, y) is the top-left corner of the unrotated box,
 * rotation is in radians around the box center.
 */
export interface ShapeElement {
  id: string;
  type: ShapeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  /** Paint order. Higher is drawn on top. Fractional values allow inserting between neighbours. */
  z: number;
  /** Packed 0xRRGGBBAA. */
  fill: number;
  /** Packed 0xRRGGBBAA. */
  stroke: number;
  strokeWidth: number;
  /** Border pattern (default solid). Dashes and dots scale with the stroke width. */
  strokeStyle?: LineDash;
  /**
   * Corner radius (world units) of rect, sticky, image and polygon corners; ignored for
   * ellipses. Capped when drawn (see `effectiveRadius`): at the cap a square is a circle.
   */
  radius: number;
  /** Number of corners of a `polygon`, 3..12 (default 3). */
  sides?: number;
  /**
   * Text inside the shape. Keep the object reference unchanged when only geometry changes:
   * renderers cache layouts by it.
   */
  text?: TextBlock;
  /** File behind an `image` or `audio` element. */
  media?: MediaInfo;
  /** How an `image` fills its box (default `fill`), see `image-fit.ts`. */
  imageFit?: ImageFit;
  /** Part of the image an `image` in `crop` mode shows. */
  crop?: CropRect;
  /** Playback volume of an `audio` element, 0..1. */
  volume?: number;
  /**
   * Polyline of an `ink` stroke: flat [u0, v0, u1, v1, …] as fractions (0..1) of the box,
   * so moving, resizing and rotating the box reshapes the stroke without touching them.
   * Keep the array reference unchanged when only geometry changes.
   */
  points?: readonly number[];
  /**
   * Group the element belongs to (any element with the same id is in it). Grouped
   * elements are selected, moved and transformed together; see `group.ts`.
   */
  groupId?: string;
}

export const isMedia = (el: BoardElement): el is ShapeElement & { media: MediaInfo } =>
  (el.type === 'image' || el.type === 'audio') && 'media' in el && !!el.media;

export type BoardElement = ShapeElement | ConnectorElement;

export const isShape = (el: BoardElement): el is ShapeElement => el.type !== 'connector';
export const isConnector = (el: BoardElement): el is ConnectorElement => el.type === 'connector';

/**
 * Fields that can be changed with `Scene.update`. `id` and `type` are immutable.
 * Only fields of the element's own kind should be patched.
 */
export type ElementPatch = Partial<Omit<ShapeElement, 'id' | 'type'>> &
  Partial<Omit<ConnectorElement, 'id' | 'type'>>;

const TEXT_PADDING: Record<ShapeKind, number> = {
  sticky: 16,
  rect: 10,
  ellipse: 6,
  polygon: 6,
  text: 0,
  image: 0,
  audio: 0,
  ink: 0,
};

/**
 * Area available for text, relative to the element's top-left corner (unrotated).
 * Ellipses use the inscribed rectangle, polygons a box that fits inside them.
 */
export function textArea(el: ShapeElement): Box {
  const pad = TEXT_PADDING[el.type] + el.strokeWidth / 2;
  let insetX = pad;
  let insetY = pad;
  if (el.type === 'polygon') {
    const t = polygonTextBox(polygonSides(el));
    const minX = el.w * t.x0 + pad;
    const minY = el.h * t.y0 + pad;
    return {
      minX,
      minY,
      maxX: Math.max(minX, el.w * t.x1 - pad),
      maxY: Math.max(minY, el.h * t.y1 - pad),
    };
  }
  if (el.type === 'ellipse') {
    const k = (1 - Math.SQRT1_2) / 2;
    insetX += el.w * k;
    insetY += el.h * k;
  }
  return {
    minX: insetX,
    minY: insetY,
    maxX: Math.max(insetX, el.w - insetX),
    maxY: Math.max(insetY, el.h - insetY),
  };
}

/** World-space AABB of a shape, including rotation and stroke. */
export function elementBounds(el: ShapeElement): Box {
  const half = el.strokeWidth / 2;
  if (el.rotation === 0) {
    return {
      minX: el.x - half,
      minY: el.y - half,
      maxX: el.x + el.w + half,
      maxY: el.y + el.h + half,
    };
  }
  // Rotated half-extents avoid allocating and rotating four corners on every move.
  const cos = Math.abs(Math.cos(el.rotation));
  const sin = Math.abs(Math.sin(el.rotation));
  const halfW = (el.w * cos + el.h * sin) / 2 + half;
  const halfH = (el.w * sin + el.h * cos) / 2 + half;
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  return { minX: cx - halfW, minY: cy - halfH, maxX: cx + halfW, maxY: cy + halfH };
}
