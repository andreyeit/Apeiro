import { beforeEach, describe, expect, it } from 'vitest';
import { Camera, Scene, textBlock, type ShapeElement, type TextRun } from '@apeiro/core';
import type { BoardRenderer } from '@apeiro/renderer';
import { TextEditor } from './text-editor';
import { parse, positionOf } from './dom';

const html = (markup: string) => {
  const root = document.createElement('div');
  root.innerHTML = markup;
  return parse(root)
    .runs.map((r) => r.text)
    .join('');
};

describe('editor DOM: filler line breaks', () => {
  // Browsers leave a <br> after deleting or merging lines only to give the line a height.
  it('a trailing <br> in a paragraph is not a line break', () => {
    expect(html('<br>')).toBe('');
    expect(html('<div data-p="1"><br></div>')).toBe('');
    expect(html('<div data-p="1"><span>hello</span><br></div>')).toBe('hello');
    expect(html('<div data-p="1"><span>hello<br></span></div>')).toBe('hello');
    expect(html('<div data-p="1">a<br></div><div data-p="1">b</div>')).toBe('a\nb');
  });

  it('a <br> followed by content is a line break', () => {
    expect(html('a<br>b')).toBe('a\nb');
    expect(html('a<br><br>')).toBe('a\n');
    expect(html('<div data-p="1"><span>a</span><br><span>b</span></div>')).toBe('a\nb');
  });
});

function text(runs: TextRun[]): ShapeElement {
  return {
    id: 't',
    type: 'text',
    x: 0,
    y: 0,
    w: 100,
    h: 30,
    rotation: 0,
    z: 0,
    fill: 0,
    stroke: 0,
    strokeWidth: 0,
    radius: 0,
    text: { ...textBlock(''), runs },
  };
}

describe('TextEditor: deleting at the edges of lines and of the text', () => {
  let scene: Scene;
  let editor: TextEditor;
  let input: HTMLElement;

  const start = (runs: TextRun[]) => {
    scene.add(text(runs));
    editor.start('t');
    input = document.querySelector('.ap-text-editor-input')!;
  };
  const caret = (offset: number) => {
    const p = positionOf(input, offset);
    const range = document.createRange();
    range.setStart(p.node, p.offset);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  };
  /** Dispatches a delete; returns whether the editor handled it itself. */
  const del = (inputType: string) => {
    const e = new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true });
    input.dispatchEvent(e);
    return e.defaultPrevented;
  };
  const value = () =>
    ((scene.get('t') as ShapeElement).text?.runs ?? []).map((r) => r.text).join('');

  beforeEach(() => {
    document.body.innerHTML = '<div id="layer"></div>';
    scene = new Scene();
    const renderer = {
      setTextHidden: () => undefined,
      drawnColor: (_type: string, color: number) => color,
      textLayout: () => undefined,
      measurer: { family: 'Inter' },
      onAfterRender: () => () => undefined,
    } as unknown as BoardRenderer;
    editor = new TextEditor(document.getElementById('layer')!, scene, new Camera(), renderer);
  });

  it('Backspace / Delete in an empty text do nothing (no new line)', () => {
    start([{ text: '' }]);
    caret(0);
    expect(del('deleteContentBackward')).toBe(true);
    expect(del('deleteContentForward')).toBe(true);
    expect(del('deleteWordBackward')).toBe(true);
    expect(value()).toBe('');
  });

  it('Backspace at a line start joins it to the previous line', () => {
    start([{ text: 'ab\ncd' }]);
    caret(3);
    expect(del('deleteContentBackward')).toBe(true);
    expect(value()).toBe('abcd');
  });

  it('Delete at a line end joins the next line', () => {
    start([{ text: 'ab\ncd' }]);
    caret(2);
    expect(del('deleteContentForward')).toBe(true);
    expect(value()).toBe('abcd');
  });

  it('inside a line the browser deletes (grapheme clusters, words)', () => {
    start([{ text: 'abc' }]);
    caret(2);
    expect(del('deleteContentBackward')).toBe(false);
  });

  it('a selection is deleted on the model, across lines too', () => {
    start([{ text: 'abc\ndef' }]);
    const a = positionOf(input, 1);
    const b = positionOf(input, 5);
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    expect(del('deleteContentBackward')).toBe(true);
    expect(value()).toBe('aef');
  });

  it('stopping the editor gives the focus back to the board', () => {
    start([{ text: 'x' }]);
    input.focus();
    expect(document.activeElement).toBe(input);
    editor.stop();
    expect(document.activeElement).not.toBe(input);
  });
});
