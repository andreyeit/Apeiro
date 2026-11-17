import { fontIndex } from './fonts';
import {
  fontVariant,
  type FontVariant,
  graphemes,
  LINE_HEIGHT,
  LINK_COLOR,
  LIST_GAP_EM,
  listMarkers,
  MIN_AUTOFIT_SIZE,
  paragraphIndent,
  paragraphStyle,
  type ParagraphStyle,
  runSize,
  type TextBlock,
  type TextRun,
  variantFamily,
} from './text-block';

/**
 * Text layout: line breaking, alignment, lists, decorations and links of a `TextBlock`.
 * Pure: glyph widths come from a `FontMeasurer`, so layout runs (and is tested) without
 * a DOM.
 */

export interface FontMeasurer {
  /** Advance width of a grapheme cluster in em (i.e. for font size 1). */
  advance(cluster: string, variant: FontVariant): number;
  /**
   * Kerning adjustment between two adjacent clusters, in em, added to the left one.
   * Optional: without it, layout sums plain advances.
   */
  kerning?(left: string, right: string, variant: FontVariant): number;
  /** Ascent above the baseline, in em (of the default family). */
  readonly ascent: number;
  /** Descent below the baseline, in em (positive). */
  readonly descent: number;
  /** Vertical metrics of a variant's family; defaults to `ascent`/`descent`. */
  metrics?(variant: FontVariant): { ascent: number; descent: number };
}

export interface LaidOutGlyph {
  /** A grapheme cluster: one visible character, possibly several code points (👨‍👩‍👧, 🇷🇺). */
  char: string;
  variant: FontVariant;
  /** Pen position at the baseline, in box-local coordinates (top-left origin). */
  x: number;
  y: number;
  color: number;
  /** Font size it is drawn at (after `autoFit`). */
  size: number;
}

/** Underline/strike-through line, box-local. */
export interface LaidOutDecoration {
  x: number;
  y: number;
  width: number;
  thickness: number;
  color: number;
}

/** One rendered line, box-local. Used for "greeking" (bars instead of glyphs when tiny). */
export interface LaidOutLine {
  x: number;
  /** Baseline. */
  y: number;
  width: number;
  /** Color of the line's first glyph. */
  color: number;
  /** Largest font size on the line. */
  size: number;
}

