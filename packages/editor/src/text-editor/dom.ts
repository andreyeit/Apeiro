import {
  fontFamily,
  fontIndex,
  listMarkers,
  normalizeParagraphs,
  normalizeRuns,
  paragraphCount,
  paragraphIndent,
  paragraphStyle,
  type ParagraphStyle,
  type TextBlock,
  type TextRun,
  type TextStyle,
} from '@apeiro/core';

/**
 * The editor's DOM is a canonical rendering of a `TextBlock`, read back after the browser
 * changed it (typing, IME, paste, deleting across lines):
 *
 *   input > div[data-p] (one per paragraph; list items carry data-list/indent/marker)
 *         > span (one per run piece: data-b/i/u/s, data-c color, data-size, data-font,
 *                 data-href) > text
 *
 * An empty paragraph holds a `<br data-sentinel>` so it has a line box and a caret spot.
 * Sizes and indents are written as `calc(var(--k) * Npx)`, where the editor sets `--k` to
 * the layout's autoFit scale, so the DOM shrinks exactly like the board text.
 */

export const toCss = (rgba: number) =>
  `rgba(${rgba >>> 24}, ${(rgba >>> 16) & 255}, ${(rgba >>> 8) & 255}, ${(rgba & 255) / 255})`;

/** CSS family of a font id; the default font uses `base` (the renderer's configured family). */
export const familyFor = (id: string | undefined, base: string): string =>
  fontIndex(id) === 0 ? base : fontFamily(id).css;

const scaled = (px: number) => `calc(var(--k, 1) * ${px}px)`;

/** Splits runs at line breaks: the runs of each paragraph. */
function splitParagraphs(runs: readonly TextRun[]): TextRun[][] {
  const out: TextRun[][] = [[]];
  for (const run of runs) {
    const parts = run.text.split('\n');
    parts.forEach((text, i) => {
      if (i > 0) out.push([]);
      if (text) out[out.length - 1]!.push({ ...run, text });
    });
  }
  return out;
}

export function render(
  root: HTMLElement,
  block: TextBlock,
  baseFamily: string,
  openLinkHint = 'Ctrl+click to open',
): void {
  root.replaceChildren();
  const paragraphs = splitParagraphs(block.runs);
  const markers = block.paragraphs ? listMarkers(block, paragraphs.length) : [];
  paragraphs.forEach((runs, i) => {
    const div = document.createElement('div');
    div.dataset.p = '1';
    const style = paragraphStyle(block, i);
    if (style.list) {
      const indent = paragraphIndent(style, block.fontSize);
      div.dataset.list = style.list;
      if (style.indent) div.dataset.indent = String(style.indent);
      div.dataset.marker = markers[i] ?? '';
      div.style.paddingLeft = scaled(indent);
      div.style.setProperty('--mw', scaled(indent));
    }
    for (const run of runs) div.append(span(run, baseFamily, openLinkHint));
    if (runs.length === 0) {
      const br = document.createElement('br');
      br.dataset.sentinel = '1';
      div.append(br);
    }
    root.append(div);
  });
}

function span(run: TextRun, baseFamily: string, openLinkHint: string): HTMLSpanElement {
  const s = document.createElement('span');
  const d = s.dataset;
  if (run.bold) d.b = '1';
  if (run.italic) d.i = '1';
  if (run.underline) d.u = '1';
  if (run.strike) d.s = '1';
  if (run.color !== undefined) {
    d.c = String(run.color);
    s.style.color = toCss(run.color);
  }
  if (run.size !== undefined) {
    d.size = String(run.size);
    s.style.fontSize = scaled(run.size);
  }
  if (run.font !== undefined) {
    d.font = run.font;
    s.style.fontFamily = familyFor(run.font, baseFamily);
  }
  if (run.link !== undefined) {
    d.href = run.link;
    s.title = `${run.link}\n${openLinkHint}`;
  }
  s.textContent = run.text;
  return s;
}

const isBlock = (node: Node, root: HTMLElement): node is HTMLElement =>
  node !== root &&
  node instanceof HTMLElement &&
  (node.tagName === 'DIV' || node.tagName === 'P' || node.tagName === 'LI');

/** Whether a node shows anything: text, a line break, an image… (not empty wrappers). */
function hasContent(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '') !== '';
  if (!(node instanceof HTMLElement)) return false;
  if (node.tagName === 'BR') return !node.dataset.sentinel;
  for (const c of node.childNodes) if (hasContent(c)) return true;
  return false;
}

/**
 * A `<br>` with nothing after it in its paragraph only gives an empty line its height
 * (browsers add one after deleting or merging lines): it is not a line break. Like in HTML
 * rendering, where such a trailing `<br>` adds no line.
 */
