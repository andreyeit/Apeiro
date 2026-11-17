import { describe, expect, it } from 'vitest';
import { isColorGlyph, plainText, textBlock, LINE_HEIGHT } from './text-block';
import { layoutText, type FontMeasurer } from './layout';
import { textArea } from '../elements/element';
import { makeRect } from '../test-utils';

/** Monospace: every char is 0.5em, bold is 0.6em. */
const mono: FontMeasurer = {
  advance: (_ch, variant) => (variant & 1 ? 0.6 : 0.5),
  ascent: 0.8,
  descent: 0.2,
};

const lineText = (layout: ReturnType<typeof layoutText>) => {
  const byLine = new Map<number, string>();
  for (const g of layout.glyphs) byLine.set(g.y, (byLine.get(g.y) ?? '') + g.char);
  return [...byLine.values()];
};

describe('layoutText', () => {
  it('wraps on word boundaries', () => {
    // fontSize 10 → 5 units per char; width 50 → 10 chars per line.
    const block = textBlock('hello big world', {
      fontSize: 10,
      align: 'left',
      verticalAlign: 'top',
    });
    const layout = layoutText(block, 50, 1000, mono);
    expect(lineText(layout)).toEqual(['hellobig', 'world']);
    expect(layout.lineCount).toBe(2);
    expect(layout.glyphs[0]!.x).toBe(0);
    // "hello big " (10 chars): the space before the break stays on the line and takes room,
    // as in the editor (CSS break-spaces).
    expect(layout.width).toBe(50);
  });

  it('wraps spaces that do not fit instead of letting them hang past the box', () => {
    // 10 chars per line: "hello" + 8 spaces → the last 3 spaces wrap to line 2.
    const block = textBlock('hello        ', { fontSize: 10, align: 'left', verticalAlign: 'top' });
    const layout = layoutText(block, 50, 1000, mono);
    expect(layout.lineCount).toBe(2);
    expect(layout.lines.map((l) => l.width)).toEqual([50, 15]);
    expect(Math.max(...layout.lines.map((l) => l.width))).toBeLessThanOrEqual(50);
  });

  it('breaks words longer than the line', () => {
    const block = textBlock('abcdefghijkl', { fontSize: 10, align: 'left' });
    expect(lineText(layoutText(block, 50, 1000, mono))).toEqual(['abcdefghij', 'kl']);
  });

  it('keeps explicit newlines and empty lines', () => {
    const block = textBlock('a\n\nb', { fontSize: 10 });
    const layout = layoutText(block, 100, 1000, mono);
    expect(layout.lineCount).toBe(3);
    const ys = layout.glyphs.map((g) => g.y);
    expect(ys[1]! - ys[0]!).toBeCloseTo(2 * LINE_HEIGHT * 10);
  });

  it('handles Cyrillic and surrogate pairs as single glyphs', () => {
    const block = textBlock('Привет 👋', { fontSize: 10 });
    const layout = layoutText(block, 1000, 1000, mono);
    expect(layout.glyphs.map((g) => g.char).join('')).toBe('Привет👋');
  });

  it('aligns horizontally and vertically', () => {
    const base = { fontSize: 10, verticalAlign: 'top' as const };
    const right = layoutText(textBlock('ab', { ...base, align: 'right' }), 100, 100, mono);
    expect(right.glyphs[0]!.x).toBe(90);
    const center = layoutText(textBlock('ab', { ...base, align: 'center' }), 100, 100, mono);
    expect(center.glyphs[0]!.x).toBe(45);

    const top = layoutText(textBlock('a', { fontSize: 10, verticalAlign: 'top' }), 100, 100, mono);
    const bottom = layoutText(
      textBlock('a', { fontSize: 10, verticalAlign: 'bottom' }),
      100,
      100,
      mono,
    );
    expect(bottom.glyphs[0]!.y - top.glyphs[0]!.y).toBeCloseTo(100 - LINE_HEIGHT * 10);
  });

  it('applies run styles: variants, colors, decorations', () => {
    const block = {
      ...textBlock('', { fontSize: 10, align: 'left' as const }),
      runs: [
        { text: 'ab', bold: true, underline: true },
        { text: 'cd', italic: true, color: 0xff0000ff, underline: true },
        { text: 'e', strike: true },
      ],
    };
    const layout = layoutText(block, 1000, 1000, mono);
    expect(layout.glyphs.map((g) => g.variant)).toEqual([1, 1, 2, 2, 0]);
    expect(layout.glyphs[2]!.color).toBe(0xff0000ff);
    expect(layout.glyphs[2]!.x).toBeCloseTo(12); // two bold chars, 6 each
    // Underline splits at the color change; strike is separate.
    expect(layout.decorations).toHaveLength(3);
    expect(layout.decorations[0]!.width).toBeCloseTo(12);
    expect(layout.decorations[1]!.width).toBeCloseTo(10);
  });

  it('shrinks to fit with autoFit', () => {
    const long = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor';
    const block = textBlock(long, { fontSize: 40, autoFit: true });
    const layout = layoutText(block, 100, 100, mono);
    expect(layout.fontSize).toBeLessThan(40);
    expect(layout.fontSize).toBeGreaterThanOrEqual(6);
    expect(layout.fits).toBe(true);
    expect(layout.lineCount * LINE_HEIGHT * layout.fontSize).toBeLessThanOrEqual(100);
    expect(Math.max(...layout.glyphs.map((g) => g.x))).toBeLessThan(100);

    const short = layoutText(textBlock('hi', { fontSize: 40, autoFit: true }), 100, 100, mono);
    expect(short.fontSize).toBe(40);
  });

  it('reports overflow when even the minimum size does not fit', () => {
    const block = textBlock('x'.repeat(5000), { fontSize: 20, autoFit: true });
    const layout = layoutText(block, 50, 50, mono);
    expect(layout.fits).toBe(false);
    expect(layout.fontSize).toBe(6);
  });

  it('extracts plain text', () => {
    expect(plainText({ ...textBlock(''), runs: [{ text: 'a' }, { text: 'b', bold: true }] })).toBe(
      'ab',
    );
  });
});

