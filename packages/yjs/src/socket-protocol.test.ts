import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { FakeServer, FakeSocket } from './testing/fake-socket';
import { SocketSync } from './socket-sync';

const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out: ${what}`);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const syncs: SocketSync[] = [];
function participant(server: FakeServer, name: string, connect = true) {
  const socket = new FakeSocket(server, name);
  const sync = new SocketSync(socket, 'b', { flushMs: 5, timeoutMs: 200 });
  syncs.push(sync);
  if (connect) socket.connect();
  return { socket, sync, map: () => sync.doc.getMap<unknown>('m') };
}

afterEach(() => {
  for (const s of syncs.splice(0)) s.destroy();
  vi.restoreAllMocks();
});

describe('SocketSync protocol', () => {
  it('a rejoin exchanges only what each side lacks, not the whole board', async () => {
    const server = new FakeServer();
    const a = participant(server, 'a');
    await until(() => a.sync.status === 'synced', 'synced');
    a.map().set('big', 'x'.repeat(50_000));
    await until(() => server.received === 1, 'saved');
    const before = server.joinBytes;
    a.socket.disconnect();
    a.socket.connect();
    await until(() => a.sync.status === 'synced', 'synced again');
    expect(server.joinBytes - before).toBeLessThan(100);
  });

  it('still converges with a server that sends no state vector', async () => {
    const server = new FakeServer();
    server.omitStateVector = true;
    const a = participant(server, 'a');
    const b = participant(server, 'b');
    await until(() => a.sync.status === 'synced' && b.sync.status === 'synced', 'synced');
    b.socket.disconnect();
    b.map().set('offline', 1);
    b.socket.connect();
    await until(() => a.map().get('offline') === 1, 'merged');
  });

  it('a viewer sends no changes, not even offline ones', async () => {
    const server = new FakeServer();
    server.viewers.add('v');
    const v = participant(server, 'v');
    await until(() => v.sync.status === 'synced', 'synced');
    expect(v.sync.readOnly).toBe(true);
    v.socket.disconnect();
    v.map().set('x', 1);
    v.socket.connect();
    await until(() => v.sync.status === 'synced', 'rejoined');
    v.map().set('y', 2);
    await wait(30);
    expect(server.received).toBe(0);
    expect(v.sync.status).toBe('synced'); // nothing was refused: nothing was sent
  });

  it('stops with `denied` when the server refuses to let the user in', async () => {
    const server = new FakeServer();
    server.denied.add('x');
    const join = vi.spyOn(server, 'handle');
    const x = participant(server, 'x');
    await until(() => x.sync.status === 'denied', 'denied');
    expect(x.sync.error).toBe('forbidden');
    x.socket.disconnect();
    x.socket.connect();
    await wait(30);
    expect(x.sync.status).toBe('denied');
    expect(join).toHaveBeenCalledTimes(1); // no retries
  });

  it('drops its copy and loads the board again when a change is refused', async () => {
    const server = new FakeServer();
    const a = participant(server, 'a');
    await until(() => a.sync.status === 'synced', 'synced');
    a.map().set('ok', 1);
    await until(() => server.received === 1, 'saved');
    server.reject = (update) => {
      const probe = new Y.Doc(); // a copy of the board with the change applied
      Y.applyUpdate(probe, server.board('b'));
      Y.applyUpdate(probe, update);
      return probe.getMap('m').has('bad') ? 'invalid element' : null;
    };
    const firstDoc = a.sync.doc;
    a.map().set('bad', 1);
    await until(() => a.sync.doc !== firstDoc, 'reset');
    expect(a.sync.error).toBe('invalid element');
    await until(() => a.sync.status === 'synced', 'rejoined');
    expect(a.map().get('ok')).toBe(1); // the board as the server has it
    expect(a.map().has('bad')).toBe(false); // without the refused change
    expect(server.received).toBe(1); // nothing of the refused copy was sent again
    a.map().set('later', 2);
    await until(() => server.received === 2, 'editing goes on');
  });

  it('ignores a malformed join answer and retries', async () => {
    const server = new FakeServer();
    const handle = server.handle.bind(server);
    let broken = true;
    vi.spyOn(server, 'handle').mockImplementation((from, event, args) => {
      if (event === 'board:join' && broken) {
        broken = false;
        return { update: 'not bytes' };
      }
      return handle(from, event, args);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const a = participant(server, 'a');
    await until(() => a.sync.status === 'synced', 'synced after retry');
  });

  it('tells when changes are confirmed by the server', async () => {
    const server = new FakeServer();
    const a = participant(server, 'a');
    await until(() => a.sync.status === 'synced', 'synced');
    a.map().set('x', 1);
    expect(a.sync.hasUnsavedChanges).toBe(true);
    await until(() => !a.sync.hasUnsavedChanges, 'confirmed');
    expect(server.received).toBe(1);
  });

  it('sends cursor-only presence volatile, everything else reliably; leaves on destroy', async () => {
    const server = new FakeServer();
    const a = participant(server, 'a');
    await until(() => a.sync.status === 'synced', 'synced');
    const state = (cursor: unknown, selection: string[]) =>
      a.sync.awareness.setLocalState({
        user: { name: 'Ann', color: '#f00' },
        board: { cursor, selection, editing: null },
      });
    state({ x: 0, y: 0 }, []);
    state({ x: 1, y: 1 }, []);
    state({ x: 2, y: 2 }, []);
    expect(a.socket.volatileSent.get('board:awareness')).toBe(2);
    state({ x: 2, y: 2 }, ['s1']); // a selection: must not be lost
    expect(a.socket.volatileSent.get('board:awareness')).toBe(2);
    expect(a.socket.rooms.has('b')).toBe(true);
    a.sync.destroy();
    await until(() => !a.socket.rooms.has('b'), 'left the room');
  });
});
