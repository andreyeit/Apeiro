import {
  MAX_LIST_INDENT,
  paragraphAt,
  paragraphCount,
  type ParagraphStyle,
  type TextBlock,
  type TextRun,
} from './text-block';

/** Style attributes of a run (everything except the text). */
export type TextStyle = Omit<TextRun, 'text'>;
export type StyleKey = keyof TextStyle;

const STYLE_KEYS: StyleKey[] = [
  'bold',
  'italic',
  'underline',
  'strike',
  'color',
  'size',
  'font',
  'link',
];
/** On/off attributes, toggled by B/I/U/S. */
export type BooleanStyle = 'bold' | 'italic' | 'underline' | 'strike';

function styleOf(run: TextRun): TextStyle {
  const s: TextStyle = {};
  for (const k of STYLE_KEYS) {
    const v = run[k];
    if (v !== undefined && v !== false) (s as Record<string, unknown>)[k] = v;
  }
  return s;
}

export function sameStyle(a: TextStyle, b: TextStyle): boolean {
  for (const k of STYLE_KEYS) {
    const va = a[k] === false ? undefined : a[k];
    const vb = b[k] === false ? undefined : b[k];
    if (va !== vb) return false;
  }
  return true;
}

export const runsLength = (runs: readonly TextRun[]): number =>
  runs.reduce((n, r) => n + r.text.length, 0);

/** Drops empty runs and merges neighbours with equal style. Always returns at least one run. */
export function normalizeRuns(runs: readonly TextRun[]): TextRun[] {
  const out: TextRun[] = [];
  for (const run of runs) {
    if (run.text.length === 0) continue;
    const prev = out[out.length - 1];
    if (prev && sameStyle(prev, run)) prev.text += run.text;
    else out.push({ ...styleOf(run), text: run.text });
  }
  if (out.length === 0) out.push({ ...(runs[0] ? styleOf(runs[0]) : {}), text: '' });
  return out;
}

/**
 * Applies `patch` to the range [from, to) (UTF-16 offsets, same as DOM selections).
 * `undefined`/`false` values remove the attribute.
 */
export function applyStyle(
  runs: readonly TextRun[],
  from: number,
  to: number,
  patch: TextStyle,
): TextRun[] {
  if (to <= from) return normalizeRuns(runs);
  const out: TextRun[] = [];
  let pos = 0;
  for (const run of runs) {
    const start = pos;
    const end = pos + run.text.length;
    pos = end;
    const a = Math.max(from, start);
    const b = Math.min(to, end);
    if (a >= b) {
      out.push({ ...run });
      continue;
    }
    if (a > start) out.push({ ...run, text: run.text.slice(0, a - start) });
    const styled: TextRun = { ...run, text: run.text.slice(a - start, b - start) };
    for (const k of Object.keys(patch) as StyleKey[]) {
      const v = patch[k];
      if (v === undefined || v === false) delete styled[k];
      else (styled as unknown as Record<string, unknown>)[k] = v;
    }
    out.push(styled);
    if (b < end) out.push({ ...run, text: run.text.slice(b - start) });
  }
  return normalizeRuns(out);
}

/**
 * Whether a boolean attribute is set on every character of [from, to).
 * For a collapsed range it reports the style of the character before the caret.
 */
export function hasStyle(
  runs: readonly TextRun[],
  from: number,
  to: number,
  key: BooleanStyle,
): boolean {
  if (to <= from) {
    let pos = 0;
    let found: TextRun | undefined = runs[0];
    for (const run of runs) {
      if (pos < from) found = run;
      pos += run.text.length;
    }
    return !!found?.[key];
  }
  let pos = 0;
  let any = false;
  for (const run of runs) {
    const start = pos;
    pos += run.text.length;
    if (pos <= from || start >= to || run.text.length === 0) continue;
    any = true;
    if (!run[key]) return false;
  }
  return any;
}

/** Toggles a boolean attribute over a range: on if any character lacks it, otherwise off. */
export function toggleStyle(
  runs: readonly TextRun[],
  from: number,
  to: number,
  key: BooleanStyle,
): TextRun[] {
  return applyStyle(runs, from, to, { [key]: !hasStyle(runs, from, to, key) });
}

/** `commonStyle` result when a range mixes several values. */
export const MIXED = Symbol('mixed');

/**
 * The value of an attribute shared by every character of [from, to), `MIXED` if they
 * differ. For a collapsed range: the value at the character before the caret.
 */
export function commonStyle<K extends StyleKey>(
  runs: readonly TextRun[],
  from: number,
  to: number,
  key: K,
): TextRun[K] | typeof MIXED {
  if (to <= from) {
    let pos = 0;
    let found: TextRun | undefined = runs[0];
    for (const run of runs) {
      if (pos < from) found = run;
      pos += run.text.length;
    }
    return found?.[key];
  }
  let pos = 0;
  let seen = false;
  let value: TextRun[K] | undefined;
  for (const run of runs) {
    const start = pos;
    pos += run.text.length;
    if (pos <= from || start >= to || run.text.length === 0) continue;
    if (!seen) {
      seen = true;
      value = run[key];
    } else if (run[key] !== value) return MIXED;
  }
  return value;
}