/** Clickable area of a link on one line, box-local. */
export interface LaidOutLink {
  href: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TextLayout {
  /** The block's base font size after `autoFit` (`fontSize * scale`). */
  fontSize: number;
  /** `autoFit` factor applied to every size (1 without autoFit or when the text fits). */
  scale: number;
  /** Largest font size used, after `autoFit`. */
  maxFontSize: number;
  glyphs: LaidOutGlyph[];
  decorations: LaidOutDecoration[];
  lines: LaidOutLine[];
  links: LaidOutLink[];
  lineCount: number;
  /** Size of the laid out text (not the box), list indentation included. */
  width: number;
  height: number;
  /** False if the text overflows the box even at the minimum font size. */
  fits: boolean;
}

const isSpace = (ch: string) => ch === ' ' || ch === '\t';
const HYPHENS = new Set(['-', '‐', '–', '—']);
/** Scripts that break between any two characters (no spaces between words). */
const BREAK_ANYWHERE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

// --- Layout -----------------------------------------------------------------

interface Char {
  ch: string;
  run: TextRun;
  variant: FontVariant;
  /** Font size before `autoFit`. */
  size: number;
  /** Advance in world units before `autoFit`, kerning with the next char included. */
  adv: number;
}

interface Token {
  chars: Char[];
  width: number;
  space: boolean;
}

interface Paragraph {
  tokens: Token[];
  style: ParagraphStyle;
  /** Left indentation (lists), before `autoFit`. */
  indent: number;
}

interface Line {
  chars: Char[];
  /** Width, trailing spaces included, before `autoFit`. */
  width: number;
  para: Paragraph;
  /** First line of its paragraph: list items draw their marker there. */
  first: boolean;
}

function toParagraphs(block: TextBlock, measurer: FontMeasurer): Char[][] {
  const paragraphs: Char[][] = [[]];
  const baseFamily = fontIndex(block.font);
  // A '\r' ends a line by itself too; '\r' then '\n' (possibly split across runs) is one break.
  let afterCR = false;
  for (const run of block.runs) {
    const family = run.font === undefined ? baseFamily : fontIndex(run.font);
    const variant = fontVariant(run.bold, run.italic, family);
    const size = runSize(run, block);
    for (const ch of graphemes(run.text)) {
      if (ch === '\n' && afterCR) {
        afterCR = false;
        continue;
      }
      afterCR = ch === '\r';
      if (ch === '\n' || ch === '\r\n' || ch === '\r') {
        paragraphs.push([]);
        continue;
      }
      paragraphs[paragraphs.length - 1]!.push({
        ch,
        run,
        variant,
        size,
        adv: measurer.advance(ch, variant) * size,
      });
    }
  }
  if (measurer.kerning) {
    for (const para of paragraphs) {
      for (let i = 0; i + 1 < para.length; i++) {
        const a = para[i]!;
        const b = para[i + 1]!;
        if (a.variant === b.variant && a.size === b.size && !isSpace(a.ch))
          a.adv += measurer.kerning(a.ch, b.ch, a.variant) * a.size;
      }
    }
  }
  return paragraphs;
}

/**
 * Splits a paragraph at line break opportunities, close to what browsers do for
 * Latin/Cyrillic: after spaces, after hyphens and dashes, around CJK characters.
 */
function tokenize(para: Char[]): Token[] {
  const tokens: Token[] = [];
  let cur: Token | null = null;
  const flush = () => {
    if (cur) tokens.push(cur);
    cur = null;
  };
  for (let i = 0; i < para.length; i++) {
    const c = para[i]!;
    const space = isSpace(c.ch);
    if (!cur || cur.space !== space) {
      flush();
      cur = { chars: [], width: 0, space };
    }
    const token: Token = cur;
    if (!space && BREAK_ANYWHERE.test(c.ch) && token.chars.length > 0) {
      flush();
      cur = { chars: [], width: 0, space: false };
    }
    cur!.chars.push(c);
    cur!.width += c.adv;
    const next = para[i + 1];
    const breakAfter =
      !space &&
      next !== undefined &&
      !isSpace(next.ch) &&
      (HYPHENS.has(c.ch) || BREAK_ANYWHERE.test(c.ch));
    if (breakAfter) flush();
  }
  flush();
  return tokens;
}

/** Greedy line breaking; `maxWidth` (before `autoFit`) is reduced by each paragraph's indent. */
function wrap(paragraphs: Paragraph[], maxWidth: number): Line[] {
  const lines: Line[] = [];
  for (const para of paragraphs) {
    // A hair of slack: sums of the same advances in another order differ in the last bits,
    // and a box sized exactly to its text must not wrap because of that.
    const limit = maxWidth - para.indent + Math.max(1, Math.abs(maxWidth)) * 1e-9;
    let first = true;
    let line: Char[] = [];
    let lineWidth = 0; // includes trailing spaces
    const push = () => {
      lines.push(finish(line, para, first));
      first = false;
      line = [];
      lineWidth = 0;
    };
    const byChars = (token: Token) => {
      for (const c of token.chars) {
        if (line.length > 0 && lineWidth + c.adv > limit) push();
        line.push(c);
        lineWidth += c.adv;
      }
    };
    for (const token of para.tokens) {
      if (token.space) {
        // Spaces take room like any character (CSS `white-space: break-spaces`, as the
        // editor lays them out): one that doesn't fit wraps to the next line instead of
        // hanging past the box, so the caret after it stays inside the box.
        byChars(token);
        continue;
      }
      if (line.length === 0 || lineWidth + token.width <= limit) {
        // A single word wider than the box: break it by characters.
        if (line.length === 0 && token.width > limit) byChars(token);
        else {
          line.push(...token.chars);
          lineWidth += token.width;
        }
        continue;
      }
      push();
      if (token.width > limit) byChars(token);
      else {
        line.push(...token.chars);
        lineWidth += token.width;
      }
    }
    push();
  }
  return lines;
}

function finish(chars: Char[], para: Paragraph, first: boolean): Line {
  // Trailing spaces count (they don't hang, as in the editor): alignment includes them.
  let width = 0;
  for (const c of chars) width += c.adv;
  return { chars, width, para, first };
}

/** Widest unbreakable piece plus its paragraph's indent, before `autoFit`. */
function widestToken(paragraphs: Paragraph[]): number {
  let max = 0;
  for (const p of paragraphs)
    for (const t of p.tokens) if (!t.space) max = Math.max(max, t.width + p.indent);
  return max;
}

/**
 * Vertical extent of a line like CSS computes it with `line-height: 1.3` everywhere: every
 * inline box (the block's own "strut" and each char's span) is 1.3x its font size tall,
 * centered on its font's ascent+descent; the line spans all of them, baselines aligned.
 */
class LineMetrics {
  private cache = new Map<string, [number, number]>();
  readonly strut: [number, number];

