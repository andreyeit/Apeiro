import {
  hexColor,
  type Scene,
  type ShapeElement,
  type ShapeKind,
  type Vec2,
  type LineDash,
} from '@apeiro/core';
import { newId } from '../ids';

/** What the "add shape" buttons create. */
export interface ShapePreset {
  type: Extract<ShapeKind, 'rect' | 'ellipse' | 'polygon'>;
  w: number;
  h: number;
  sides?: number;
  fill: number;
  stroke: number;
  strokeWidth: number;
  strokeStyle?: LineDash;
  radius: number;
}

/**
 * New shapes look like the design's Canvas Block: white (color/background), a 1.5px border
 * in color/foreground; rectangles are 120×120 squares (as big as the circle) with radius/sm
 * (8) corners.
 */
const BLOCK = { fill: hexColor('#ffffff'), stroke: hexColor('#18181b'), strokeWidth: 1.5 };

export const SHAPE_PRESETS = {
  rect: { type: 'rect', w: 120, h: 120, radius: 8, ...BLOCK },
  ellipse: { type: 'ellipse', w: 120, h: 120, radius: 0, ...BLOCK },
  triangle: { type: 'polygon', sides: 3, w: 132, h: 114, radius: 0, ...BLOCK },
  polygon: { type: 'polygon', sides: 5, w: 126, h: 120, radius: 0, ...BLOCK },
} satisfies Record<string, ShapePreset>;

/** A new shape centered at `center`, above everything else. */
export function createShape(scene: Scene, preset: ShapePreset, center: Vec2): ShapeElement {
  const el: ShapeElement = {
    id: newId('s'),
    type: preset.type,
    x: center.x - preset.w / 2,
    y: center.y - preset.h / 2,
    w: preset.w,
    h: preset.h,
    rotation: 0,
    z: scene.maxZ() + 1,
    fill: preset.fill,
    stroke: preset.stroke,
    strokeWidth: preset.strokeWidth,
    ...(preset.strokeStyle !== undefined ? { strokeStyle: preset.strokeStyle } : {}),
    radius: preset.radius,
    ...(preset.sides !== undefined ? { sides: preset.sides } : {}),
  };
  scene.add(el);
  return el;
}
