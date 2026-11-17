import { isShape, type ElementPatch } from '@apeiro/core';
import type { InputContext } from './context';

/**
 * Puts back what the current gesture changed (Esc, or the system took the pointer away).
 * Returns false when there is nothing to revert (idle, or a custom tool: see `controls.ts`).
 */
export function revertGesture(c: InputContext): boolean {
  const { mode: m, scene } = c;
  switch (m.kind) {
    case 'connect':
      if (m.original === null) scene.remove(m.id);
      else scene.update(m.id, { [m.which]: m.original } as ElementPatch);
      return true;
    case 'drag':
      scene.transact(() => {
        for (const [id, o] of m.origin) {
          if (o.kind === 'shape') scene.update(id, { x: o.x, y: o.y });
          else scene.update(id, { start: o.start, end: o.end });
        }
      });
      return true;
    case 'bend':
      scene.update(m.id, m.original);
      return true;
    case 'volume':
      scene.update(m.id, { volume: m.original });
      return true;
    case 'radius':
      scene.update(m.id, { radius: m.original });
      return true;
    case 'count':
      scene.update(m.id, { sides: m.original });
      return true;
    case 'crop': {
      const o = m.original;
      scene.update(o.id, { x: o.x, y: o.y, w: o.w, h: o.h, imageFit: o.imageFit, crop: o.crop });
      return true;
    }
    case 'resize':
    case 'rotate':
      scene.transact(() => {
        for (const o of m.originals) {
          if (isShape(o)) {
            scene.update(o.id, {
              x: o.x,
              y: o.y,
              w: o.w,
              h: o.h,
              rotation: o.rotation,
              ...(o.text ? { text: o.text } : {}),
            });
          } else {
            scene.update(o.id, { start: o.start, end: o.end });
          }
        }
      });
      return true;
    case 'ink':
      scene.remove(m.id);
      return true;
    case 'marquee':
      c.overlay.selection = new Set(m.base);
      return true;
    case 'seek':
    case 'textbox':
    case 'place':
    case 'erase':
      return true;
    case 'idle':
    case 'pan':
    case 'custom':
      return false;
  }
}
