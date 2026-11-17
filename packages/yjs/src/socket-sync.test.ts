import { describe, expect, it, vi } from 'vitest';
import { FakeServer, FakeSocket } from './testing/fake-socket';
import { SocketSync } from './socket-sync';

const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out: ${what}`);
};

function participant(server: FakeServer, name: string, board = 'b') {
  const socket = new FakeSocket(server, name);
  const sync = new SocketSync(socket, board, { flushMs: 10 });
  socket.connect();
  return { socket, sync, map: sync.doc.getMap<number>('m') };
}

describe('SocketSync', () => {
  it('loads what is saved, then syncs live both ways', async () => {
    const server = new FakeServer();
    const a = participant(server, 'a');
    await until(() => a.sync.status === 'synced', 'a synced');
    expect(a.sync.isLoaded).toBe(true);
    a.map.set('x', 1);
    const b = participant(server, 'b');
    await until(() => b.map.get('x') === 1, 'b loads x');
    b.map.set('y', 2);
    await until(() => a.map.get('y') === 2, 'a sees y');
  });

  it('batches quick local changes into one message', async () => {
    const server = new FakeServer();
    const a = participant(server, 'a');
    await until(() => a.sync.status === 'synced', 'synced');
    for (let i = 0; i < 20; i++) a.map.set('x', i); // a drag: many small changes
    await until(() => server.received > 0, 'sent');
    await new Promise((r) => setTimeout(r, 30));
    expect(server.received).toBe(1);
  });

  it('sends changes made offline when back, and nothing extra otherwise', async () => {
    const server = new FakeServer();
    const a = participant(server, 'a');
    const b = participant(server, 'b');
    await until(() => a.sync.status === 'synced' && b.sync.status === 'synced', 'synced');
    b.socket.disconnect();
    expect(b.sync.status).toBe('offline');
    b.map.set('offline', 1);
    a.map.set('online', 2);
    await until(() => server.received === 1, 'a sent');
    b.socket.connect();
    await until(() => a.map.get('offline') === 1 && b.map.get('online') === 2, 'merged');
    expect(server.received).toBe(2);
    // A reconnect with nothing new sends nothing.
    b.socket.disconnect();
    b.socket.connect();
    await until(() => b.sync.status === 'synced', 'synced again');
    await new Promise((r) => setTimeout(r, 30));
    expect(server.received).toBe(2);
  });

  it.each(['update', 'delete'])(
    'recovers a lost %s after reconnecting without new local edits',
    async (kind) => {
      const server = new FakeServer();
      const a = participant(server, 'a');
      const b = participant(server, 'b');
      try {
        await until(() => a.sync.status === 'synced' && b.sync.status === 'synced', 'synced');
        a.map.set('x', 1);
        await until(() => b.map.get('x') === 1, 'initial value delivered');

        const handle = server.handle.bind(server);
        let dropped = false;
        const delivery = vi.spyOn(server, 'handle').mockImplementation((from, event, args) => {
          if (from === a.socket && event === 'board:update' && !dropped) {
            dropped = true; // Sent by the client, but lost before the server receives it.
            return;
          }
          return handle(from, event, args);
        });
        if (kind === 'delete') a.map.delete('x');
        else a.map.set('x', 2);
        await until(() => dropped, 'update lost in transit');
        expect(b.map.get('x')).toBe(1);
        delivery.mockRestore();

        a.socket.disconnect();
        a.socket.connect();
        await until(() => a.sync.status === 'synced', 'reconnected');
        await until(
          () => (kind === 'delete' ? !b.map.has('x') : b.map.get('x') === 2),
          'lost change recovered',
        );

        // Later edits must also arrive: a missing Yjs clock must not leave them pending.
        a.map.set('after-reconnect', 3);
        await until(() => b.map.get('after-reconnect') === 3, 'subsequent edit delivered');
      } finally {
        a.sync.destroy();
        b.sync.destroy();
      }
    },
  );

  it('reports a read-only user from the join reply', async () => {
    const server = new FakeServer();
    server.viewers.add('viewer');
    const v = participant(server, 'viewer');
    let calls = 0;
    v.sync.subscribe(() => calls++);
    await until(() => v.sync.status === 'synced', 'synced');
    expect(v.sync.readOnly).toBe(true);
    expect(calls).toBeGreaterThan(0);
  });

  it('shows a newcomer everyone present right away', async () => {
    const server = new FakeServer();
    const a = participant(server, 'a');
    a.sync.awareness.setLocalStateField('user', { name: 'Ann' });
    await until(() => a.sync.status === 'synced', 'a synced');
    const b = participant(server, 'b');
    b.sync.awareness.setLocalStateField('user', { name: 'Bob' });
    await until(
      () => b.sync.awareness.getStates().has(a.sync.doc.clientID),
      'b sees ann without her moving',
    );
    a.sync.destroy();
    await until(() => !b.sync.awareness.getStates().has(a.sync.doc.clientID), 'ann left');
  });
});
