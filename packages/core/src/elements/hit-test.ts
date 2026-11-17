import type { ShapeElement } from './element';
import type { Vec2 } from '../geometry/math';
import { inkDistance } from './ink';
import { shapeSdf } from './shape-geometry';

/**
 * Precise point-in-element test in world space.
 * `tolerance` (world units) expands the shape, so thin or tiny elements stay clickable
 * when zoomed out. Callers usually pass `screenTolerancePx / camera.zoom`.
 */
export function hitTestElement(el: ShapeElement, p: Vec2, tolerance = 0): boolean {
  // A pen stroke is hit near its line, not anywhere in its box.
  if (el.type === 'ink') return inkDistance(el, p) <= el.strokeWidth / 2 + tolerance;
  // Move the point into the element's local, unrotated frame centered at the box center.
  const hw = el.w / 2;
  const hh = el.h / 2;
  let lx = p.x - (el.x + hw);
  let ly = p.y - (el.y + hh);
  if (el.rotation !== 0) {
    const c = Math.cos(-el.rotation);
    const s = Math.sin(-el.rotation);
    const rx = lx * c - ly * s;
    ly = lx * s + ly * c;
    lx = rx;
  }
  const pad = el.strokeWidth / 2 + tolerance;

  if (el.type === 'ellipse') {
    const rx = hw + pad;
    const ry = hh + pad;
    if (rx <= 0 || ry <= 0) return false;
    return (lx * lx) / (rx * rx) + (ly * ly) / (ry * ry) <= 1;
  }

  if (el.type === 'polygon') return shapeSdf(el, { x: lx, y: ly }) <= pad;

  // Rounded rectangle SDF; same formula as the fragment shader so hits match pixels.
  const r = Math.min(el.radius, hw, hh);
  const qx = Math.abs(lx) - (hw - r);
  const qy = Math.abs(ly) - (hh - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - r <= pad;
}
