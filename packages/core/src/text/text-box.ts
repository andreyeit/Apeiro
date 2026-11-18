import type { ElementPatch, ShapeElement, ShapeKind } from '../elements/element';
import { fontIndex } from './fonts';
import { layoutText, type FontMeasurer } from './layout';
import { textBlock, type TextBlock, type TextSizing } from './text-block';

/** Color of new text (the design's color/foreground). */
const TEXT_COLOR = 0x18181bff;

/** Font size of new free text boxes. */
export const DEFAULT_TEXT_SIZE = 24;
export const MIN_FONT_SIZE = 1;
export const MAX_FONT_SIZE = 1000;
/** Font sizes offered in pickers (Figma/Miro-like steps). */
export const FONT_SIZES: readonly number[] = [
  10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 96, 128, 144, 200, 288,
];

/** A text box too narrow to see or click stays this wide (in font sizes). */
const MIN_WIDTH_EM = 0.5;
/** Far wider than any line: "no wrapping" for auto-width text. */
const UNBOUNDED = 1e7;

/**
 * How the box of a frameless `text` element follows its text, like Figma's resizing modes:
 * `auto-width` grows sideways and never wraps, `auto-height` keeps the width and grows
 * down, `fixed` never changes. Other shapes keep their size (stickies shrink the font).
 */
export function textSizing(el: ShapeElement): TextSizing {
  return el.type === 'text' ? (el.text?.sizing ?? 'fixed') : 'fixed';
}

/** Text of a shape that has none yet, styled for its kind (what typing into it starts with). */
export function defaultTextBlock(type: ShapeKind): TextBlock {
  if (type === 'text')
    return textBlock('', {
      fontSize: DEFAULT_TEXT_SIZE,
      color: TEXT_COLOR,
      align: 'left',
      verticalAlign: 'top',
      sizing: 'auto-width',
    });
  // Like the design's Sticky and Canvas Block: 14px text in color/foreground; a sticky is
  // written from its top-left corner, a shape is labelled in the middle.
  return textBlock('', {
    fontSize: 14,
    color: TEXT_COLOR,
    autoFit: true,
    ...(type === 'sticky' ? { align: 'left', verticalAlign: 'top' } : {}),
  });
}

/** A new text element with its top-left at `at`; with `width`, it wraps at that width. */
export function createTextElement(
  id: string,
  at: { x: number; y: number },
  z: number,
  width?: number,
  block: TextBlock = defaultTextBlock('text'),
): ShapeElement {
  const text: TextBlock = { ...block, sizing: width === undefined ? 'auto-width' : 'auto-height' };
  const h = text.fontSize * 1.3;
  return {
    id,
    type: 'text',
    x: at.x,
    y: at.y,
    w: width ?? text.fontSize * MIN_WIDTH_EM,
    h,
    rotation: 0,
    z,
    fill: 0xffffff00,
    stroke: 0x1f2937ff,
    strokeWidth: 0,
    radius: 0,
    text,
  };
}

/** Size a text element's box should have for its text (border inset included). */
export function measureTextBox(
  el: ShapeElement,
  measurer: FontMeasurer,
  block: TextBlock | undefined = el.text,
): { w: number; h: number } | null {
  const sizing = el.type === 'text' ? (block?.sizing ?? 'fixed') : 'fixed';
  if (!block || sizing === 'fixed') return null;
  const inset = el.strokeWidth; // half a border on each side, as in `textArea`
  const width = sizing === 'auto-width' ? UNBOUNDED : Math.max(0, el.w - inset);
  const layout = layoutText({ ...block, autoFit: false }, width, UNBOUNDED, measurer);
  const minW = block.fontSize * MIN_WIDTH_EM;
  return {
    w: sizing === 'auto-width' ? Math.max(minW, layout.width) + inset : el.w,
    h: layout.height + inset,
  };
}

/**
 * Patch that makes an auto-sized text element fit its text (`block` if given, e.g. one
 * being typed), or null if it already fits. The box grows away from its alignment: left
 * aligned text grows to the right, centered both ways, bottom aligned upward; rotation kept.
 */
