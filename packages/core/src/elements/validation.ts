import type { BoardElement } from './element';
import type { Vec2 } from '../geometry/math';
import { MAX_POLYGON_SIDES, MIN_POLYGON_SIDES } from './shape-geometry';
import { MAX_LIST_INDENT } from '../text/text-block';
import { isAllowedLink } from '../text/rich-text';

const SHAPE_KINDS = new Set<string>([
  'rect',
  'ellipse',
  'polygon',
  'sticky',
  'text',
  'image',
  'audio',
  'ink',
]);
const ROUTES = new Set<string>(['straight', 'elbow', 'curve']);
const CAPS = new Set<string>(['none', 'arrow', 'triangle', 'circle', 'diamond']);
const DASHES = new Set<string>(['solid', 'dashed', 'dotted']);
const IMAGE_FITS = new Set<string>(['fill', 'fit', 'crop']);
const SIZINGS = new Set<string>(['auto-width', 'auto-height', 'fixed']);
const ALIGNS = new Set<string>(['left', 'center', 'right', 'top', 'middle', 'bottom']);

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function checkEnd(end: unknown, name: string): string | null {
  const e = end as { kind?: unknown; x?: unknown; y?: unknown; id?: unknown; anchor?: Vec2 };
  if (!e || typeof e !== 'object') return `${name} is missing`;
  if (e.kind === 'point') return finite(e.x) && finite(e.y) ? null : `${name} point is not finite`;
  if (e.kind !== 'element' || typeof e.id !== 'string') return `${name} has an invalid kind`;
  if (e.anchor !== undefined && !(finite(e.anchor.x) && finite(e.anchor.y)))
    return `${name} anchor is not finite`;
  return null;
}

/**
 * Why an element can't be stored, or null if it is fine. Non-finite numbers would make
 * the element invisible to hit testing and break layout, so data coming from the network
 * must be checked before it reaches the scene (`Scene.add/update` do this and throw).
 */
export function validateElement(el: BoardElement): string | null {
  if (!el || typeof el.id !== 'string' || el.id === '') return 'id must be a non-empty string';
  if (!finite(el.z)) return 'z must be finite';
  if (el.groupId !== undefined && (typeof el.groupId !== 'string' || el.groupId === ''))
    return 'groupId must be a non-empty string';
  if (el.type === 'connector') {
    if (!ROUTES.has(el.route)) return `unknown route ${String(el.route)}`;
    if (!DASHES.has(el.dash)) return `unknown dash ${String(el.dash)}`;
    if (!CAPS.has(el.startCap) || !CAPS.has(el.endCap)) return 'unknown cap';
    if (!finite(el.strokeWidth) || el.strokeWidth < 0) return 'strokeWidth must be >= 0';
    if (!finite(el.stroke)) return 'stroke must be a packed color';
    if (el.curve && !(finite(el.curve.along) && finite(el.curve.across)))
      return 'curve must be finite';
    if (el.elbowAt !== undefined && !finite(el.elbowAt)) return 'elbowAt must be finite';
    if (el.cornerRadius !== undefined && !(finite(el.cornerRadius) && el.cornerRadius >= 0))
      return 'cornerRadius must be >= 0';
    return checkEnd(el.start, 'start') ?? checkEnd(el.end, 'end');
  }
  if (!SHAPE_KINDS.has(el.type)) return `unknown type ${String(el.type)}`;
  for (const k of [
    'x',
    'y',
    'w',
    'h',
    'rotation',
    'radius',
    'strokeWidth',
    'fill',
    'stroke',
  ] as const)
    if (!finite(el[k])) return `${k} must be finite`;
  if (el.w < 0 || el.h < 0) return 'size must be >= 0';
  if (el.radius < 0) return 'radius must be >= 0';
  if (
    el.sides !== undefined &&
    !(Number.isInteger(el.sides) && el.sides >= MIN_POLYGON_SIDES && el.sides <= MAX_POLYGON_SIDES)
  )
    return `sides must be an integer in ${MIN_POLYGON_SIDES}..${MAX_POLYGON_SIDES}`;
  if (el.strokeWidth < 0) return 'strokeWidth must be >= 0';
  if (el.strokeStyle !== undefined && !DASHES.has(el.strokeStyle)) return 'unknown strokeStyle';
  if (el.volume !== undefined && !(finite(el.volume) && el.volume >= 0 && el.volume <= 1))
    return 'volume must be in 0..1';
  if (el.text) {
    if (!Array.isArray(el.text.runs)) return 'text.runs must be an array';
    if (!finite(el.text.fontSize) || el.text.fontSize <= 0) return 'text.fontSize must be > 0';
    if (!finite(el.text.color)) return 'text.color must be a packed color';
    if (el.text.sizing !== undefined && !SIZINGS.has(el.text.sizing)) return 'unknown text.sizing';
    for (const k of ['align', 'verticalAlign'] as const)
      if (!ALIGNS.has(el.text[k])) return `unknown text.${k}`;
    for (const run of el.text.runs) {
      if (!run || typeof run.text !== 'string') return 'text run must have text';
      if (run.size !== undefined && !(finite(run.size) && run.size > 0))
        return 'run size must be > 0';
      if (run.color !== undefined && !finite(run.color)) return 'run color must be a packed color';
      if (run.link !== undefined && !(typeof run.link === 'string' && isAllowedLink(run.link)))
        return 'run link must be an http(s) or mailto URL';
    }
    const paragraphs: unknown = el.text.paragraphs;
    if (paragraphs !== undefined) {
      if (!Array.isArray(paragraphs)) return 'text.paragraphs must be an array';
      for (const p of paragraphs as Array<{ list?: unknown; indent?: unknown } | null>) {
        if (p === null || typeof p !== 'object') return 'paragraph style must be an object';
        if (p.list !== undefined && p.list !== 'bullet' && p.list !== 'ordered')
          return 'unknown list kind';
        if (
          p.indent !== undefined &&
          !(
            Number.isInteger(p.indent) &&
            (p.indent as number) >= 0 &&
            (p.indent as number) <= MAX_LIST_INDENT
          )
        )
          return `list indent must be an integer in 0..${MAX_LIST_INDENT}`;
      }
    }
  }
  if (el.media && typeof el.media.src !== 'string') return 'media.src must be a string';
  if (el.imageFit !== undefined && !IMAGE_FITS.has(el.imageFit)) return 'unknown imageFit';
  if (el.crop !== undefined) {
    const c = el.crop;
    if (!c || !finite(c.x) || !finite(c.y) || !finite(c.w) || !finite(c.h))
      return 'crop must be finite';
    const eps = 1e-6;
    if (
      c.w <= 0 ||
      c.h <= 0 ||
      c.x < -eps ||
      c.y < -eps ||
      c.x + c.w > 1 + eps ||
      c.y + c.h > 1 + eps
    )
      return 'crop must be a part of the image (0..1)';
  }
  if (el.points !== undefined) {
    const pts: unknown = el.points;
    if (!Array.isArray(pts) || pts.length % 2 !== 0) return 'points must be [u, v, …] pairs';
    for (const v of pts as unknown[]) if (!finite(v)) return 'points must be finite';
  }
  if (el.type === 'ink' && !(el.points && el.points.length >= 2))
    return 'ink needs at least one point';
  return null;
}
