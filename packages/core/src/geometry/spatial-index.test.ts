import { describe, expect, it } from 'vitest';
import { SpatialIndex } from './spatial-index';
import { boxIntersects, type Box } from './math';

const box = (minX: number, minY: number, maxX: number, maxY: number): Box => ({
  minX,
  minY,
  maxX,
  maxY,
});

describe('SpatialIndex', () => {
  it('handles coordinates beyond packed keys and safely moves entries back into the grid', () => {
    const idx = new SpatialIndex({ cellSize: 1 });
    idx.set('near', box(0, 0, 1, 1));
    idx.set('far', box(1e20, -1e20, 1e20, -1e20));
    expect(idx.queryPoint(1e20, -1e20)).toEqual(['far']);
    expect(idx.queryPoint(0, 0)).toEqual(['near']);
    idx.set('far', box(2e20, 2e20, 2e20, 2e20));
    expect(idx.queryPoint(1e20, -1e20)).toEqual([]);
    expect(idx.queryPoint(2e20, 2e20)).toEqual(['far']);
    idx.set('far', box(10, 10, 11, 11));
    expect(idx.queryPoint(10, 10)).toEqual(['far']);
    expect(idx.queryPoint(2e20, 2e20)).toEqual([]);
    expect(idx.delete('far')).toBe(true);
  });

  it('rejects invalid options and boxes before changing the index', () => {
    for (const cellSize of [0, -1, NaN, Infinity])
      expect(() => new SpatialIndex({ cellSize })).toThrow(RangeError);
    for (const maxCellsPerEntry of [0, -1, 0.5, NaN, Infinity])
      expect(() => new SpatialIndex({ maxCellsPerEntry })).toThrow(RangeError);
    const idx = new SpatialIndex();
    idx.set('a', box(0, 0, 10, 10));
    for (const invalid of [box(NaN, 0, 1, 1), box(0, 0, Infinity, 1), box(10, 0, 0, 1)]) {
      expect(() => idx.set('a', invalid)).toThrow(RangeError);
      expect(() => idx.query(invalid)).toThrow(RangeError);
    }
    expect(idx.queryPoint(5, 5)).toEqual(['a']);
  });

  it('finds entries intersecting a query box', () => {
    const idx = new SpatialIndex({ cellSize: 100 });
    idx.set('a', box(0, 0, 50, 50));
    idx.set('b', box(500, 500, 600, 600));
    idx.set('c', box(-300, -300, -250, -250));
    expect(idx.query(box(-10, -10, 10, 10)).sort()).toEqual(['a']);
    expect(idx.query(box(-1000, -1000, 1000, 1000)).sort()).toEqual(['a', 'b', 'c']);
    expect(idx.queryPoint(550, 550)).toEqual(['b']);
  });

  it('reports multi-cell entries once', () => {
    const idx = new SpatialIndex({ cellSize: 10 });
    idx.set('wide', box(0, 0, 55, 35));
    expect(idx.query(box(0, 0, 100, 100))).toEqual(['wide']);
  });

  it('moves and deletes entries', () => {
    const idx = new SpatialIndex({ cellSize: 100 });
    idx.set('a', box(0, 0, 10, 10));
    idx.set('a', box(1000, 1000, 1010, 1010));
    expect(idx.queryPoint(5, 5)).toEqual([]);
    expect(idx.queryPoint(1005, 1005)).toEqual(['a']);
    expect(idx.delete('a')).toBe(true);
    expect(idx.queryPoint(1005, 1005)).toEqual([]);
    expect(idx.size).toBe(0);
  });

  it('keeps huge entries out of the grid but still finds them', () => {
    const idx = new SpatialIndex({ cellSize: 10, maxCellsPerEntry: 4 });
    idx.set('huge', box(-10000, -10000, 10000, 10000));
    expect(idx.queryPoint(1234, -567)).toEqual(['huge']);
    idx.set('huge', box(0, 0, 5, 5)); // shrinks back into the grid
    expect(idx.queryPoint(1234, -567)).toEqual([]);
    expect(idx.queryPoint(1, 1)).toEqual(['huge']);
  });

  it('matches brute force on random data', () => {
    let seed = 42;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const idx = new SpatialIndex<number>({ cellSize: 64 });
    const boxes: Box[] = [];
    for (let i = 0; i < 2000; i++) {
      const x = rand() * 10000 - 5000;
      const y = rand() * 10000 - 5000;
      const b = box(x, y, x + rand() * 300, y + rand() * 300);
      boxes.push(b);
      idx.set(i, b);
    }
    for (let i = 0; i < 1000; i += 3) idx.delete(i);
    for (let q = 0; q < 50; q++) {
      const x = rand() * 10000 - 5000;
      const y = rand() * 10000 - 5000;
      const query = box(x, y, x + rand() * 2000, y + rand() * 2000);
      const expected = boxes
        .map((b, i) => (i < 1000 && i % 3 === 0 ? -1 : boxIntersects(b, query) ? i : -1))
        .filter((i) => i >= 0);
      expect(idx.query(query).sort((a, b) => a - b)).toEqual(expected);
    }
  });
});
