import { describe, expect, it } from 'vitest';
import { applyStyle, hasStyle, normalizeRuns, runsLength, toggleStyle } from './rich-text';

describe('rich text runs', () => {
  it('normalizes: merges equal styles and drops empty runs', () => {
    expect(
      normalizeRuns([
        { text: 'a' },
        { text: '' },
        { text: 'b', bold: false },
        { text: 'c', bold: true },
      ]),
    ).toEqual([{ text: 'ab' }, { text: 'c', bold: true }]);
    expect(normalizeRuns([{ text: '', italic: true }])).toEqual([{ text: '', italic: true }]);
  });

  it('applies a style to a range spanning several runs', () => {
    const runs = [{ text: 'hello ' }, { text: 'world', italic: true }];
    expect(applyStyle(runs, 3, 8, { bold: true })).toEqual([
      { text: 'hel' },
      { text: 'lo ', bold: true },
      { text: 'wo', italic: true, bold: true },
      { text: 'rld', italic: true },
    ]);
  });

  it('removes attributes with false/undefined', () => {
    const runs = [{ text: 'abc', bold: true, color: 0xff0000ff }];
    expect(applyStyle(runs, 0, 3, { bold: false, color: undefined })).toEqual([{ text: 'abc' }]);
  });

  it('toggles on when any character lacks the style, off when all have it', () => {
    const mixed = [{ text: 'ab', bold: true }, { text: 'cd' }];
    const on = toggleStyle(mixed, 0, 4, 'bold');
    expect(on).toEqual([{ text: 'abcd', bold: true }]);
    expect(toggleStyle(on, 0, 4, 'bold')).toEqual([{ text: 'abcd' }]);
  });

  it('reports style at a collapsed caret from the preceding character', () => {
    const runs = [{ text: 'ab', bold: true }, { text: 'cd' }];
    expect(hasStyle(runs, 2, 2, 'bold')).toBe(true);
    expect(hasStyle(runs, 3, 3, 'bold')).toBe(false);
    expect(hasStyle(runs, 0, 0, 'bold')).toBe(true);
  });

  it('keeps total length', () => {
    const runs = [{ text: 'Привет, ' }, { text: 'мир 👋', underline: true }];
    expect(runsLength(applyStyle(runs, 2, 9, { strike: true }))).toBe(runsLength(runs));
  });
});
