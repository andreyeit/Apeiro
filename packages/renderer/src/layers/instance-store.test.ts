import { describe, expect, it } from 'vitest';
import type { ShapeElement } from '@apeiro/core';
import { INSTANCE_STRIDE, InstanceStore, KIND_HIDDEN } from './instance-store';

const el = (id: string, z: number, patch: Partial<ShapeElement> = {}): ShapeElement => ({
  id,
  type: 'rect',
  x: 0,
  y: 0,
  w: 10,
  h: 10,
  rotation: 0,
  z,
  fill: 0x11223344,
  stroke: 0xaabbccdd,
  strokeWidth: 1,
  radius: 0,
  ...patch,
});

const kindAt = (store: InstanceStore, slot: number) =>
  new Float32Array(store.data)[slot * (INSTANCE_STRIDE / 4) + 7];

describe('InstanceStore', () => {
  it('grows from zero capacity without losing appended elements', () => {
    const store = new InstanceStore(0);
    expect(store.tryAppend([el('a', 1)])).toBe(true);
    expect(store.count).toBe(1);
    expect(store.slot('a')).toBe(0);
    expect(store.takeDirty()).toEqual({ kind: 'all' });
  });

  it('lays out instances in paint order with RGBA bytes', () => {
    const store = new InstanceStore(2);
    store.rebuild([el('a', 1, { x: 5, type: 'ellipse' }), el('b', 2)]);
    expect(store.count).toBe(2);
    expect(store.slot('a')).toBe(0);
    expect(store.slot('b')).toBe(1);
    const f32 = new Float32Array(store.data);
    expect(f32[0]).toBe(5);
    expect(kindAt(store, 0)).toBe(1);
    expect([...new Uint8Array(store.data, 32, 8)]).toEqual([
      0x11, 0x22, 0x33, 0x44, 0xaa, 0xbb, 0xcc, 0xdd,
    ]);
    expect(store.takeDirty()).toEqual({ kind: 'all' });
    expect(store.takeDirty()).toEqual({ kind: 'none' });
  });

  it('appends elements above the top without a rebuild', () => {
    const store = new InstanceStore();
    store.rebuild([el('a', 1)]);
    store.takeDirty();
    expect(store.tryAppend([el('c', 3), el('b', 2)])).toBe(true);
    expect(store.slot('b')).toBe(1);
    expect(store.slot('c')).toBe(2);
    expect(store.takeDirty()).toEqual({ kind: 'ranges', runs: [[1, 3]] });
  });

  it('refuses to append below the top', () => {
    const store = new InstanceStore();
    store.rebuild([el('a', 5)]);
    expect(store.tryAppend([el('b', 1)])).toBe(false);
    expect(store.count).toBe(1);
  });

  it('updates in place and hides removed slots', () => {
    const store = new InstanceStore();
    store.rebuild([el('a', 1), el('b', 2), el('c', 3)]);
    store.takeDirty();
    store.update(el('b', 2, { x: 99 }));
    store.remove('c');
    expect(store.takeDirty()).toEqual({ kind: 'ranges', runs: [[1, 3]] });
    expect(new Float32Array(store.data)[1 * (INSTANCE_STRIDE / 4)]).toBe(99);
    expect(kindAt(store, 2)).toBe(KIND_HIDDEN);
    expect(store.holeCount).toBe(1);
    expect(store.update(el('c', 3))).toBe(false);
  });

  it('grows capacity and requests a full upload', () => {
    const store = new InstanceStore(1);
    store.rebuild([el('a', 1)]);
    store.takeDirty();
    store.tryAppend([el('b', 2), el('c', 3)]);
    expect(store.capacity).toBeGreaterThanOrEqual(3);
    expect(store.takeDirty()).toEqual({ kind: 'all' });
    expect(new Float32Array(store.data)[0]).toBe(0); // old data preserved
    expect(store.slot('c')).toBe(2);
  });

  it('suggests compaction only when holes are significant', () => {
    const store = new InstanceStore();
    const els = Array.from({ length: 4000 }, (_, i) => el(`e${i}`, i));
    store.rebuild(els);
    for (let i = 0; i < 1000; i++) store.remove(`e${i}`);
    expect(store.needsCompaction()).toBe(false);
    for (let i = 1000; i < 1100; i++) store.remove(`e${i}`);
    expect(store.needsCompaction()).toBe(true);
  });
});