function isFillerBreak(br: HTMLElement, root: HTMLElement): boolean {
  if (br.dataset.sentinel) return true;
  for (let n: Node = br; n !== root && !isBlock(n, root); n = n.parentNode!) {
    for (let s = n.nextSibling; s; s = s.nextSibling) {
      if (isBlock(s, root)) return true; // the next paragraph ends this line anyway
      if (hasContent(s)) return false;
    }
    if (!n.parentNode) break;
  }
  return true;
}

function blockStyle(el: HTMLElement): ParagraphStyle {
  const list = el.dataset.list;
  if (list !== 'bullet' && list !== 'ordered') return {};
  const indent = Number(el.dataset.indent ?? 0);
  return indent > 0 ? { list, indent } : { list };
}

/**
 * Text and paragraph styles of the editor DOM, read the same way it is rendered. A new
 * line inside a list item (pasted text, a `<br>`) continues that list.
 */
export function parse(root: HTMLElement): { runs: TextRun[]; paragraphs?: ParagraphStyle[] } {
  const runs: TextRun[] = [];
  const paras: ParagraphStyle[] = [{}];
  let any = false;
  const newline = (style: ParagraphStyle) => {
    runs.push({ text: '\n' });
    paras.push(style);
    any = true;
  };
  const walk = (node: Node, style: TextStyle, para: ParagraphStyle) => {
    if (node.nodeType === Node.TEXT_NODE) {
      (node.textContent ?? '').split('\n').forEach((text, i) => {
        if (i > 0) newline(para);
        if (text) runs.push({ ...style, text });
      });
      any = true;
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.tagName === 'BR') {
      if (!isFillerBreak(node, root)) newline(para);
      return;
    }
    let next = para;
    if (isBlock(node, root)) {
      // Each block is a paragraph: the first one styles paragraph 0, the rest start new ones.
      next = blockStyle(node);
      if (any) newline(next);
      else paras[0] = next;
      any = true;
    }
    const d = node.dataset;
    const s: TextStyle = { ...style };
    if (d.b) s.bold = true;
    if (d.i) s.italic = true;
    if (d.u) s.underline = true;
    if (d.s) s.strike = true;
    if (d.c) s.color = Number(d.c);
    if (d.size && Number(d.size) > 0) s.size = Number(d.size);
    if (d.font) s.font = d.font;
    if (d.href) s.link = d.href;
    for (const child of node.childNodes) walk(child, s, next);
  };
  walk(root, {}, {});
  const normalized = normalizeRuns(runs);
  const paragraphs = normalizeParagraphs(paras, paragraphCount(normalized));
  return paragraphs ? { runs: normalized, paragraphs } : { runs: normalized };
}

/** Plain-text offset of a DOM position inside `root` (same counting as `parse`). */
export function offsetOf(root: HTMLElement, target: Node, targetOffset: number): number {
  let count = 0;
  let found = -1;
  let any = false;
  const walk = (node: Node): boolean => {
    if (isBlock(node, root)) {
      if (any) count += 1;
      any = true;
    }
    if (node === target && node.nodeType !== Node.TEXT_NODE) {
      // Offset counts child nodes.
      for (let i = 0; i < targetOffset && i < node.childNodes.length; i++)
        walk(node.childNodes[i]!);
      found = count;
      return true;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      any = true;
      if (node === target) {
        found = count + targetOffset;
        return true;
      }
      count += node.textContent?.length ?? 0;
      return false;
    }
    if (node instanceof HTMLElement && node.tagName === 'BR') {
      if (!isFillerBreak(node, root)) {
        count += 1;
        any = true;
      }
      return false;
    }
    for (const child of node.childNodes) if (walk(child)) return true;
    return false;
  };
  walk(root);
  return found < 0 ? count : found;
}

/** DOM position for a plain-text offset in a canonical (rendered) editor. */
export function positionOf(root: HTMLElement, offset: number): { node: Node; offset: number } {
  let remaining = offset;
  const blocks = [...root.children].filter((c) => (c as HTMLElement).dataset.p);
  for (const div of blocks) {
    const texts: Node[] = [];
    for (const s of div.children)
      if (s.firstChild?.nodeType === Node.TEXT_NODE) texts.push(s.firstChild);
    const len = texts.reduce((n, t) => n + (t.textContent?.length ?? 0), 0);
    if (remaining <= len) {
      for (const t of texts) {
        const l = t.textContent?.length ?? 0;
        if (remaining <= l) return { node: t, offset: remaining };
        remaining -= l;
      }
      return { node: div, offset: 0 }; // empty paragraph: before its <br>
    }
    remaining -= len + 1;
  }
  // Not canonical (e.g. mid-edit): fall back to the end.
  const last = blocks[blocks.length - 1];
  return last ? { node: last, offset: last.childNodes.length } : { node: root, offset: 0 };
}
