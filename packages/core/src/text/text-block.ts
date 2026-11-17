/**
 * Rich text model: runs, paragraphs, lists and the helpers over them. Layout (`layout.ts`)
 * turns a block into positioned glyphs.
 *
 * The run format mirrors a Yjs `Y.Text` delta (`{ insert, attributes }`),
 * so the sync adapter can convert without loss. Paragraph attributes (lists) are kept
 * per paragraph in `TextBlock.paragraphs`; in a delta they map to the attributes of the
 * paragraph's closing newline, as in Quill.
 */

export interface TextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** Packed 0xRRGGBBAA; falls back to the block color (links: `LINK_COLOR`). */
  color?: number;
  /** Font size in world units; falls back to the block's `fontSize`. */
  size?: number;
  /** Font family id (`FONT_FAMILIES`); falls back to the block's `font`. */
  font?: string;
  /** Link target (http, https or mailto). Drawn underlined, in `LINK_COLOR` unless colored. */
  link?: string;
}

export type TextAlign = 'left' | 'center' | 'right';
export type VerticalAlign = 'top' | 'middle' | 'bottom';
/** See `textSizing`: how a `text` element's box follows its text. */
export type TextSizing = 'auto-width' | 'auto-height' | 'fixed';
export type ListKind = 'bullet' | 'ordered';

/** Attributes of a whole paragraph (text between line breaks). */
export interface ParagraphStyle {
  list?: ListKind;
  /** Nesting level of a list item, 0..`MAX_LIST_INDENT`. */
  indent?: number;
}

export interface TextBlock {
  runs: TextRun[];
  /**
   * Default font size (world units) of runs without their own, and the size of empty
   * lines and list markers. With `autoFit` all sizes shrink together until the text fits.
   */
  fontSize: number;
  align: TextAlign;
  verticalAlign: VerticalAlign;
  /** Packed 0xRRGGBBAA. */
  color: number;
  /** Default font family id of runs without their own (default: the first family). */
  font?: string;
  /** Shrink the font until the text fits the box (sticky notes). */
  autoFit?: boolean;
  /** Box sizing of a frameless `text` element (default `fixed`); ignored for other shapes. */
  sizing?: TextSizing;
  /** Style of each paragraph by index; missing entries are plain paragraphs. */
  paragraphs?: ParagraphStyle[];
}

/** Bit 0: bold, bit 1: italic, the rest: index of the font family (`FONT_FAMILIES`). */
export type FontVariant = number;

export const fontVariant = (bold?: boolean, italic?: boolean, family = 0): FontVariant =>
  family * 4 + (bold ? 1 : 0) + (italic ? 2 : 0);

/** Font family index of a variant. */
export const variantFamily = (variant: FontVariant): number => variant >> 2;

export const LINE_HEIGHT = 1.3;
export const MIN_AUTOFIT_SIZE = 6;
/** Indentation per list level, in the block's font size. Markers hang inside it. */
export const LIST_INDENT_EM = 1.8;
/** Space between a list marker and the text, in the block's font size. */
export const LIST_GAP_EM = 0.4;
export const MAX_LIST_INDENT = 4;
export const LINK_COLOR = 0x2563ebff;

/** Font size of a run (its own, else the block's). */
export const runSize = (run: TextRun, block: TextBlock): number =>
  run.size !== undefined && Number.isFinite(run.size) && run.size > 0 ? run.size : block.fontSize;

export const paragraphStyle = (block: TextBlock, index: number): ParagraphStyle =>
  block.paragraphs?.[index] ?? {};

const clampIndent = (indent: number | undefined) =>
  Math.max(0, Math.min(MAX_LIST_INDENT, Math.floor(indent ?? 0)));

/** Left indentation of a paragraph in world units (before `autoFit`). */
export function paragraphIndent(style: ParagraphStyle, fontSize: number): number {
  return style.list ? (clampIndent(style.indent) + 1) * LIST_INDENT_EM * fontSize : 0;
}

const BULLETS = ['•', '◦', '▪'];

