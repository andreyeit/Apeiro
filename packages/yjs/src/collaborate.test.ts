import { History, type ShapeElement } from '@apeiro/core';
import { BoardEditor } from '@apeiro/editor';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { collaborate } from './collaborate';
import { YjsHistory } from './history';
import { YjsPresence, type PresenceEditor } from './presence';

const rect = (id: string, patch: Partial<ShapeElement> = {}): ShapeElement => ({
  id,
  type: 'rect',
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  rotation: 0,
  z: 0,
  fill: 0xffffffff,
  stroke: 0x000000ff,
  strokeWidth: 1,
  radius: 0,
  ...patch,
});

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});

/** Two awareness instances relaying their updates to each other. */
function awarenessPair() {
  const a = new Awareness(new Y.Doc());
  const b = new Awareness(new Y.Doc());
  const link = (from: Awareness, to: Awareness) =>
    from.on('update', ({ added, updated, removed }: Record<string, number[]>) => {
      const changed = [...added!, ...updated!, ...removed!];
      applyAwarenessUpdate(to, encodeAwarenessUpdate(from, changed), 'relay');
    });
  link(a, b);
  link(b, a);
  cleanup.push(() => {
    a.destroy();
    b.destroy();
  });
  return { a, b };
}

/** An editor stand-in whose pointer and selection the test sets. */
function fakeEditor() {
  const listeners = new Map<string, Set<() => void>>();
  const editor = {
    pointer: null as { x: number; y: number } | null,
    selection: [] as string[],
    editing: null as string | null,
    on(event: string, l: () => void) {
      const set = listeners.get(event) ?? new Set();
      listeners.set(event, set);
      set.add(l);
      return () => set.delete(l);
    },
    emit(event: string) {
      for (const l of listeners.get(event) ?? []) l();
    },
  };
  return editor as typeof editor & PresenceEditor;
}

describe('YjsPresence', () => {
  it("reports the other participant's cursor, selection and name", () => {
    const { a, b } = awarenessPair();
    const ea = fakeEditor();
    const eb = fakeEditor();
    const pa = new YjsPresence(ea, a, { user: { name: 'Ann', color: '#e11d48' }, throttleMs: 0 });
    const pb = new YjsPresence(eb, b, { user: { name: 'Bob', color: '#2563eb' }, throttleMs: 0 });
    cleanup.push(() => {
      pa.destroy();
      pb.destroy();
    });
    ea.pointer = { x: 10, y: 20 };
    ea.emit('pointer');
    ea.selection = ['r1'];
    ea.emit('selection');
    expect(pb.getPeers()).toEqual([
      {
        id: a.clientID,
        name: 'Ann',
        color: '#e11d48',
        cursor: { x: 10, y: 20 },
        selection: ['r1'],
        editing: null,
      },
    ]);
    expect(pa.getPeers().map((p) => p.name)).toEqual(['Bob']);
  });

  it('keeps the peers array until something changes and notifies on change', () => {
    const { a, b } = awarenessPair();
    const pa = new YjsPresence(fakeEditor(), a, { throttleMs: 0 });
    const eb = fakeEditor();
    const pb = new YjsPresence(eb, b, { throttleMs: 0 });
    cleanup.push(() => {
      pa.destroy();
      pb.destroy();
    });
    const first = pa.getPeers();
    const l = vi.fn();
    pa.subscribe(l);
    eb.emit('selection'); // same state again
    expect(pa.getPeers()).toBe(first);
    eb.selection = ['x'];
    eb.emit('selection');
    expect(l).toHaveBeenCalledTimes(1);
    expect(pa.getPeers()[0]!.selection).toEqual(['x']);
  });

  it('leaves the board on destroy', () => {
    const { a, b } = awarenessPair();
    const pa = new YjsPresence(fakeEditor(), a);
    const pb = new YjsPresence(fakeEditor(), b);
    cleanup.push(() => pb.destroy());
    expect(pb.getPeers()).toHaveLength(1);
    pa.destroy();
    expect(pb.getPeers()).toHaveLength(0);
  });
});

describe('collaborate', () => {
  it('syncs two unmounted editors and gives each a Yjs history', () => {
    const da = new Y.Doc();
    const db = new Y.Doc();
    da.on('update', (u: Uint8Array) => Y.applyUpdate(db, u));
    db.on('update', (u: Uint8Array) => Y.applyUpdate(da, u));
    const ea = new BoardEditor();
    const eb = new BoardEditor();
    const ca = collaborate(ea, da);
    const cb = collaborate(eb, db);
    expect(ea.history).toBeInstanceOf(YjsHistory);
    ea.addElements([rect('r1')]);
    expect(eb.scene.has('r1')).toBe(true);
    expect(ea.selection).toEqual(['r1']);
    eb.updateElements(['r1'], { x: 40 });
    ea.undo();
    // Ann's undo removes her shape (her only step), Bob's later move notwithstanding.
    expect(eb.scene.has('r1')).toBe(false);
    ca.destroy();
    cb.destroy();
    expect(ea.history).toBeInstanceOf(History);
    ea.destroy();
    eb.destroy();
  });

  it('wires presence into the editor', () => {
    const { a, b } = awarenessPair();
    const ea = new BoardEditor();
    const eb = new BoardEditor();
    const ca = collaborate(ea, new Y.Doc(), { awareness: a, user: { name: 'Ann', color: 'red' } });
    const cb = collaborate(eb, new Y.Doc(), { awareness: b, user: { name: 'Bob', color: 'blue' } });
    const l = vi.fn();
    eb.on('presence', l);
    ea.addElements([rect('r1')]);
    expect(eb.peers.map((p) => [p.name, p.selection])).toEqual([['Ann', ['r1']]]);
    expect(l).toHaveBeenCalled();
    ca.destroy();
    cb.destroy();
  });
});