describe('textArea', () => {
  it('insets by padding and stroke', () => {
    const area = textArea(makeRect('r', { type: 'sticky', w: 200, h: 200 }));
    expect(area).toEqual({ minX: 16, minY: 16, maxX: 184, maxY: 184 });
  });

  it('uses the inscribed rectangle for ellipses', () => {
    const area = textArea(makeRect('e', { type: 'ellipse', w: 200, h: 100 }));
    expect(area.maxX - area.minX).toBeCloseTo(200 * Math.SQRT1_2 - 12);
  });
});

describe('layoutText: segmentation and breaking', () => {
  it('keeps emoji sequences, flags and combining marks as one glyph', () => {
    const block = textBlock('👨‍👩‍👧🇷🇺❤️е́', { fontSize: 10 });
    const chars = layoutText(block, 1000, 1000, mono).glyphs.map((g) => g.char);
    expect(chars).toEqual(['👨‍👩‍👧', '🇷🇺', '❤️', 'е́']);
  });

  it('detects color glyphs', () => {
    expect(isColorGlyph('👋')).toBe(true);
    expect(isColorGlyph('🇷🇺')).toBe(true);
    expect(isColorGlyph('1️⃣')).toBe(true);
    expect(isColorGlyph('Я')).toBe(false);
  });

  it('breaks after hyphens', () => {
    // 10 chars per line; "client-server" can break after the hyphen.
    const block = textBlock('client-server', { fontSize: 10, align: 'left' });
    expect(lineText(layoutText(block, 50, 1000, mono))).toEqual(['client-', 'server']);
  });

  it('breaks between CJK characters', () => {
    const block = textBlock('一二三四五六', { fontSize: 10, align: 'left' });
    expect(lineText(layoutText(block, 20, 1000, mono))).toEqual(['一二三四', '五六']);
  });

  it('applies kerning when the measurer provides it', () => {
    const kerned: FontMeasurer = {
      ...mono,
      kerning: (a, b) => (a === 'A' && b === 'V' ? -0.1 : 0),
    };
    const block = textBlock('AVA', { fontSize: 10, align: 'left' });
    const xs = layoutText(block, 1000, 1000, kerned).glyphs.map((g) => g.x);
    expect(xs[1]).toBeCloseTo(4); // 5 - 1
    expect(xs[2]).toBeCloseTo(9);
  });

  it('reports lines for greeking', () => {
    const block = textBlock('hello big world', {
      fontSize: 10,
      align: 'left',
      verticalAlign: 'top',
    });
    const layout = layoutText(block, 50, 1000, mono);
    expect(layout.lines.map((l) => l.width)).toEqual([50, 25]);
  });
});
