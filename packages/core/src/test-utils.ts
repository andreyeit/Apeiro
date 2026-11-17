import type { ShapeElement } from './elements/element';

export function makeRect(id: string, patch: Partial<ShapeElement> = {}): ShapeElement {
  return {
    id,
    type: 'rect',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    rotation: 0,
    z: 0,
    fill: 0xffffffff,
    stroke: 0x000000ff,
    strokeWidth: 0,
    radius: 0,
    ...patch,
  };
}