function letters(n: number): string {
  let s = '';
  for (let k = n; k > 0; k = Math.floor((k - 1) / 26))
    s = String.fromCharCode(97 + ((k - 1) % 26)) + s;
  return s;
}

function roman(n: number): string {
  const table: Array<[number, string]> = [
    [1000, 'm'],
    [900, 'cm'],
    [500, 'd'],
    [400, 'cd'],
    [100, 'c'],
    [90, 'xc'],
    [50, 'l'],
    [40, 'xl'],
    [10, 'x'],
    [9, 'ix'],
    [5, 'v'],
    [4, 'iv'],
    [1, 'i'],
  ];
  let s = '';
  let k = n;
  for (const [v, r] of table) {
    while (k >= v) {
      s += r;
      k -= v;
    }
  }
  return s;
}

/**
 * Marker of each paragraph ('' for plain ones), like word processors number them:
 * bullets • ◦ ▪ by level; numbers 1. a. i. by level, counting consecutive items of a level.
 * A plain paragraph ends the list; a shallower item restarts the deeper levels.
 */
export function listMarkers(block: TextBlock, count = paragraphCount(block.runs)): string[] {
  const out: string[] = [];
  const counters: number[] = [];
  for (let i = 0; i < count; i++) {
    const style = paragraphStyle(block, i);
    if (!style.list) {
      counters.length = 0;
      out.push('');
      continue;
    }
    const level = clampIndent(style.indent);
    counters.length = Math.min(counters.length, level + 1);
    while (counters.length <= level) counters.push(0);
    if (style.list === 'bullet') {
      counters[level] = 0;
      out.push(BULLETS[level % BULLETS.length]!);
      continue;
    }
    const n = ++counters[level]!;
    const kind = level % 3;
    out.push(`${kind === 0 ? n : kind === 1 ? letters(n) : roman(n)}.`);
  }
  return out;
}

const BREAK = /\r\n|\r|\n/g;

/** Number of paragraphs (line breaks + 1), counted the way layout splits them. */
export function paragraphCount(runs: readonly TextRun[]): number {
  return (
    (runs
      .map((r) => r.text)
      .join('')
      .match(BREAK)?.length ?? 0) + 1
  );
}

/** Index of the paragraph containing the plain-text offset. */
export function paragraphAt(runs: readonly TextRun[], offset: number): number {
  const text = runs.map((r) => r.text).join('');
  return text.slice(0, Math.max(0, offset)).match(BREAK)?.length ?? 0;
}
// --- Segmentation -----------------------------------------------------------

type Segmenter = { segment(input: string): Iterable<{ segment: string }> };
let graphemeSegmenter: Segmenter | null | undefined;

/**
 * Splits text into grapheme clusters, so emoji sequences, flags and combining marks
 * stay one glyph. Falls back to code points where `Intl.Segmenter` is missing.
 */
export function graphemes(text: string): string[] {
  if (graphemeSegmenter === undefined) {
    const Ctor = (Intl as unknown as { Segmenter?: new (l?: string, o?: object) => Segmenter })
      .Segmenter;
    graphemeSegmenter = Ctor ? new Ctor(undefined, { granularity: 'grapheme' }) : null;
  }
  if (!graphemeSegmenter) return [...text];
  const out: string[] = [];
  for (const s of graphemeSegmenter.segment(text)) out.push(s.segment);
  return out;
}

const COLOR_GLYPH = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣|️/u;

/** True for clusters drawn from a color font (emoji, flags, keycaps), not as a one-color outline. */
export const isColorGlyph = (cluster: string): boolean => COLOR_GLYPH.test(cluster);

/** Plain text of a block, e.g. for search or AI prompts. */
export function plainText(block: TextBlock): string {
  return block.runs.map((r) => r.text).join('');
}

export function textBlock(text: string, patch: Partial<TextBlock> = {}): TextBlock {
  return {
    runs: [{ text }],
    fontSize: 16,
    align: 'center',
    verticalAlign: 'middle',
    color: 0x1f2937ff,
    ...patch,
  };
}
