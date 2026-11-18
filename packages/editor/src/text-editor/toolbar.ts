import {
  commonStyle,
  fontFamily,
  FONT_FAMILIES,
  hasStyle,
  linkAt,
  MIXED,
  paragraphRange,
  paragraphStyle,
  type BooleanStyle,
  type ListKind,
  type TextAlign,
  type TextBlock,
  type TextStyle,
} from '@apeiro/core';
import type { BoardLabels } from '../ui/labels';
import { toCss } from './dom';

/** Text colors offered by the toolbar. */
const COLORS = [0x1f2937ff, 0xdc2626ff, 0xea580cff, 0x16a34aff, 0x2563ebff, 0x7c3aedff];

/** What the toolbar's controls do; implemented by the text editor. */
export interface ToolbarActions {
  setFont(id: string): void;
  stepSize(dir: 1 | -1): void;
  setFontSize(size: number): void;
  toggle(key: BooleanStyle): void;
  openLinkBar(): void;
  applyLink(): void;
  closeLinkBar(): void;
  toggleList(kind: ListKind): void;
  setAlign(align: TextAlign): void;
  setColor(color: number): void;
  /** Back to typing after a toolbar field took the focus. */
  refocus(): void;
}

/**
 * The formatting toolbar above the text being edited: font, size, styles, link, lists,
 * alignment and colors, plus the link field under it. Buttons keep the text selection
 * (they don't take focus); fields swallow their keys so they aren't board shortcuts.
 */
export class TextToolbar {
  readonly el = document.createElement('div');
  readonly sizeInput = document.createElement('input');
  readonly linkBar = document.createElement('div');
  readonly linkInput = document.createElement('input');
  private readonly fontSelect = document.createElement('select');
  private readonly styleButtons = new Map<BooleanStyle, HTMLButtonElement>();
  private readonly alignButtons = new Map<TextAlign, HTMLButtonElement>();
  private readonly listButtons = new Map<ListKind, HTMLButtonElement>();
  private readonly linkButton: HTMLButtonElement;

  constructor(labels: BoardLabels, actions: ToolbarActions) {
    this.el.className = 'ap-text-toolbar';
    this.el.hidden = true;
    const row = document.createElement('div');
    row.className = 'ap-text-toolbar-row';
    const button = (label: string | Node, title: string, onClick: () => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.append(label);
      b.title = title;
      b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the text selection
      b.addEventListener('click', onClick);
      row.append(b);
      return b;
    };

    // Font family: each option shown in its own font.
    this.fontSelect.className = 'font-family';
    this.fontSelect.title = labels.font;
    for (const f of FONT_FAMILIES) {
      const o = document.createElement('option');
      o.value = f.id;
      o.textContent = f.label;
      o.style.fontFamily = f.css;
      this.fontSelect.append(o);
    }
    this.fontSelect.addEventListener('change', () => actions.setFont(this.fontSelect.value));
    this.fontSelect.addEventListener('keydown', (e) => e.stopPropagation());
    row.append(this.fontSelect);

    // Font size: A− [size] A+ (Ctrl+Shift+< / >), like the size field in Figma/Miro.
    button('A−', labels.smaller, () => actions.stepSize(-1)).className = 'wide';
    const size = this.sizeInput;
    size.type = 'number';
    size.min = '1';
    size.max = '1000';
    size.step = '1';
    size.className = 'font-size';
    size.title = labels.fontSize;
    size.addEventListener('change', () => {
      const v = Number(size.value);
      if (size.value.trim() !== '' && Number.isFinite(v)) actions.setFontSize(v);
    });
    size.addEventListener('keydown', (e) => {
      e.stopPropagation(); // not a board shortcut
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault();
        if (e.key === 'Enter') size.dispatchEvent(new Event('change'));
        actions.refocus();
      }
    });
    row.append(size);
    button('A+', labels.bigger, () => actions.stepSize(1)).className = 'wide';
    row.append(separator());

    const toggles: Array<[BooleanStyle, string, string]> = [
      ['bold', 'B', labels.bold],
      ['italic', 'I', labels.italic],
      ['underline', 'U', labels.underline],
      ['strike', 'S', labels.strike],
    ];
    for (const [key, label, title] of toggles) {
      const b = button(label, title, () => actions.toggle(key));
      b.dataset.style = key;
      this.styleButtons.set(key, b);
    }
    this.linkButton = button('🔗', labels.link, () => actions.openLinkBar());
    row.append(separator());

