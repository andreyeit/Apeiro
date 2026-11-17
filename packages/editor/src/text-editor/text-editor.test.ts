import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Camera, Scene, textBlock, type ShapeElement, type TextRun } from '@apeiro/core';
import type { BoardRenderer } from '@apeiro/renderer';
import { TextEditor } from './text-editor';

function sticky(runs: TextRun[]): ShapeElement {
  return {
    id: 's',
    type: 'sticky',
    x: 0,
    y: 0,
    w: 200,
    h: 200,
    rotation: 0,
    z: 0,
    fill: 0xffff00ff,
    stroke: 0,
    strokeWidth: 0,
    radius: 0,
    text: { ...textBlock(''), runs },
  };
}

/** Selects [from, to) of the editor's plain text. */
function select(input: HTMLElement, from: number, to: number) {
  const find = (offset: number) => {
    let rest = offset;
    for (const span of input.querySelectorAll('span')) {
      const t = span.firstChild!;
      const len = t.textContent!.length;
      if (rest <= len) return { node: t, offset: rest };
      rest -= len;
    }
    throw new Error('offset out of range');
  };
  const a = find(from);
  const b = find(to);
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  getSelection()!.removeAllRanges();
  getSelection()!.addRange(range);
}

const key = (input: HTMLElement, k: string, extra: KeyboardEventInit = {}) =>
  input.dispatchEvent(
    new KeyboardEvent('keydown', { key: k, ctrlKey: true, bubbles: true, ...extra }),
  );

describe('TextEditor', () => {
  let scene: Scene;
  let editor: TextEditor;
  let input: HTMLElement;
  let hidden: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = '<div id="layer"></div>';
    scene = new Scene();
    const camera = new Camera();
    hidden = vi.fn();
    const renderer = {
      setTextHidden: hidden,
      drawnColor: (_type: string, color: number) => color,
      textLayout: () => undefined,
      measurer: { family: 'Inter' },
      onAfterRender: () => () => undefined,
    } as unknown as BoardRenderer;
    editor = new TextEditor(document.getElementById('layer')!, scene, camera, renderer);
    scene.add(sticky([{ text: 'hello ' }, { text: 'world', italic: true }]));
    editor.start('s');
    input = document.querySelector('.ap-text-editor-input')!;
  });

  const runs = () => (scene.get('s') as ShapeElement).text!.runs;

  it('renders runs as styled spans; the board keeps drawing the text (no change on edit)', () => {
    expect(input.textContent).toBe('hello world');
    expect(input.querySelector('[data-i]')!.textContent).toBe('world');
    expect(hidden).not.toHaveBeenCalledWith('s', true);
    expect(input.classList.contains('composing')).toBe(false);
  });

  it('an IME composition shows the editor text instead (it is not on the board yet)', () => {
    input.dispatchEvent(new CompositionEvent('compositionstart'));
    expect(hidden).toHaveBeenLastCalledWith('s', true);
    expect(input.classList.contains('composing')).toBe(true);
    input.dispatchEvent(new CompositionEvent('compositionend'));
    expect(hidden).toHaveBeenLastCalledWith('s', false);
    expect(input.classList.contains('composing')).toBe(false);
  });

  it('toggles bold on a selection across runs with Ctrl+B', () => {
    select(input, 3, 8);
    key(input, 'b');
    expect(runs()).toEqual([
      { text: 'hel' },
      { text: 'lo ', bold: true },
      { text: 'wo', italic: true, bold: true },
      { text: 'rld', italic: true },
    ]);
    // Selection is kept, so a second Ctrl+B removes it again.
    key(input, 'b');
    expect(runs()).toEqual([{ text: 'hello ' }, { text: 'world', italic: true }]);
  });

  it('supports underline and strike shortcuts', () => {
    select(input, 0, 5);
    key(input, 'u');
    key(input, 'x', { shiftKey: true });
    expect(runs()[0]).toEqual({ text: 'hello', underline: true, strike: true });
  });

  it('applies a toggled style to text typed at a collapsed caret', () => {
    select(input, 5, 5);
    key(input, 'b');
    // Simulate the browser inserting "!" into the first text node.
    input.dispatchEvent(
      new InputEvent('beforeinput', { inputType: 'insertText', data: '!', bubbles: true }),
    );
    const text = input.querySelector('span')!.firstChild!;
    text.textContent = 'hello! ';
    select(input, 6, 6);
    input.dispatchEvent(
      new InputEvent('input', { inputType: 'insertText', data: '!', bubbles: true }),
    );
    expect(runs()).toEqual([
      { text: 'hello' },
      { text: '!', bold: true },
      { text: ' ' },
      { text: 'world', italic: true },
    ]);
  });

  it('inserts a plain newline on Enter, keeping the style at the caret', () => {
    select(input, 8, 8);
    const e = new InputEvent('beforeinput', {
      inputType: 'insertParagraph',
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(runs()).toEqual([{ text: 'hello ' }, { text: 'wo\nrld', italic: true }]);
  });

  it('sets color on a selection from the toolbar', () => {
    select(input, 0, 5);
    const swatch = document.querySelectorAll<HTMLButtonElement>('.ap-text-toolbar .swatch')[1]!;
    swatch.click();
    expect(runs()[0]).toEqual({ text: 'hello', color: 0xdc2626ff });
  });

  it('restores WebGL text when editing stops', () => {
    editor.stop();
    expect(hidden).toHaveBeenLastCalledWith('s', false);
    expect(editor.editing).toBeNull();
  });
});
