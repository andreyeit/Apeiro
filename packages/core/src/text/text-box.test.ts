import { describe, expect, it } from 'vitest';
import type { ShapeElement } from '../elements/element';
import { validateElement } from '../elements/validation';
import { LINE_HEIGHT, textBlock, type TextBlock } from './text-block';
import type { FontMeasurer } from './layout';
import {
  clampFontSize,
  createTextElement,
  defaultTextBlock,
  fitTextPatch,
  measureTextBox,
  stepFontSize,
  textSizing,
} from './text-box';
import { scaleElements, shapeFrame } from '../elements/transform';

/** Monospace: every char is 0.5em. */
const mono: FontMeasurer = { advance: () => 0.5, ascent: 0.8, descent: 0.2 };

const withText = (
  el: ShapeElement,
  text: string,
  patch: Partial<TextBlock> = {},
): ShapeElement => ({
  ...el,
  text: { ...el.text!, runs: [{ text }], ...patch },
});

describe('text boxes', () => {
  it('creates auto-width text by click and auto-height text by drag', () => {
    const click = createTextElement('t', { x: 10, y: 20 }, 1);
    expect(textSizing(click)).toBe('auto-width');
    expect(click.text!.align).toBe('left');
    expect(validateElement(click)).toBeNull();
    const drag = createTextElement('t', { x: 0, y: 0 }, 1, 300);
    expect(textSizing(drag)).toBe('auto-height');
    expect(drag.w).toBe(300);
    expect(textSizing({ ...drag, type: 'rect' })).toBe('fixed');
    expect(defaultTextBlock('sticky').autoFit).toBe(true);
  });

  it('auto-width grows with the longest line and never wraps', () => {
    const el = withText(
      createTextElement('t', { x: 0, y: 0 }, 1, undefined, textBlock('', { fontSize: 10 })),
      'hello world\nab',
    );
    const size = measureTextBox(el, mono)!;
    expect(size.w).toBeCloseTo(11 * 5);
    expect(size.h).toBeCloseTo(2 * LINE_HEIGHT * 10);
  });

  it('auto-height keeps the width and wraps', () => {
    const base = createTextElement('t', { x: 0, y: 0 }, 1, 30, textBlock('', { fontSize: 10 }));
    const el = withText(base, 'aaa bbb ccc');
    const size = measureTextBox(el, mono)!;
    expect(size.w).toBe(30);
    expect(size.h).toBeCloseTo(3 * LINE_HEIGHT * 10);
    expect(measureTextBox(withText(el, 'x', { sizing: 'fixed' }), mono)).toBeNull();
  });

  it('grows away from the alignment', () => {
    const base = createTextElement(
      't',
      { x: 100, y: 100 },
      1,
      undefined,
      textBlock('', { fontSize: 10 }),
    );
    const left = fitTextPatch(withText(base, 'abcd', { align: 'left' }), mono)!;
    expect(left.x).toBeCloseTo(100);
    expect(left.w).toBeCloseTo(20);
    const right = fitTextPatch(withText(base, 'abcd', { align: 'right' }), mono)!;
    expect(right.x! + right.w!).toBeCloseTo(100 + base.w);
    const center = fitTextPatch(withText(base, 'abcd', { align: 'center' }), mono)!;
    expect(center.x! + center.w! / 2).toBeCloseTo(100 + base.w / 2);
    // Already fits: nothing to do.
    const fitted = { ...withText(base, 'abcd'), ...left } as ShapeElement;
    expect(fitTextPatch(fitted, mono)).toBeNull();
  });

  it('keeps the anchor in place on rotated text', () => {
    const base = {
      ...createTextElement('t', { x: 0, y: 0 }, 1, undefined, textBlock('', { fontSize: 10 })),
      rotation: Math.PI / 2,
    };
    const el = withText(base, 'abcdefgh', { align: 'left' });
    const p = fitTextPatch(el, mono)!;
    // Top-left corner of the rotated box, before and after.
    const corner = (x: number, y: number, w: number, h: number) => ({
      x: x + w / 2 + h / 2, // rotate(-w/2, -h/2) by 90°: (h/2, -w/2)
      y: y + h / 2 - w / 2,
    });
    const a = corner(el.x, el.y, el.w, el.h);
    const b = corner(p.x!, p.y!, p.w!, p.h!);
    expect(b.x).toBeCloseTo(a.x);
    expect(b.y).toBeCloseTo(a.y);
  });

  it('steps and clamps font sizes', () => {
    expect(stepFontSize(16, 1)).toBe(18);
    expect(stepFontSize(16, -1)).toBe(14);
    expect(stepFontSize(17, 1)).toBe(18);
    expect(stepFontSize(10, -1)).toBe(8);
    expect(clampFontSize(0)).toBe(1);
    expect(clampFontSize(12.345)).toBe(12.3);
  });

  it('rejects unknown sizing and alignment', () => {
    const el = createTextElement('t', { x: 0, y: 0 }, 1);
    expect(validateElement(withText(el, 'a', { sizing: 'grow' as never }))).toMatch(/sizing/);
    expect(validateElement(withText(el, 'a', { align: 'justify' as never }))).toMatch(/align/);
  });
});

describe('scaling text', () => {
  const el = withText(
    createTextElement('t', { x: 0, y: 0 }, 1, undefined, textBlock('', { fontSize: 20 })),
    'hi',
  );
  const from = shapeFrame(el);

  it('corner handles scale the font with the box', () => {
    const to = { ...from, w: from.w * 2, h: from.h * 2 };
    const p = scaleElements([el], from, to, { scaleText: true }).get('t')!;
    expect(p.text!.fontSize).toBeCloseTo(40);
    expect(p.text!.sizing).toBe('auto-width');
  });

  it('a side handle turns auto-width into wrapping text, a vertical one into fixed', () => {
    const wider = scaleElements([el], from, { ...from, w: from.w + 50 }).get('t')!;
    expect(wider.text!.sizing).toBe('auto-height');
    expect(wider.text!.fontSize).toBe(20);
    const taller = scaleElements([el], from, { ...from, h: from.h + 50 }).get('t')!;
    expect(taller.text!.sizing).toBe('fixed');
    const moved = scaleElements([el], from, { ...from, cx: from.cx + 5 }).get('t')!;
    expect(moved.text).toBeUndefined(); // same text object kept: no relayout
  });
});
