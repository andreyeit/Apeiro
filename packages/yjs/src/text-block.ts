import { normalizeRuns, type TextBlock, type TextRun } from '@apeiro/core';
import * as Y from 'yjs';

/**
 * Rich text of an element in a Y.Doc: a Y.Map with the block's settings (font size,
 * alignment, paragraphs…) as plain values and its characters in a Y.Text under `runs`,
 * where run styles are Y.Text formatting attributes. Two people typing in the same text
 * merge character by character; settings are last-writer-wins per key.
 */

/** Key of the Y.Text with the characters inside the text map. */
export const RUNS_KEY = 'runs';

/** Per-character attributes, as stored on the Y.Text. */
const STYLE_KEYS = [
  'bold',
  'italic',
  'underline',
  'strike',
  'color',
  'size',
  'font',
  'link',
] as const;
type StyleKey = (typeof STYLE_KEYS)[number];
type Attrs = Partial<Record<StyleKey, unknown>>;

function attrsOf(run: TextRun): Attrs {
  const a: Attrs = {};
  for (const k of STYLE_KEYS) {
    const v = run[k];
    if (v !== undefined && v !== false && v !== null) a[k] = v;
  }
  return a;
}

function sameAttrs(a: Attrs, b: Attrs): boolean {
  for (const k of STYLE_KEYS) if (a[k] !== b[k]) return false;
  return true;
}

/** Runs of a Y.Text (embeds, which the board never writes, are skipped). */
export function runsFromYText(text: Y.Text): TextRun[] {
  const runs: TextRun[] = [];
  for (const op of text.toDelta() as Array<{
    insert?: unknown;
    attributes?: Record<string, unknown>;
  }>) {
    if (typeof op.insert !== 'string') continue;
    const run: TextRun = { text: op.insert };
    const attrs = op.attributes;
    if (attrs) {
      for (const k of STYLE_KEYS) {
        const v = attrs[k];
        if (v === undefined || v === null) continue;
        if (k === 'color' || k === 'size') {
          if (typeof v === 'number' && Number.isFinite(v)) run[k] = v;
        } else if (k === 'font' || k === 'link') {
          if (typeof v === 'string') run[k] = v;
        } else if (v === true) run[k] = true;
      }
    }
    runs.push(run);
  }
  return normalizeRuns(runs);
}

/** The text block stored in `map`. */
export function textBlockFromYMap(map: Y.Map<unknown>): TextBlock {
  const block: Record<string, unknown> = {};
  for (const [k, v] of map.entries()) {
    if (k === RUNS_KEY) continue;
    block[k] = v;
  }
  const runs = map.get(RUNS_KEY);
  block.runs = runs instanceof Y.Text ? runsFromYText(runs) : [{ text: '' }];
  return block as unknown as TextBlock;
}

/** Writes a new text block into an empty, already integrated map. */
export function writeTextBlock(map: Y.Map<unknown>, block: TextBlock): void {
  for (const [k, v] of Object.entries(block)) {
    if (k === RUNS_KEY || v === undefined) continue;
    map.set(k, v);
  }
  const text = new Y.Text();
  map.set(RUNS_KEY, text);
  let at = 0;
  for (const run of block.runs) {
    if (run.text.length === 0) continue;
    text.insert(at, run.text, attrsOf(run));
    at += run.text.length;
  }
}

const sameValue = (a: unknown, b: unknown): boolean =>
  a === b ||
  (typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));

/**
 * Updates `map` to hold `block` with the smallest change: settings that differ are set,
 * and the characters are diffed against the Y.Text (common prefix and suffix kept, the
 * middle replaced, formatting changes applied as `format`), so concurrent typing elsewhere
 * in the same text survives.
 */
export function updateTextBlock(map: Y.Map<unknown>, block: TextBlock): void {
  const seen = new Set<string>([RUNS_KEY]);
  for (const [k, v] of Object.entries(block)) {
    if (k === RUNS_KEY) continue;
    seen.add(k);
    if (v === undefined) {
      if (map.has(k)) map.delete(k);
    } else if (!sameValue(map.get(k), v)) map.set(k, v);
  }
  for (const k of [...map.keys()]) if (!seen.has(k)) map.delete(k);

  let text = map.get(RUNS_KEY);
  if (!(text instanceof Y.Text)) {
    text = new Y.Text();
    map.set(RUNS_KEY, text);
  }
  diffIntoYText(text as Y.Text, block.runs);
}

/** Attributes of every UTF-16 code unit of `runs`. */
function charAttrs(runs: readonly TextRun[]): Attrs[] {
  const out: Attrs[] = [];
  for (const run of runs) {
    const a = attrsOf(run);
    for (let i = 0; i < run.text.length; i++) out.push(a);
  }
  return out;
}

/** Applies the difference between the Y.Text's content and `runs` to the Y.Text. */
export function diffIntoYText(text: Y.Text, runs: readonly TextRun[]): void {
  const oldRuns = runsFromYText(text);
  const oldS = oldRuns.map((r) => r.text).join('');
  const newS = runs.map((r) => r.text).join('');
  const oldA = charAttrs(oldRuns);
  const newA = charAttrs(runs);

  let prefix = 0;
  const max = Math.min(oldS.length, newS.length);
  while (prefix < max && oldS.charCodeAt(prefix) === newS.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    oldS.charCodeAt(oldS.length - 1 - suffix) === newS.charCodeAt(newS.length - 1 - suffix)
  )
    suffix++;
  // Never split a surrogate pair between the kept and the replaced part.
  const isLow = (s: string, i: number) => {
    const c = s.charCodeAt(i);
    return c >= 0xdc00 && c <= 0xdfff;
  };
  while (prefix > 0 && (isLow(oldS, prefix) || isLow(newS, prefix))) prefix--;
  while (suffix > 0 && (isLow(oldS, oldS.length - suffix) || isLow(newS, newS.length - suffix)))
    suffix--;

  // Formatting changes in the kept prefix and suffix (positions are the same in both).
  const formatRange = (from: number, to: number, delta: number) => {
    let i = from;
    while (i < to) {
      const want = newA[i]!;
      if (sameAttrs(oldA[i - delta]!, want)) {
        i++;
        continue;
      }
      let j = i + 1;
      while (j < to && newA[j] === want && !sameAttrs(oldA[j - delta]!, want)) j++;
      const patch: Record<string, unknown> = {};
      for (const k of STYLE_KEYS) patch[k] = want[k] ?? null;
      text.format(i, j - i, patch);
      i = j;
    }
  };

  const oldMid = oldS.length - prefix - suffix;
  const newMid = newS.length - prefix - suffix;
  if (oldMid > 0) text.delete(prefix, oldMid);
  // The inserted middle, run by run with its own attributes.
  let at = prefix;
  let i = prefix;
  while (i < prefix + newMid) {
    const a = newA[i]!;
    let j = i + 1;
    while (j < prefix + newMid && newA[j] === a) j++;
    // Explicit nulls: the inserted text must not inherit the neighbour's formatting.
    const attrs: Record<string, unknown> = {};
    for (const k of STYLE_KEYS) attrs[k] = a[k] ?? null;
    text.insert(at, newS.slice(i, j), attrs);
    at += j - i;
    i = j;
  }
  formatRange(0, prefix, 0);
  formatRange(newS.length - suffix, newS.length, newS.length - oldS.length);
}