  constructor(
    private measurer: FontMeasurer,
    block: TextBlock,
  ) {
    this.strut = this.of(fontVariant(false, false, fontIndex(block.font)), block.fontSize);
  }

  /** [above, below] the baseline for a font size, before `autoFit`. */
  of(variant: FontVariant, size: number): [number, number] {
    const family = variantFamily(variant);
    const key = `${family}|${size}`;
    let v = this.cache.get(key);
    if (!v) {
      const m = this.measurer.metrics?.(variant) ?? this.measurer;
      v = [
        (size * (LINE_HEIGHT + m.ascent - m.descent)) / 2,
        (size * (LINE_HEIGHT - m.ascent + m.descent)) / 2,
      ];
      this.cache.set(key, v);
    }
    return v;
  }

  line(line: Line): [number, number] {
    let [above, below] = this.strut;
    for (const c of line.chars) {
      const [a, b] = this.of(c.variant, c.size);
      if (a > above) above = a;
      if (b > below) below = b;
    }
    return [above, below];
  }
}

function textHeight(lines: Line[], metrics: LineMetrics): number {
  let h = 0;
  for (const line of lines) {
    const [a, b] = metrics.line(line);
    h += a + b;
  }
  return h;
}

/**
 * Lays out `block` inside a `width` x `height` box (already reduced by padding).
 * Coordinates in the result are relative to the box's top-left corner.
 */
export function layoutText(
  block: TextBlock,
  width: number,
  height: number,
  measurer: FontMeasurer,
  /** Lines break only at line breaks (auto-width text); alignment still uses `width`. */
  noWrap = false,
): TextLayout {
  // Guard the divisions below against data that skipped validation.
  const base =
    Number.isFinite(block.fontSize) && block.fontSize > 0 ? block.fontSize : MIN_AUTOFIT_SIZE;
  if (base !== block.fontSize) block = { ...block, fontSize: base };
  const paragraphs: Paragraph[] = toParagraphs(block, measurer).map((chars, i) => {
    const style = paragraphStyle(block, i);
    return { tokens: tokenize(chars), style, indent: paragraphIndent(style, base) };
  });
  const metrics = new LineMetrics(measurer, block);
  const wrapWidth = (k: number) => (noWrap ? Infinity : width / k);
  const fitsAt = (k: number) =>
    (noWrap || widestToken(paragraphs) * k <= width) &&
    textHeight(wrap(paragraphs, wrapWidth(k)), metrics) * k <= height;

  let k = 1;
  let fits = true;
  if (block.autoFit && !fitsAt(1)) {
    // Binary search the largest scale whose base size is in [MIN, fontSize] and fits.
    let lo = Math.min(MIN_AUTOFIT_SIZE, base) / base;
    let hi = 1;
    if (!fitsAt(lo)) {
      k = lo;
      fits = false;
    } else {
      for (let iter = 0; iter < 12 && (hi - lo) * base > 0.25; iter++) {
        const mid = (lo + hi) / 2;
        if (fitsAt(mid)) lo = mid;
        else hi = mid;
      }
      k = lo;
    }
  }

  const lines = wrap(paragraphs, wrapWidth(k));
  const total = textHeight(lines, metrics) * k;
  if (!block.autoFit) fits = total <= height;
  let y =
    block.verticalAlign === 'top'
      ? 0
      : block.verticalAlign === 'bottom'
        ? height - total
        : (height - total) / 2;

  const markers = paragraphs.some((p) => p.style.list) ? listMarkers(block, paragraphs.length) : [];
  const markerVariant = fontVariant(false, false, fontIndex(block.font));
  const glyphs: LaidOutGlyph[] = [];
  const decorations: LaidOutDecoration[] = [];
  const outLines: LaidOutLine[] = [];
  const links: LaidOutLink[] = [];
  let maxWidth = 0;
  let maxSize = base * k;

  for (const line of lines) {
    const [above, below] = metrics.line(line);
    const top = y;
    const baseline = y + above * k;
    y += (above + below) * k;
    const indent = line.para.indent * k;
    const lineW = line.width * k;
    const avail = width - indent;
    const x0 =
      indent +
      (block.align === 'left' ? 0 : block.align === 'right' ? avail - lineW : (avail - lineW) / 2);
    maxWidth = Math.max(maxWidth, indent + lineW);

    const marker = line.first ? markers[paragraphs.indexOf(line.para)] : undefined;
    if (marker) {
      // Right-aligned against the text, like `::before` in the DOM editor.
      const size = base * k;
      const chars = graphemes(marker);
      const advs = chars.map((c) => measurer.advance(c, markerVariant) * size);
      let x = x0 - LIST_GAP_EM * size - advs.reduce((s, a) => s + a, 0);
      chars.forEach((char, i) => {
        glyphs.push({ char, variant: markerVariant, x, y: baseline, color: block.color, size });
        x += advs[i]!;
      });
    }

    let lineSize = 0;
    let underline: LaidOutDecoration | undefined;
    let strike: LaidOutDecoration | undefined;
    let link: LaidOutLink | undefined;
    let x = x0;
    for (const c of line.chars) {
      const run = c.run;
      const color = run.color ?? (run.link ? LINK_COLOR : block.color);
      const size = c.size * k;
      const adv = c.adv * k;
      lineSize = Math.max(lineSize, size);
      if (!isSpace(c.ch))
        glyphs.push({ char: c.ch, variant: c.variant, x, y: baseline, color, size });
      underline = extend(
        underline,
        run.underline || !!run.link,
        x,
        adv,
        baseline + size * 0.12,
        size,
        color,
        decorations,
      );
      strike = extend(strike, run.strike, x, adv, baseline - size * 0.3, size, color, decorations);
      if (run.link) {
        if (link && link.href === run.link) link.width = x + adv - link.x;
        else {
          link = { href: run.link, x, y: top, width: adv, height: (above + below) * k };
          links.push(link);
        }
      } else link = undefined;
      x += adv;
    }
    maxSize = Math.max(maxSize, lineSize);
    if (line.chars.length > 0) {
      const first = line.chars[0]!.run;
      outLines.push({
        x: x0,
        y: baseline,
        width: lineW,
        color: first.color ?? (first.link ? LINK_COLOR : block.color),
        size: lineSize,
      });
    }
  }

  return {
    fontSize: base * k,
    scale: k,
    maxFontSize: maxSize,
    glyphs,
    decorations,
    lines: outLines,
    links,
    lineCount: lines.length,
    width: maxWidth,
    height: total,
    fits,
  };
}

/** Extends the current decoration segment or starts a new one; consecutive chars share one line. */
function extend(
  current: LaidOutDecoration | undefined,
  enabled: boolean | undefined,
  x: number,
  adv: number,
  y: number,
  size: number,
  color: number,
  out: LaidOutDecoration[],
): LaidOutDecoration | undefined {
  if (!enabled) return undefined;
  const thickness = Math.max(1, size * 0.07);
  if (
    current &&
    current.color === color &&
    current.y === y &&
    current.thickness === thickness &&
    Math.abs(current.x + current.width - x) < 1e-6
  ) {
    current.width += adv;
    return current;
  }
  const d = { x, y, width: adv, thickness, color };
  out.push(d);
  return d;
}
