import { describe, expect, it } from 'vitest';
import { offsetMapper } from './text-editor';

describe('offsetMapper', () => {
  it('shifts offsets after a remote insertion and keeps those before it', () => {
    const map = offsetMapper('hello world', 'hello big world');
    expect(map(2)).toBe(2);
    expect(map(8)).toBe(12);
    expect(map(11)).toBe(15);
  });

  it('moves offsets inside a removed range to its end', () => {
    const map = offsetMapper('abcdef', 'af');
    expect(map(3)).toBe(1);
    expect(map(6)).toBe(2);
  });
});
