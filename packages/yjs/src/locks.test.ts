import type { ShapeElement } from '@apeiro/core';
import { BoardEditor } from '@apeiro/editor';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { collaborate, type CollaborateOptions } from './collaborate';
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

/**
 * Two participants: linked docs and awareness. Ann gets the lower client id, so she wins
 * ties. `pause` holds awareness updates back (both act before hearing from the other).
 */
function room(options: CollaborateOptions = {}) {
  const da = new Y.Doc();
  const db = new Y.Doc();
  da.clientID = 1;
  db.clientID = 2;
  da.on('update', (u: Uint8Array, o: unknown) => o !== 'relay' && Y.applyUpdate(db, u, 'relay'));
  db.on('update', (u: Uint8Array, o: unknown) => o !== 'relay' && Y.applyUpdate(da, u, 'relay'));
  const aa = new Awareness(da);
  const ab = new Awareness(db);
  let online = true;
  const queue: Array<() => void> = [];
  const link = (from: Awareness, to: Awareness) =>
    from.on('update', ({ added, updated, removed }: Record<string, number[]>, origin: unknown) => {
      if (origin === 'relay') return;
      const update = encodeAwarenessUpdate(from, [...added!, ...updated!, ...removed!]);
      const send = () => applyAwarenessUpdate(to, update, 'relay');
      if (online) send();
      else queue.push(send);
    });
  link(aa, ab);
  link(ab, aa);
  const ann = new BoardEditor();
  const bob = new BoardEditor();
  const blocked = vi.fn();
  const sa = collaborate(ann, da, {
    ...options,
    awareness: aa,
    user: { name: 'Ann', color: 'red' },
    onUndoBlocked: blocked,
  });
  const sb = collaborate(bob, db, {
    ...options,
    awareness: ab,
    user: { name: 'Bob', color: 'blue' },
  });
  cleanup.push(() => {
    sa.destroy();
    sb.destroy();
    aa.destroy();
    ab.destroy();
    ann.destroy();
    bob.destroy();
  });
  return {
    ann,
    bob,
    blocked,
    pause: () => (online = false),
    resume: () => {
      online = true;
      for (const send of queue.splice(0)) send();
    },
  };
}

describe('locking elements others work on', () => {
  it("an element Bob selected can't be selected, changed or deleted by Ann", () => {
    const { ann, bob } = room();
    ann.addElements([rect('r1')], { select: false });
    bob.select(['r1']);
    expect(ann.lockedBy('r1')?.name).toBe('Bob');
    ann.select(['r1']);
    expect(ann.selection).toEqual([]);
    ann.updateElements(['r1'], { x: 50 });
    expect(ann.scene.remove('r1')).toBe(false);
    for (const e of [ann, bob]) expect(e.scene.get('r1')).toMatchObject({ x: 0 });
    // Bob himself edits freely, and Ann sees it.
    bob.updateSelection({ x: 80 });
    expect(ann.scene.get('r1')).toMatchObject({ x: 80 });
  });

  it('Ann can take it once Bob lets go', () => {
    const { ann, bob } = room();
    ann.addElements([rect('r1')], { select: false });
    bob.select(['r1']);
    bob.clearSelection();
    expect(ann.lockedBy('r1')).toBeNull();
    ann.select(['r1']);
    expect(ann.selection).toEqual(['r1']);
    expect(bob.lockedBy('r1')?.name).toBe('Ann');
  });

  it('Bob taking what Ann holds is refused, and Ann keeps it', () => {
    const { ann, bob } = room();
    ann.addElements([rect('r1')]);
    bob.select(['r1']);
    expect(bob.selection).toEqual([]);
    expect(ann.selection).toEqual(['r1']);
  });

  it('when both take it at once, the lower client id keeps it', () => {
    const { ann, bob, pause, resume } = room();
    ann.addElements([rect('r1')], { select: false });
    pause();
    ann.select(['r1']);
    bob.select(['r1']);
    expect([ann.selection, bob.selection]).toEqual([['r1'], ['r1']]);
    resume();
    expect(ann.selection).toEqual(['r1']);
    expect(bob.selection).toEqual([]);
    expect(bob.lockedBy('r1')?.name).toBe('Ann');
    expect(ann.lockedBy('r1')).toBeNull();
  });

  it('undo that would change an element Bob holds is refused and kept for later', () => {
    const { ann, bob, blocked } = room();
    ann.addElements([rect('r1')], { select: false });
    ann.updateElements(['r1'], { x: 40 });
    bob.select(['r1']);
    ann.undo();
    expect(blocked).toHaveBeenCalledWith(['r1']);
    expect(bob.scene.get('r1')).toMatchObject({ x: 40 });
    expect(ann.canUndo).toBe(true);
    bob.clearSelection();
    ann.undo();
    expect(bob.scene.get('r1')).toMatchObject({ x: 0 });
  });

  it('with lock: false nothing is locked', () => {
    const { ann, bob } = room({ lock: false });
    ann.addElements([rect('r1')], { select: false });
    bob.select(['r1']);
    ann.select(['r1']);
    expect(ann.selection).toEqual(['r1']);
  });
});

describe("lock: 'editing'", () => {
  it('locks only the text someone is typing in', () => {
    const da = new Y.Doc();
    const db = new Y.Doc();
    const aa = new Awareness(da);
    const ab = new Awareness(db);
    for (const [from, to] of [
      [aa, ab],
      [ab, aa],
    ] as const)
      from.on(
        'update',
        ({ added, updated, removed }: Record<string, number[]>, origin: unknown) => {
          if (origin !== 'relay')
            applyAwarenessUpdate(
              to,
              encodeAwarenessUpdate(from, [...added!, ...updated!, ...removed!]),
              'relay',
            );
        },
      );
    const listeners = new Set<() => void>();
    const typist = {
      pointer: null,
      selection: ['r1'] as string[],
      editing: null as string | null,
      on: (_: string, l: () => void) => (listeners.add(l), () => listeners.delete(l)),
    } satisfies PresenceEditor;
    const theirs = new YjsPresence(typist, ab, { user: { name: 'Bob', color: 'blue' } });
    const ann = new BoardEditor();
    const session = collaborate(ann, da, { awareness: aa, lock: 'editing' });
    cleanup.push(() => {
      session.destroy();
      theirs.destroy();
      aa.destroy();
      ab.destroy();
      ann.destroy();
    });
    for (const l of listeners) l();
    expect(ann.lockedBy('r1')).toBeNull(); // only selected
    typist.editing = 'r1';
    for (const l of listeners) l();
    expect(ann.lockedBy('r1')?.name).toBe('Bob');
  });
});
