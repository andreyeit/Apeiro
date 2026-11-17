import type { ShapeElement } from '@apeiro/core';
import { BoardEditor } from '@apeiro/editor';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { syncBoard, type BoardSync } from './sync-board';
import { FakeServer, FakeSocket } from './testing/fake-socket';

const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out: ${what}`);
};

const box = (id: string, x = 0): ShapeElement => ({
  id,
  type: 'rect',
  x,
  y: 0,
  w: 100,
  h: 100,
  rotation: 0,
  z: 0,
  fill: 0xffffffff,
  stroke: 0,
  strokeWidth: 0,
  radius: 0,
});

const open: Array<{ sync: BoardSync; editor: BoardEditor }> = [];
function client(server: FakeServer, name: string, initial: ShapeElement[] = []) {
  const editor = new BoardEditor();
  if (initial.length) editor.load(initial);
  const socket = new FakeSocket(server, name);
  const sync = syncBoard(editor, socket, 'board-1', { flushMs: 5, timeoutMs: 200 });
  socket.connect();
  open.push({ sync, editor });
  return { editor, socket, sync };
}

afterEach(() => {
  for (const { sync, editor } of open.splice(0)) {
    sync.destroy();
    editor.destroy();
  }
});

describe('syncBoard', () => {
  it('is read-only until the board arrives, then syncs two editors both ways', async () => {
    const server = new FakeServer();
    const a = client(server, 'a');
    expect(a.editor.readOnly).toBe(true);
    expect(a.sync.getState().loaded).toBe(false);
    await until(() => a.sync.getState().status === 'synced', 'a synced');
    expect(a.editor.readOnly).toBe(false);
    a.editor.addElements([box('s1')], { select: false }); // selected, it would be locked for b
    const b = client(server, 'b');
    await until(() => b.editor.scene.has('s1'), 'b loads s1');
    b.editor.updateElements(['s1'], { x: 50 });
    await until(
      () =>
        a.editor.scene.get('s1')?.type === 'rect' &&
        (a.editor.scene.get('s1') as ShapeElement).x === 50,
      'a sees the move',
    );
    expect(a.sync.getState().saving).toBe(false);
  });

  it('seeds an empty board with the editor’s content, never overrides an existing one', async () => {
    const server = new FakeServer();
    const a = client(server, 'a', [box('template')]);
    await until(() => server.received > 0, 'seed sent');
    const b = client(server, 'b', [box('mine')]);
    await until(() => b.sync.getState().loaded, 'b loaded');
    expect(b.editor.scene.has('template')).toBe(true);
    expect(b.editor.scene.has('mine')).toBe(false);
    expect(a.editor.scene.has('mine')).toBe(false);
  });

  it('keeps a viewer read-only', async () => {
    const server = new FakeServer();
    server.viewers.add('v');
    const v = client(server, 'v');
    await until(() => v.sync.getState().loaded, 'loaded');
    expect(v.sync.getState()).toMatchObject({ role: 'view', readOnly: true });
    expect(v.editor.readOnly).toBe(true);
  });

  it('starts over from the server’s board when a change is refused, with an empty history', async () => {
    const server = new FakeServer();
    const a = client(server, 'a');
    await until(() => a.sync.getState().status === 'synced', 'synced');
    a.editor.addElements([box('ok')]);
    await until(() => server.received === 1, 'saved');
    server.reject = (update) => {
      const probe = new Y.Doc();
      Y.applyUpdate(probe, server.board('board-1'));
      Y.applyUpdate(probe, update);
      return probe.getMap('board').has('bad') ? 'too many elements' : null;
    };
    a.editor.addElements([box('bad', 200)]);
    await until(() => a.sync.getState().error === 'too many elements', 'refused');
    await until(
      () => a.sync.getState().status === 'synced' && !a.editor.scene.has('bad'),
      'reloaded',
    );
    expect(a.editor.scene.has('ok')).toBe(true);
    expect(a.editor.canUndo).toBe(false);
    expect(server.received).toBe(1);
    server.reject = null;
    a.editor.addElements([box('next', 400)]);
    await until(() => server.received === 2, 'editing goes on');
    expect(a.sync.getState().error).toBeNull();
  });

  it('reports a refused join and leaves the editor read-only', async () => {
    const server = new FakeServer();
    server.denied.add('x');
    const x = client(server, 'x');
    const seen = vi.fn();
    x.sync.subscribe(seen);
    await until(() => x.sync.getState().status === 'denied', 'denied');
    expect(x.sync.getState().error).toBe('forbidden');
    expect(x.editor.readOnly).toBe(true);
    expect(seen).toHaveBeenCalled();
  });

  it('destroy gives the editor back: editable, with a local history', async () => {
    const server = new FakeServer();
    const a = client(server, 'a');
    await until(() => a.sync.getState().status === 'synced', 'synced');
    a.sync.destroy();
    expect(a.editor.readOnly).toBe(false);
    a.editor.addElements([box('local')]);
    expect(a.editor.canUndo).toBe(true);
  });
});
