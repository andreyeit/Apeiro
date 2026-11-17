// In-memory server and socket of the board sync protocol, for tests (not exported by the package).
import * as Y from 'yjs';
import { BOARD_EVENTS, type BoardSocket, type BoardUpdateReply } from '../protocol';

type Listener = (...args: never[]) => void;

/**
 * The server side of `protocol.ts` in memory, as a backend would write it: keeps every
 * update of a board, answers joins with what the client lacks, refuses viewers' and
 * `reject`ed updates, forwards updates and presence to the room.
 */
export class FakeServer {
  readonly saved = new Map<string, Uint8Array[]>();
  readonly sockets = new Set<FakeSocket>();
  /** Updates accepted from clients. */
  received = 0;
  /** Bytes of updates sent to joining clients (to check that joins send only diffs). */
  joinBytes = 0;
  /** Names of users who may only look. */
  viewers = new Set<string>();
  /** Names of users who may not join. */
  denied = new Set<string>();
  /** Refuses an update when this returns an error text (validation, limits). */
  reject: ((update: Uint8Array) => string | null) | null = null;
  /** Join answers without the server's state vector (an older server). */
  omitStateVector = false;

  board(boardId: string): Uint8Array {
    return Y.mergeUpdates(this.saved.get(boardId) ?? []);
  }

  handle(from: FakeSocket, event: string, args: unknown[]): unknown {
    const [boardId] = args as [string];
    if (event === BOARD_EVENTS.join) {
      if (this.denied.has(from.name)) return { error: 'forbidden' };
      from.rooms.add(boardId);
      const merged = this.board(boardId);
      const diff = Y.diffUpdate(merged, args[1] as Uint8Array);
      this.joinBytes += diff.byteLength;
      return {
        update: diff,
        ...(this.omitStateVector ? {} : { stateVector: Y.encodeStateVectorFromUpdate(merged) }),
        role: this.viewers.has(from.name) ? 'view' : 'edit',
      };
    }
    if (event === BOARD_EVENTS.leave) {
      from.rooms.delete(boardId);
      return undefined;
    }
    if (!from.rooms.has(boardId)) return { error: 'not joined' };
    const data = args[1] as Uint8Array;
    if (event === BOARD_EVENTS.update) {
      if (this.viewers.has(from.name)) return { error: 'viewer' } satisfies BoardUpdateReply;
      const problem = this.reject?.(data) ?? null;
      if (problem) return { error: problem } satisfies BoardUpdateReply;
      this.received++;
      this.saved.set(boardId, [...(this.saved.get(boardId) ?? []), data]); // saved first…
    }
    for (const s of this.sockets) {
      // …then sent to the room.
      if (s !== from && s.connected && s.rooms.has(boardId)) s.deliver(event, [boardId, data]);
    }
    return event === BOARD_EVENTS.update ? ({ ok: true } satisfies BoardUpdateReply) : undefined;
  }
}

/** A socket.io-like client socket, delivering asynchronously like a network. */
export class FakeSocket implements BoardSocket {
  connected = false;
  readonly rooms = new Set<string>();
  /** Messages sent volatile, by event. */
  readonly volatileSent = new Map<string, number>();
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(
    private readonly server: FakeServer,
    readonly name: string,
  ) {
    server.sockets.add(this);
  }

  readonly volatile = {
    emit: (event: string, ...args: unknown[]) => {
      this.volatileSent.set(event, (this.volatileSent.get(event) ?? 0) + 1);
      return this.emit(event, ...args);
    },
  };

  on(event: string, listener: Listener) {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return this;
  }
  off(event: string, listener: Listener) {
    this.listeners.get(event)?.delete(listener);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    if (!this.connected) return this;
    const copy = args.map((a) => (a instanceof Uint8Array ? a.slice() : a));
    setTimeout(() => this.server.handle(this, event, copy), 0);
    return this;
  }
  timeout() {
    return {
      emitWithAck: (event: string, ...args: unknown[]) =>
        new Promise((resolve, reject) =>
          setTimeout(() => {
            if (!this.connected) reject(new Error('disconnected'));
            else resolve(this.server.handle(this, event, args));
          }, 0),
        ),
    };
  }
  /** Delivers a message from the server. */
  deliver(event: string, args: unknown[]) {
    setTimeout(() => {
      if (!this.connected) return;
      for (const l of this.listeners.get(event) ?? []) (l as (...a: unknown[]) => void)(...args);
    }, 0);
  }
  connect() {
    this.connected = true;
    for (const l of this.listeners.get('connect') ?? []) (l as () => void)();
  }
  disconnect() {
    this.connected = false;
    this.rooms.clear();
    for (const l of this.listeners.get('disconnect') ?? []) (l as () => void)();
  }
}