export function fitTextPatch(
  el: ShapeElement,
  measurer: FontMeasurer,
  block: TextBlock | undefined = el.text,
): ElementPatch | null {
  const size = measureTextBox(el, measurer, block);
  if (!size) return null;
  const { w, h } = size;
  if (Math.abs(w - el.w) < 1e-3 && Math.abs(h - el.h) < 1e-3) return null;
  const ax = block!.align === 'left' ? 0 : block!.align === 'right' ? 1 : 0.5;
  const ay = block!.verticalAlign === 'top' ? 0 : block!.verticalAlign === 'bottom' ? 1 : 0.5;
  // The anchor point (in the rotated box) stays where it is.
  const c = Math.cos(el.rotation);
  const s = Math.sin(el.rotation);
  const rot = (x: number, y: number) => ({ x: x * c - y * s, y: x * s + y * c });
  const before = rot((ax - 0.5) * el.w, (ay - 0.5) * el.h);
  const after = rot((ax - 0.5) * w, (ay - 0.5) * h);
  const cx = el.x + el.w / 2 + before.x - after.x;
  const cy = el.y + el.h / 2 + before.y - after.y;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/**
 * Makes a `text` box hug its text (Figma: double click on a resize handle): `auto-width`
 * fits width and height, `auto-height` keeps the width and fits the height. Returns the
 * patch (sizing and the fitted box), or null for other elements.
 */
export function hugTextPatch(
  el: ShapeElement,
  measurer: FontMeasurer,
  sizing: Exclude<TextSizing, 'fixed'>,
): ElementPatch | null {
  if (el.type !== 'text') return null;
  const block: TextBlock = { ...(el.text ?? textBlock('')), sizing };
  const fit = fitTextPatch({ ...el, text: block }, measurer, block);
  return { text: block, ...fit };
}

/** Clamps a font size to the supported range, rounded to 0.1 like design tools show it. */
export function clampFontSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_TEXT_SIZE;
  return Math.round(Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size)) * 10) / 10;
}

/** Next preset size up (`dir` 1) or down (-1) from `size`, for "A+ / A−" buttons. */
export function stepFontSize(size: number, dir: 1 | -1): number {
  if (dir > 0) {
    const next = FONT_SIZES.find((s) => s > size + 1e-6);
    return clampFontSize(next ?? size * 1.25);
  }
  const prev = [...FONT_SIZES].reverse().find((s) => s < size - 1e-6);
  return clampFontSize(prev ?? size / 1.25);
}

/** The whole text at one size: the block's, with every run's own size dropped. */
export function withFontSize(block: TextBlock, size: number): TextBlock {
  const fontSize = clampFontSize(size);
  const runs = block.runs.some((r) => r.size !== undefined)
    ? block.runs.map(({ size: _drop, ...r }) => r)
    : block.runs;
  return { ...block, fontSize, runs };
}

/**
 * Steps the text's size up or down ("A+ / A−"): the block's size moves to the next preset
 * and every run's own size by the same ratio, so a bigger heading stays bigger.
 */
export function stepTextSize(block: TextBlock, dir: 1 | -1, scale = 1): TextBlock {
  const next = clampFontSize(stepFontSize(block.fontSize * scale, dir) / scale);
  const ratio = next / block.fontSize;
  const runs = block.runs.map((r) =>
    r.size === undefined ? r : { ...r, size: clampFontSize(r.size * ratio) },
  );
  return { ...block, fontSize: next, runs };
}

/** The whole text in one font family (the default one is stored as no `font`). */
export function withFont(block: TextBlock, id: string): TextBlock {
  const runs = block.runs.some((r) => r.font !== undefined)
    ? block.runs.map(({ font: _drop, ...r }) => r)
    : block.runs;
  const next: TextBlock = { ...block, runs, font: id };
  if (fontIndex(id) === 0) delete next.font;
  return next;
}

/** True if some run has its own size (the block's `fontSize` is not the only one). */
export const hasMixedSizes = (block: TextBlock): boolean =>
  block.runs.some((r) => r.size !== undefined && r.size !== block.fontSize && r.text !== '');