    for (const [kind, label, title] of [
      ['bullet', '•', labels.bulletList],
      ['ordered', '1.', labels.orderedList],
    ] as const) {
      const b = button(label, title, () => actions.toggleList(kind));
      b.dataset.list = kind;
      this.listButtons.set(kind, b);
    }
    row.append(separator());
    const aligns: Array<[TextAlign, string]> = [
      ['left', labels.alignLeft],
      ['center', labels.alignCenter],
      ['right', labels.alignRight],
    ];
    for (const [align, title] of aligns) {
      const b = button(alignIcon(align), title, () => actions.setAlign(align));
      b.dataset.align = align;
      this.alignButtons.set(align, b);
    }
    row.append(separator());
    for (const color of COLORS) {
      const b = button('', labels.textColor, () => actions.setColor(color));
      b.className = 'swatch';
      b.style.background = toCss(color);
    }

    this.buildLinkBar(labels, actions);
    this.el.append(row, this.linkBar);
  }

  /** Link field, shown under the buttons while adding or editing a link. */
  private buildLinkBar(labels: BoardLabels, actions: ToolbarActions): void {
    this.linkBar.className = 'ap-text-toolbar-row ap-link-bar';
    this.linkBar.hidden = true;
    const input = this.linkInput;
    input.type = 'url';
    input.placeholder = labels.linkPlaceholder;
    input.className = 'ap-link-input';
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        actions.applyLink();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        actions.closeLinkBar();
        actions.refocus();
      }
    });
    input.addEventListener('input', () => input.classList.remove('invalid'));
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.textContent = '✓';
    ok.title = labels.applyLink;
    ok.addEventListener('click', () => actions.applyLink());
    const unlink = document.createElement('button');
    unlink.type = 'button';
    unlink.textContent = '✕';
    unlink.title = labels.removeLink;
    unlink.addEventListener('click', () => {
      input.value = '';
      actions.applyLink();
    });
    this.linkBar.append(input, ok, unlink);
  }

  /** Lights up the controls for the text in [from, to) (`pending`: styles for what is typed next). */
  sync(block: TextBlock, from: number, to: number, pending: TextStyle | null): void {
    for (const [key, button] of this.styleButtons) {
      const on = (from === to ? pending?.[key] : undefined) ?? hasStyle(block.runs, from, to, key);
      button.classList.toggle('active', on);
    }
    for (const [align, button] of this.alignButtons)
      button.classList.toggle('active', block.align === align);
    const [first, last] = paragraphRange(block.runs, from, to);
    for (const [kind, button] of this.listButtons) {
      let all = true;
      for (let i = first; i <= last && all; i++)
        if (paragraphStyle(block, i).list !== kind) all = false;
      button.classList.toggle('active', all);
    }
    const link = from === to ? linkAt(block.runs, from) : null;
    const rangeLink = commonStyle(block.runs, from, to, 'link');
    this.linkButton.classList.toggle('active', !!link || typeof rangeLink === 'string');
    if (document.activeElement !== this.fontSelect) {
      const font = commonStyle(block.runs, from, to, 'font');
      this.fontSelect.value = font === MIXED ? '' : fontFamily(font ?? block.font).id;
    }
  }
}

function separator(): HTMLElement {
  const s = document.createElement('span');
  s.className = 'sep';
  return s;
}

/** Four lines aligned like the text. */
function alignIcon(align: TextAlign): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  for (const [i, len] of [14, 9, 12, 7].entries()) {
    const x = align === 'left' ? 1 : align === 'right' ? 15 - len : (16 - len) / 2;
    const line = document.createElementNS(ns, 'rect');
    line.setAttribute('x', String(x));
    line.setAttribute('y', String(2 + i * 3.5));
    line.setAttribute('width', String(len));
    line.setAttribute('height', '1.6');
    line.setAttribute('rx', '0.8');
    line.setAttribute('fill', 'currentColor');
    svg.append(line);
  }
  return svg;
}