/** The whole link around an offset: [from, to) and its target, or null outside links. */
export function linkAt(
  runs: readonly TextRun[],
  offset: number,
): { from: number; to: number; href: string } | null {
  let pos = 0;
  const spans: Array<{ from: number; to: number; href: string | undefined }> = [];
  for (const run of runs) {
    spans.push({ from: pos, to: pos + run.text.length, href: run.link });
    pos += run.text.length;
  }
  // Inside a link, or right after its last character (caret at its end).
  const i = spans.findIndex((s) => s.href && offset > s.from && offset <= s.to);
  if (i < 0) return null;
  const href = spans[i]!.href!;
  let a = i;
  let b = i;
  while (a > 0 && spans[a - 1]!.href === href) a--;
  while (b + 1 < spans.length && spans[b + 1]!.href === href) b++;
  return { from: spans[a]!.from, to: spans[b]!.to, href };
}

const LINK_SCHEMES = /^(https?:|mailto:)/i;

/** True for link targets text may carry: http(s) and mailto only (no `javascript:` etc.). */
export function isAllowedLink(href: string): boolean {
  if (!LINK_SCHEMES.test(href.trim())) return false;
  try {
    const url = new URL(href.trim());
    return ['http:', 'https:', 'mailto:'].includes(url.protocol);
  } catch {
    return false;
  }
}

/**
 * Turns what a user typed into a link target: adds `https://` to bare domains and
 * `mailto:` to e-mail addresses. Null if it isn't a usable link.
 */
export function normalizeLink(input: string): string | null {
  const s = input.trim();
  if (s === '' || /\s/.test(s)) return null;
  let href = s;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    if (/^[^@/]+@[^@/]+\.[^@/]+$/.test(s)) href = `mailto:${s}`;
    else if (/^[^/]+\.[a-z]{2,}([/?#:].*)?$/i.test(s) || s.startsWith('//'))
      href = `https://${s.replace(/^\/\//, '')}`;
    else return null;
  }
  return isAllowedLink(href) ? href : null;
}

// --- Paragraphs (lists) ------------------------------------------------------

const isPlain = (p: ParagraphStyle | undefined) => !p || (!p.list && !p.indent);

/** Paragraph styles trimmed to `count` paragraphs; undefined when all are plain. */
export function normalizeParagraphs(
  paragraphs: ReadonlyArray<ParagraphStyle | undefined> | undefined,
  count: number,
): ParagraphStyle[] | undefined {
  if (!paragraphs) return undefined;
  const out: ParagraphStyle[] = [];
  for (let i = 0; i < count; i++) {
    const p = paragraphs[i];
    if (isPlain(p) || !p!.list) out.push({});
    else {
      const indent = Math.max(0, Math.min(MAX_LIST_INDENT, Math.floor(p!.indent ?? 0)));
      out.push(indent > 0 ? { list: p!.list, indent } : { list: p!.list });
    }
  }
  while (out.length > 0 && isPlain(out[out.length - 1])) out.pop();
  return out.length > 0 ? out : undefined;
}

/**
 * Paragraph styles after the text [from, to) of `runs` is replaced by `inserted`:
 * paragraphs the removed text joined keep the first one's style (like Backspace at the
 * start of a line in a word processor), new line breaks continue the paragraph's style
 * (Enter in a list makes another item).
 */
export function remapParagraphs(
  runs: readonly TextRun[],
  paragraphs: readonly ParagraphStyle[] | undefined,
  from: number,
  to: number,
  inserted: string,
): ParagraphStyle[] | undefined {
  if (!paragraphs) return undefined;
  const first = paragraphAt(runs, from);
  const removed = paragraphAt(runs, to) - first;
  const added = paragraphCount([{ text: inserted }]) - 1;
  const style = paragraphs[first] ?? {};
  const out = [
    ...Array.from({ length: first }, (_, i) => paragraphs[i] ?? {}),
    ...Array.from({ length: added + 1 }, () => ({ ...style })),
    ...paragraphs.slice(first + removed + 1),
  ];
  return normalizeParagraphs(out, paragraphCount(runs) - removed + added);
}

/** Paragraph indices [first, last] touched by the range [from, to]. */
export function paragraphRange(
  runs: readonly TextRun[],
  from: number,
  to: number,
): [number, number] {
  return [paragraphAt(runs, from), paragraphAt(runs, to)];
}

/** Applies `change` to the styles of paragraphs first..last (inclusive). */
export function updateParagraphs(
  block: TextBlock,
  first: number,
  last: number,
  change: (style: ParagraphStyle, index: number) => ParagraphStyle,
): TextBlock {
  const count = paragraphCount(block.runs);
  const out: ParagraphStyle[] = [];
  for (let i = 0; i < count; i++) {
    const style = block.paragraphs?.[i] ?? {};
    out.push(i >= first && i <= last ? change(style, i) : style);
  }
  const paragraphs = normalizeParagraphs(out, count);
  const next: TextBlock = { ...block, paragraphs };
  if (!paragraphs) delete next.paragraphs;
  return next;
}

/**
 * Toggles a list on paragraphs first..last: if all of them already are this kind of list,
 * they become plain text; otherwise they all become this kind (keeping their levels).
 */
export function toggleList(
  block: TextBlock,
  first: number,
  last: number,
  kind: 'bullet' | 'ordered',
): TextBlock {
  let all = true;
  for (let i = first; i <= last; i++) if (block.paragraphs?.[i]?.list !== kind) all = false;
  return updateParagraphs(block, first, last, (s) => (all ? {} : { ...s, list: kind }));
}

/** Moves list items first..last one level deeper (+1) or shallower (-1). */
export function indentList(block: TextBlock, first: number, last: number, dir: 1 | -1): TextBlock {
  return updateParagraphs(block, first, last, (s) =>
    s.list ? { ...s, indent: Math.max(0, Math.min(MAX_LIST_INDENT, (s.indent ?? 0) + dir)) } : s,
  );
}
