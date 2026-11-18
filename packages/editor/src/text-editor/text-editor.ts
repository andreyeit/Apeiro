import {
  LINE_HEIGHT,
  fontFamily,
  fontIndex,
  LIST_GAP_EM,
  MIXED,
  applyStyle,
  clampFontSize,
  commonStyle,
  defaultTextBlock,
  fitTextPatch,
  hasStyle,
  indentList,
  isAllowedLink,
  isShape,
  linkAt,
  normalizeLink,
  normalizeRuns,
  paragraphAt,
  paragraphRange,
  paragraphStyle,
  plainText,
  remapParagraphs,
  runsLength,
  stepFontSize,
  textArea,
  toggleList,
  toggleStyle,
  updateParagraphs,
  type BoardElement,
  type BooleanStyle,
  type Camera,
  type History,
  type ListKind,
  type ParagraphStyle,
  type Scene,
  type ShapeElement,
  type TextBlock,
  type TextRun,
  type TextStyle,
} from '@apeiro/core';
import type { BoardRenderer } from '@apeiro/renderer';
import { offsetOf, parse, positionOf, render, toCss } from './dom';
import { TextToolbar } from './toolbar';
import { EN_LABELS, type BoardLabels } from '../ui/labels';

const JUSTIFY = { top: 'flex-start', middle: 'center', bottom: 'flex-end' } as const;

/** Text and selection to return to on undo/redo. */
interface Snapshot {
  block: TextBlock;
  from: number;
  to: number;
}
const MAX_UNDO = 200;

/** Typed at the start of a line, these turn it into a list item (like Notion and Miro). */
const LIST_SHORTCUTS: Array<[RegExp, ListKind]> = [
  [/^[-*•] $/, 'bullet'],
  [/^1[.)] $/, 'ordered'],
];

/**
 * Maps offsets in `before` to offsets in `after`, assuming one contiguous change between
 * them (what one remote edit looks like): offsets before the change stay, offsets after it
 * shift by the change in length, offsets inside it move to the end of the new text.
 */
export function offsetMapper(before: string, after: string): (offset: number) => number {
  const max = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < max && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  )
    suffix++;
  const oldEnd = before.length - suffix;
  const newEnd = after.length - suffix;
  return (offset) => {
    if (offset <= prefix) return offset;
    if (offset >= oldEnd) return offset + after.length - before.length;
    return newEnd;
  };
}

/** Opens a link from text in a new tab, never giving the page a handle on the opener. */
export function openLink(href: string): void {
  if (isAllowedLink(href)) window.open(href, '_blank', 'noopener,noreferrer');
}

/** Replaces [from, to) of `runs` with `text`, styled like the run it lands in plus `style`. */
function replaceRuns(
  runs: readonly TextRun[],
  from: number,
  to: number,
  text: string,
  style: TextStyle | null,
): TextRun[] {
  const out: TextRun[] = [];
  let pos = 0;
  let inserted = false;
  for (const run of runs) {
    const start = pos;
    const end = pos + run.text.length;
    pos = end;
    if (end <= from || start >= to) {
      out.push(run);
      if (!inserted && end === from) {
        out.push({ ...run, ...style, text });
        inserted = true;
      }
      continue;
    }
    out.push({ ...run, text: run.text.slice(0, Math.max(0, from - start)) });
    if (!inserted) {
      out.push({ ...run, ...style, text });
      inserted = true;
    }
    out.push({ ...run, text: run.text.slice(Math.max(0, to - start)) });
  }
  if (!inserted) out.unshift({ ...style, text });
  return normalizeRuns(out);
}

/**
 * Rich text editor laid exactly over an element. Every change is written to the scene,
 * so other views (and later other users) see it live. The board keeps drawing the text
 * while it is edited (same weight, colors and layout as before editing): the editor's
 * own text is transparent, only its caret and selection show. Only an IME composition,
 * which isn't in the scene yet, is shown by the editor (the board text is hidden then).
 *
 * Per-character: bold/italic/underline/strike (Ctrl+B/I/U, Ctrl+Shift+X), color, font
 * family, size and links (Ctrl+K). Per paragraph: bulleted and numbered lists
 * (Ctrl+Shift+8/7, or "- " / "1. " at the start of a line), nested with Tab / Shift+Tab.
 * Size and font apply to the selection, or to the whole text when nothing is selected.
 * With a collapsed caret, a toggled style applies to what is typed next.
 */
export class TextEditor {
  private root = document.createElement('div');
  private input = document.createElement('div');
  private readonly bar: TextToolbar;
  /** Range the open link field applies to (a collapsed one inserts the link as text). */
  private linkRange: [number, number] | null = null;
  /** Last caret/selection inside the text, to restore after a toolbar field took focus. */
  private lastSelection: [number, number] | null = null;
  /** Called when editing ends, with the element id (null if it was removed for being empty). */
  /** Called when editing of element `id` begins (e.g. to hide the selection handles). */
  onStart: (id: string) => void = () => undefined;
  onStop: (id: string | null) => void = () => undefined;
  private id: string | null = null;
  private block: TextBlock | null = null;
  private pending: TextStyle | null = null;
  private inputStart = 0;
  private composing = false;
  /**
   * Undo/redo of this editing session. The DOM is re-rendered on every change, so the
   * browser's own undo stack is useless here; Ctrl+Z goes through these instead.
   */
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private lastTypingAt = 0;
  /** Selection when the current input began (before the browser changed the DOM). */
  private beforeSelection: [number, number] = [0, 0];
  private disposers: Array<() => void> = [];

  constructor(
    container: HTMLElement,
    private scene: Scene,
    private camera: Camera,
    private renderer: BoardRenderer,
    /**
     * Board undo history: one editing session (open → close) becomes one step there.
     * Inside the session Ctrl+Z is handled by the editor's own finer-grained undo.
     */
    private history?: Pick<History, 'beginGroup' | 'endGroup'>,
    /** Texts of the formatting toolbar (default English). */
    private readonly labels: BoardLabels = EN_LABELS,
  ) {
    this.root.className = 'ap-text-editor';
    this.input.className = 'ap-text-editor-input';
    try {
      this.input.contentEditable = 'plaintext-only';
    } catch {
      this.input.contentEditable = 'true';
    }
    this.input.spellcheck = false;
    this.root.append(this.input);
    this.root.hidden = true;
    this.bar = new TextToolbar(labels, {
      setFont: (id) => this.setFont(id),
      stepSize: (dir) => this.stepSize(dir),
      setFontSize: (size) => this.setFontSize(size),
      toggle: (key) => this.toggle(key),
      openLinkBar: () => this.openLinkBar(),
      applyLink: () => this.applyLink(),
      closeLinkBar: () => this.closeLinkBar(),
      toggleList: (kind) => this.toggleListAtSelection(kind),
      setAlign: (align) => this.setBlock({ align }),
      setColor: (color) => this.setColor(color),
      refocus: () => this.refocus(),
    });
    container.append(this.root, this.toolbar);

    this.input.addEventListener('beforeinput', (e) => this.onBeforeInput(e));
    this.input.addEventListener('input', () => this.onInput());
    this.input.addEventListener('compositionstart', () => {
      this.composing = true;
      this.setComposing(true);
    });
    this.input.addEventListener('compositionend', () => {
      this.composing = false;
      this.onInput();
      this.setComposing(false);
    });
    this.input.addEventListener('blur', (e) => {
      if (!this.toolbar.contains(e.relatedTarget as Node | null)) this.stop();
    });
    this.input.addEventListener('keydown', (e) => this.onKeyDown(e));
    // Ctrl/Cmd+click opens a link (a plain click places the caret, as in any editor).
    this.input.addEventListener('click', (e) => {
      const href = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-href]')?.dataset
        .href;
      if (href && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        openLink(href);
      }
    });
    const onSelectionChange = () => {
      const sel = getSelection();
      if (this.id && sel && sel.rangeCount > 0 && this.input.contains(sel.anchorNode))
        this.lastSelection = this.selection();
      this.syncToolbar();
    };
    document.addEventListener('selectionchange', onSelectionChange);
    // A press anywhere else closes the editor before the board handles it (capture phase,
    // ahead of blur), so the text edit and the next gesture are separate undo steps.
    const onOutsidePointer = (e: Event) => {
      const t = e.target as Node | null;
      if (this.id && !this.root.contains(t) && !this.toolbar.contains(t)) this.stop();
    };
    window.addEventListener('pointerdown', onOutsidePointer, true);
    this.disposers.push(() => window.removeEventListener('pointerdown', onOutsidePointer, true));
    for (const el of [this.root, this.toolbar])
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.disposers.push(
      () => document.removeEventListener('selectionchange', onSelectionChange),
      renderer.onAfterRender(() => this.sync()),
      scene.subscribe((c) => this.onSceneChanges(c.updated)),
    );
  }

  /** Removes the editor from the page and stops listening to the document and the scene. */
  destroy(): void {
    this.stop();
    for (const d of this.disposers) d();
    this.disposers = [];
    this.root.remove();
    this.toolbar.remove();
  }

  /**
   * The edited element's text changed from elsewhere (another view, later another user):
   * show that instead of overwriting it with the next keystroke.
   */
  private onSceneChanges(updated: readonly BoardElement[]): void {
    if (!this.id || !this.block || this.composing) return;
    const el = updated.find((e) => e.id === this.id);
    if (!el || !isShape(el) || !el.text || el.text === this.block) return;
    const [from, to] = this.selection();
    // Someone else typed: keep the caret on the same characters, not the same offset.
    const map = offsetMapper(plainText(this.block), plainText(el.text));
    this.block = el.text;
    this.undoStack = [];
    this.redoStack = [];
    render(this.input, this.block, this.labels.openLinkHint);
    const length = runsLength(this.block.runs);
    this.select(Math.min(map(from), length), Math.min(map(to), length));
    this.syncToolbar();
    this.sync();
  }

  get editing(): string | null {
    return this.id;
  }

  /**
   * Adds a new element and opens it for typing, as one undo step with the typing: closing
   * it while still empty removes it again, leaving no trace in the history (Figma, Miro).
   */
  create(el: ShapeElement): void {
    this.stop();
    this.history?.beginGroup();
    try {
      this.scene.add(el);
      this.start(el.id);
    } finally {
      this.history?.endGroup(); // the step stays open until `stop` (start nests a group)
    }
  }

  start(id: string): void {
    const el = this.scene.get(id);
    if (!el || !isShape(el)) return;
    this.stop();
    this.history?.beginGroup();
    this.id = id;
    const block = el.text ?? defaultTextBlock(el.type);
    // The editor only writes '\n' line breaks; '\r\n' from elsewhere becomes one.
    this.block = block.runs.some((r) => r.text.includes('\r'))
      ? {
          ...block,
          runs: block.runs.map((r) => ({ ...r, text: r.text.replace(/\r\n?/g, '\n') })),
        }
      : block;
    this.lastSelection = null;
    this.pending = null;
    this.undoStack = [];
    this.redoStack = [];
    this.lastTypingAt = 0;
    this.closeLinkBar();
    render(this.input, this.block, this.labels.openLinkHint);
    this.setComposing(false);
    this.root.hidden = false;
    this.toolbar.hidden = false;
    this.sync();
    this.input.focus();
    const end = runsLength(this.block.runs);
    this.select(end, end);
    this.syncToolbar();
    this.onStart(id);
  }

  stop(): void {
    if (!this.id) return;
    const id = this.id;
    this.renderer.setTextHidden(id, false);
    this.id = null;
    // A hidden editor must not keep the focus: keys would go to it, not to the board.
    if (this.input.contains(document.activeElement)) this.input.blur();
    this.block = null;
    this.root.hidden = true;
    this.toolbar.hidden = true;
    this.closeLinkBar();
    // An empty text box has nothing to show: it goes away (shapes keep their box).
    const el = this.scene.get(id);
    const removed = !!el && el.type === 'text' && (!el.text || plainText(el.text) === '');
    if (removed) this.scene.remove(id);
    this.history?.endGroup();
    this.onStop(removed || !el ? null : id);
  }

  /**
   * IME composition: its text isn't in the scene until it ends, so the editor shows its
   * own text then (and the board's is hidden). Otherwise the board draws the text.
   */
  private setComposing(on: boolean): void {
    this.input.classList.toggle('composing', on);
    if (this.id) this.renderer.setTextHidden(this.id, on);
  }

  /** Positions the editor over the element; called after every frame. */
  sync(): void {
    if (!this.id || !this.block) return;
    const el = this.scene.get(this.id);
    if (!el || !isShape(el)) {
      this.stop();
      return;
    }
    const zoom = this.camera.zoom;
    const center = this.camera.worldToScreen({ x: el.x + el.w / 2, y: el.y + el.h / 2 });
    const area = textArea(el);
    const layout = this.renderer.textLayout(el);
    const k = layout?.scale ?? 1;
    const s = this.root.style;
    s.width = `${el.w}px`;
    s.height = `${el.h}px`;
    s.transform = `translate(${center.x}px, ${center.y}px) scale(${zoom}) rotate(${el.rotation}rad) translate(-50%, -50%)`;
    s.padding = `${area.minY}px ${el.w - area.maxX}px ${el.h - area.maxY}px ${area.minX}px`;
    s.justifyContent = JUSTIFY[this.block.verticalAlign];
    const i = this.input.style;
    i.fontFamily = fontFamily(this.block.font).css;
    i.fontSize = `${this.block.fontSize * k}px`;
    i.setProperty('--k', String(k));
    i.setProperty('--gap', `${LIST_GAP_EM * this.block.fontSize * k}px`);
    i.lineHeight = String(LINE_HEIGHT);
    i.textAlign = this.block.align;
    // As drawn on the board: a dark theme may show the stored color differently. The text
    // itself is transparent (the board draws it); the caret takes the text's color.
    i.color = toCss(this.renderer.drawnColor(el.type, this.block.color));
    i.caretColor = i.color;
    // Auto-width text never wraps; the box grows with it instead.
    i.whiteSpace = el.type === 'text' && this.block.sizing === 'auto-width' ? 'pre' : '';
    if (document.activeElement !== this.bar.sizeInput) {
      const size = this.sizeAtSelection();
      this.bar.sizeInput.value = size === null ? '' : String(Math.round(size * k * 10) / 10);
    }

    // Toolbar sits above the element's screen bounding box, unscaled.
    const b = this.scene.getBounds(this.id);
    if (b) {
      const top = this.camera.worldToScreen({ x: (b.minX + b.maxX) / 2, y: b.minY });
      const bottom = this.camera.worldToScreen({ x: 0, y: b.maxY }).y;
      // Kept on screen: pushed in from the sides, and under the element if there is no
      // room above it.
      const tw = this.toolbar.offsetWidth;
      const th = this.toolbar.offsetHeight;
      const vw = this.camera.viewportWidth;
      const margin = 8;
      const x = Math.max(margin, Math.min(top.x - tw / 2, vw - tw - margin));
      const y = top.y - 12 - th >= margin ? top.y - 12 - th : bottom + 12;
      this.toolbar.style.transform = `translate(${x}px, ${y}px)`;
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    e.stopPropagation(); // board shortcuts (Delete, Ctrl+A) must not fire while typing
    if (e.key === 'Escape') {
      this.input.blur();
      return;
    }
    if (e.key === 'Tab') {
      // Nest list items; elsewhere Tab must not move focus out of the text.
      e.preventDefault();
      this.indentAtSelection(e.shiftKey ? -1 : 1);
      return;
    }
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.shiftKey && (e.code === 'Period' || e.code === 'Comma')) {
      e.preventDefault();
      this.stepSize(e.code === 'Period' ? 1 : -1);
      return;
    }
    if (e.shiftKey && (e.code === 'Digit7' || e.code === 'Digit8')) {
      e.preventDefault();
      this.toggleListAtSelection(e.code === 'Digit7' ? 'ordered' : 'bullet');
      return;
    }
    if (!e.shiftKey && !e.altKey && e.code === 'KeyK') {
      e.preventDefault();
      this.openLinkBar();
      return;
    }
    const key = e.key.toLowerCase();
    if (key === 'z' || key === 'y' || key === 'я' || key === 'н') {
      e.preventDefault();
      const redo = key === 'y' || key === 'н' || e.shiftKey;
      if (redo) this.redo();
      else this.undo();
      return;
    }
    const map: Record<string, BooleanStyle> = { b: 'bold', i: 'italic', u: 'underline' };
    const toggle = e.shiftKey ? (key === 'x' ? 'strike' : undefined) : map[key];
    if (toggle) {
      e.preventDefault();
      this.toggle(toggle);
    }
  }

  private onBeforeInput(e: InputEvent): void {
    const [from, to] = this.selection();
    this.inputStart = from;
    this.beforeSelection = [from, to];
    if (!this.block) return;
    const runs = this.block.runs;
    const para = paragraphAt(runs, from);
    const style = paragraphStyle(this.block, para);
    const atLineStart = from === to && (from === 0 || plainText(this.block)[from - 1] === '\n');
    if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') {
      // Insert a plain '\n' ourselves: browsers otherwise disagree on <div>/<br>.
      e.preventDefault();
      const lineEmpty = atLineStart && (plainText(this.block)[from] ?? '\n') === '\n';
      if (style.list && lineEmpty) {
        // Enter on an empty item leaves the list (one level up first), like word processors.
        this.write(
          updateParagraphs(this.block, para, para, (s) =>
            s.indent ? { ...s, indent: s.indent - 1 } : {},
          ),
          from,
          to,
        );
        return;
      }
      this.replace(from, to, '\n');
    } else if (e.inputType === 'deleteContentBackward' && style.list && atLineStart) {
      // Backspace at the start of an item turns it back into a plain line first.
      e.preventDefault();
      this.write(
        updateParagraphs(this.block, para, para, () => ({})),
        from,
        to,
      );
    } else if (e.inputType.startsWith('delete') && this.deleteAtEdges(e.inputType, from, to)) {
      e.preventDefault();
    } else if (e.inputType.startsWith('format')) {
      e.preventDefault(); // formatting goes through our model only
    } else if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
      e.preventDefault(); // menu/gesture undo: ours, not the browser's (it doesn't know our DOM)
      if (e.inputType === 'historyUndo') this.undo();
      else this.redo();
    }
  }

  /**
   * Deletions the browser gets wrong in our DOM, done on the model instead: a selection,
   * and anything that crosses a line break or the ends of the text (browsers then remove or
   * merge our paragraph blocks and leave filler `<br>`s, e.g. Backspace in an empty text
   * would come back as a new line). Inside a line the browser deletes (grapheme clusters,
   * words). Returns true when handled.
   */
  private deleteAtEdges(inputType: string, from: number, to: number): boolean {
    if (!this.block) return false;
    if (from !== to) {
      this.replace(from, to, '');
      return true;
    }
    const text = plainText(this.block);
    const backward = inputType.endsWith('Backward');
    if (backward) {
      if (from === 0) return true; // nothing before the caret
      if (text[from - 1] !== '\n') return false;
      this.replace(from - 1, from, ''); // joins the line with the previous one
      return true;
    }
    if (from >= text.length) return true; // nothing after the caret
    if (text[from] !== '\n') return false;
    this.replace(from, from + 1, ''); // joins the next line to this one
    return true;
  }

  undo(): void {
    this.travel(this.undoStack, this.redoStack);
  }

  redo(): void {
    this.travel(this.redoStack, this.undoStack);
  }

  private travel(from: Snapshot[], to: Snapshot[]): void {
    const target = from.pop();
    if (!target || !this.block) return;
    const [selFrom, selTo] = this.selection();
    to.push({ block: this.block, from: selFrom, to: selTo });
    this.lastTypingAt = 0; // the next keystroke starts a new undo step
    this.write(target.block, target.from, target.to, 'none');
  }

  /** Remembers the state before a change. Consecutive typing within a second is one step. */
  private record(kind: 'typing' | 'other'): void {
    if (!this.block) return;
    const now = performance.now();
    const merge = kind === 'typing' && now - this.lastTypingAt < 1000;
    this.lastTypingAt = kind === 'typing' ? now : 0;
    this.redoStack = [];
    if (merge) return;
    // For typing the DOM (and caret) already changed: use the selection from before it.
    const [from, to] = kind === 'typing' ? this.beforeSelection : this.selection();
    this.undoStack.push({ block: this.block, from, to });
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
  }

  private onInput(): void {
    if (!this.block || this.composing) return;
    const caret = this.selection()[1];
    const parsed = parse(this.input);
    let runs = parsed.runs;
    let paragraphs = parsed.paragraphs;
    if (this.pending && caret > this.inputStart) {
      runs = applyStyle(runs, this.inputStart, caret, this.pending);
    }
    this.pending = null;
    let block = withParagraphs({ ...this.block, runs }, paragraphs);
    let at = caret;
    // "- " or "1. " typed at the start of a plain line: make it a list item.
    const text = plainText(block);
    const para = paragraphAt(runs, caret);
    const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
    const typed = text.slice(lineStart, caret);
    const shortcut = LIST_SHORTCUTS.find(([re]) => re.test(typed));
    if (shortcut && !paragraphStyle(block, para).list) {
      // First record the plain typing, so Ctrl+Z brings the "- " back.
      this.write(block, caret, caret, 'typing');
      runs = replaceRuns(runs, lineStart, caret, '', null);
      paragraphs = remapParagraphs(block.runs, block.paragraphs, lineStart, caret, '');
      block = withParagraphs({ ...block, runs }, paragraphs);
      block = updateParagraphs(block, para, para, (s) => ({ ...s, list: shortcut[1] }));
      at = lineStart;
      this.write(block, at, at, 'other');
      return;
    }
    this.write(block, at, at, 'typing');
  }

  private replace(from: number, to: number, text: string): void {
    if (!this.block) return;
    const runs = replaceRuns(this.block.runs, from, to, text, this.pending);
    const paragraphs = remapParagraphs(this.block.runs, this.block.paragraphs, from, to, text);
    this.write(
      withParagraphs({ ...this.block, runs }, paragraphs),
      from + text.length,
      from + text.length,
    );
  }

  private toggle(key: BooleanStyle): void {
    if (!this.block) return;
    const [from, to] = this.selection();
    if (from === to) {
      // No selection: affects what is typed next.
      const current = this.pending?.[key] ?? hasStyle(this.block.runs, from, to, key);
      this.pending = { ...this.pending, [key]: !current };
      this.syncToolbar();
      return;
    }
    this.update(toggleStyle(this.block.runs, from, to, key), from, to);
  }

  private setColor(color: number): void {
    if (!this.block) return;
    const [from, to] = this.selection();
    const value = color === this.block.color ? undefined : color;
    if (from === to) {
      this.pending = { ...this.pending, color: value };
      return;
    }
    this.update(applyStyle(this.block.runs, from, to, { color: value }), from, to);
  }

  // --- Size and font: the selection, or the whole text ---------------------------

  /** Font size (before autoFit) at the selection; null when the selection mixes sizes. */
  private sizeAtSelection(): number | null {
    if (!this.block) return null;
    const [from, to] = this.lastSelectionOrCurrent();
    const v = commonStyle(this.block.runs, from, to, 'size');
    return v === MIXED ? null : (v ?? this.block.fontSize);
  }

  private setFontSize(size: number): void {
    if (!this.block) return;
    const fontSize = clampFontSize(size / this.scale());
    const [from, to] = this.lastSelectionOrCurrent();
    if (from === to) {
      // The whole text gets this size.
      const len = runsLength(this.block.runs);
      const runs =
        len > 0 ? applyStyle(this.block.runs, 0, len, { size: undefined }) : this.block.runs;
      this.write({ ...this.block, fontSize, runs }, from, to);
    } else {
      const value = fontSize === this.block.fontSize ? undefined : fontSize;
      this.write(
        { ...this.block, runs: applyStyle(this.block.runs, from, to, { size: value }) },
        from,
        to,
      );
    }
    this.refocus();
  }

  private stepSize(dir: 1 | -1): void {
    if (!this.block) return;
    const [from, to] = this.lastSelectionOrCurrent();
    const k = this.scale();
    if (from !== to) {
      // From the size actually shown: an auto-fitted sticky may be smaller than its maximum.
      const shown = (this.sizeAtSelection() ?? this.block.fontSize) * k;
      this.setFontSize(stepFontSize(shown, dir));
      return;
    }
    // Whole text: every size steps by the same ratio, so headings stay bigger.
    const next = clampFontSize(stepFontSize(this.block.fontSize * k, dir) / k);
    const ratio = next / this.block.fontSize;
    const runs = this.block.runs.map((r) =>
      r.size === undefined ? r : { ...r, size: clampFontSize(r.size * ratio) },
    );
    this.write({ ...this.block, fontSize: next, runs }, from, to);
    this.refocus();
  }

  private setFont(id: string): void {
    if (!this.block) return;
    const [from, to] = this.lastSelectionOrCurrent();
    if (from === to) {
      const len = runsLength(this.block.runs);
      const runs =
        len > 0 ? applyStyle(this.block.runs, 0, len, { font: undefined }) : this.block.runs;
      const block: TextBlock = { ...this.block, runs, font: id };
      if (fontIndex(id) === 0) delete block.font;
      this.write(block, from, to);
    } else {
      const value = fontIndex(id) === fontIndex(this.block.font) ? undefined : id;
      this.write(
        { ...this.block, runs: applyStyle(this.block.runs, from, to, { font: value }) },
        from,
        to,
      );
    }
    this.refocus();
  }

  /** autoFit factor the text is shown at (sizes in the model are before it). */
  private scale(): number {
    const el = this.id ? this.scene.get(this.id) : undefined;
    return el && isShape(el) ? (this.renderer.textLayout(el)?.scale ?? 1) : 1;
  }

  // --- Lists -----------------------------------------------------------------------

  private toggleListAtSelection(kind: ListKind): void {
    if (!this.block) return;
    const [from, to] = this.lastSelectionOrCurrent();
    const [first, last] = paragraphRange(this.block.runs, from, to);
    this.write(toggleList(this.block, first, last, kind), from, to);
    this.refocus();
  }

  private indentAtSelection(dir: 1 | -1): void {
    if (!this.block) return;
    const [from, to] = this.selection();
    const [first, last] = paragraphRange(this.block.runs, from, to);
    const next = indentList(this.block, first, last, dir);
    if (next.paragraphs !== this.block.paragraphs) this.write(next, from, to);
  }

  // --- Links -----------------------------------------------------------------------

  private openLinkBar(): void {
    if (!this.block) return;
    const [from, to] = this.selection();
    const around = from === to ? linkAt(this.block.runs, from) : null;
    this.linkRange = around ? [around.from, around.to] : [from, to];
    const href = around?.href ?? commonStyle(this.block.runs, from, to, 'link');
    this.bar.linkInput.value = typeof href === 'string' ? href : '';
    this.bar.linkInput.classList.remove('invalid');
    this.bar.linkBar.hidden = false;
    this.bar.linkInput.focus();
    this.bar.linkInput.select();
  }

  private closeLinkBar(): void {
    this.bar.linkBar.hidden = true;
    this.linkRange = null;
  }

  /**
   * Links the remembered range to the typed address (an empty field removes the link).
   * Without a selection the address itself is inserted as linked text.
   */
  private applyLink(): void {
    if (!this.block || !this.linkRange) return;
    const [from, to] = this.linkRange;
    const raw = this.bar.linkInput.value.trim();
    const href = raw === '' ? undefined : normalizeLink(raw);
    if (href === null) {
      this.bar.linkInput.classList.add('invalid');
      return;
    }
    this.closeLinkBar();
    if (from === to) {
      if (href) {
        const runs = replaceRuns(this.block.runs, from, to, raw, { link: href });
        const paragraphs = remapParagraphs(this.block.runs, this.block.paragraphs, from, to, raw);
        this.write(
          withParagraphs({ ...this.block, runs }, paragraphs),
          from + raw.length,
          from + raw.length,
        );
      }
    } else {
      this.write(
        { ...this.block, runs: applyStyle(this.block.runs, from, to, { link: href }) },
        to,
        to,
      );
    }
    this.refocus();
  }

  // --- Writing ---------------------------------------------------------------------

  /** Changes block-level attributes (size, alignment) of the whole text. */
  private setBlock(patch: Partial<TextBlock>): void {
    if (!this.block) return;
    const [from, to] = this.lastSelectionOrCurrent();
    this.write({ ...this.block, ...patch }, from, to);
    this.refocus();
  }

  private update(
    runs: TextRun[],
    selFrom: number,
    selTo: number,
    history: 'typing' | 'other' | 'none' = 'other',
  ): void {
    if (!this.block) return;
    this.write({ ...this.block, runs }, selFrom, selTo, history);
  }

  /**
   * Writes a whole block: to the scene (an auto-sized text box is refitted in the same
   * update), to the DOM, and restores the selection.
   */
  private write(
    block: TextBlock,
    selFrom: number,
    selTo: number,
    history: 'typing' | 'other' | 'none' = 'other',
  ): void {
    if (!this.id || !this.block) return;
    const el = this.scene.get(this.id);
    if (!el || !isShape(el)) return;
    if (history !== 'none') this.record(history);
    this.block = block;
    render(this.input, block, this.labels.openLinkHint);
    this.select(selFrom, selTo);
    this.lastSelection = [selFrom, selTo];
    this.scene.update(this.id, {
      text: block,
      ...fitTextPatch(el, this.renderer.measurer, block),
    });
    this.syncToolbar();
    this.sync(); // autoFit may have changed the font size
  }

  /** Back to typing after a toolbar field took the focus, with the selection it had. */
  private refocus(): void {
    if (!this.id || document.activeElement === this.input) return;
    const [from, to] = this.lastSelectionOrCurrent();
    this.input.focus();
    this.select(from, to);
  }

  private lastSelectionOrCurrent(): [number, number] {
    const sel = getSelection();
    if (sel && sel.rangeCount > 0 && this.input.contains(sel.anchorNode)) return this.selection();
    return this.lastSelection ?? this.selection();
  }

  private selection(): [number, number] {
    const sel = getSelection();
    if (!sel || sel.rangeCount === 0 || !this.input.contains(sel.anchorNode)) {
      if (this.lastSelection) return this.lastSelection;
      const end = this.block ? runsLength(this.block.runs) : 0;
      return [end, end];
    }
    const r = sel.getRangeAt(0);
    const a = offsetOf(this.input, r.startContainer, r.startOffset);
    const b = offsetOf(this.input, r.endContainer, r.endOffset);
    return [Math.min(a, b), Math.max(a, b)];
  }

  private select(from: number, to: number): void {
    const sel = getSelection();
    if (!sel) return;
    const a = positionOf(this.input, from);
    const b = positionOf(this.input, to);
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  private syncToolbar(): void {
    if (!this.block || this.toolbar.hidden) return;
    const [from, to] = this.selection();
    this.bar.sync(this.block, from, to, this.pending);
  }

  /** The toolbar's element (shown above the text while editing). */
  private get toolbar(): HTMLElement {
    return this.bar.el;
  }
}

/** `block` with these paragraph styles (the field is dropped when all are plain). */
function withParagraphs(block: TextBlock, paragraphs: ParagraphStyle[] | undefined): TextBlock {
  const next: TextBlock = { ...block, paragraphs };
  if (!paragraphs) delete next.paragraphs;
  return next;
}
