import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import * as Y from 'yjs';
import { BOARD_EVENTS, type BoardEvents, type BoardRole, type BoardSocket } from './protocol';
import { isBytes, joinAccepted, replyError, toBytes } from './wire';

/**
 * - `connecting`: (re)joining the board;
 * - `synced`: up to date and live;
 * - `offline`: no connection (editing goes on, changes are sent when it is back);
 * - `denied`: the server refused to let this user in (see `error`); the sync has stopped.
 */
export type SyncStatus = 'connecting' | 'synced' | 'offline' | 'denied';

export interface SocketSyncOptions {
  /** Local changes made within this many ms go out as one message (default 30). */
  flushMs?: number;
  /** How long to wait for an answer to `board:join` or `board:update`, ms (default 10 s). */
  timeoutMs?: number;
  /** Names of the events, if your server uses other ones (see `BOARD_EVENTS`). */
  events?: Partial<BoardEvents>;
  /**
   * Makes the document (default `new Y.Doc()`), e.g. `() => new Y.Doc({ gc: false })` to
   * keep deleted content for versions. Called again when the server refused a change and
   * the board is loaded anew.
   */
  createDoc?: () => Y.Doc;
}

/** Changes and presence that came from the server: applied, never sent back. */
const REMOTE = Symbol('remote');
/** Two bytes: a Yjs update that changes nothing. */
const EMPTY_UPDATE = 2;
/** Retries of a failed join wait 1 s, 2 s, 4 s… up to this. */
const MAX_RETRY_MS = 15_000;

/**
 * Keeps a Yjs document and its presence in step with your server over a socket.io socket
 * (see `protocol.ts` for what the server has to do).
 *
 * - On every (re)connection it joins the board and exchanges state vectors: each side sends
 *   only what the other lacks (e.g. changes made offline). Offline, nothing is queued.
 * - Local changes go out in small batches; the server confirms each (`hasUnsavedChanges`).
 *   A refused change (rights, limits, invalid content) makes the sync drop its copy of the
 *   board and load it again: `doc` and `awareness` are then new objects (`subscribe` tells).
 * - A viewer (`role: 'view'`) never sends changes, not even offline ones on reconnect.
 * - Cursor-only presence changes are sent volatile; this user's presence is withdrawn on
 *   `destroy`.
 *
 * Usually used through `syncBoard` (or `useSocketSync` in React), which also binds the doc
 * to an editor.
 */
export class SocketSync {
  private docValue: Y.Doc;
  private awarenessValue: Awareness;
  private statusValue: SyncStatus = 'connecting';
  private roleValue: BoardRole = 'edit';
  private errorValue: string | null = null;
  private loaded = false;
  private destroyed = false;
  /** Local changes not sent yet. */
  private pending: Uint8Array[] = [];
  /** Sent changes the server hasn't confirmed yet. */
  private unconfirmed = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  /** Bumped by every (re)join and disconnect: answers of older runs are ignored. */
  private joinRun = 0;
  /** This user's presence as last sent, without the cursor (to tell cursor-only changes). */
  private lastPresence = '';
  private readonly listeners = new Set<() => void>();
  private readonly flushMs: number;
  private readonly timeoutMs: number;
  private readonly events: BoardEvents;
  private readonly createDoc: () => Y.Doc;

  constructor(
    private readonly socket: BoardSocket,
    readonly boardId: string,
    options: SocketSyncOptions = {},
  ) {
    this.flushMs = options.flushMs ?? 30;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.events = { ...BOARD_EVENTS, ...options.events };
    this.createDoc = options.createDoc ?? (() => new Y.Doc());
    this.docValue = this.createDoc();
    this.awarenessValue = new Awareness(this.docValue);
    this.attachDoc();
    socket.on('connect', this.join);
    socket.on('disconnect', this.onDisconnect);
    socket.on(this.events.update, this.onRemoteUpdate);
    socket.on(this.events.awareness, this.onRemoteAwareness);
    if (socket.connected) void this.join();
    else this.setStatus('offline');
  }

  /** The board's document. A new one after the board was loaded anew (see `subscribe`). */
  get doc(): Y.Doc {
    return this.docValue;
  }

  /** Presence of everyone on the board; replaced together with `doc`. */
  get awareness(): Awareness {
    return this.awarenessValue;
  }

  get status(): SyncStatus {
    return this.statusValue;
  }

  /** What the server lets this user do (from its join reply). */
  get role(): BoardRole {
    return this.roleValue;
  }

  /** The server said this user may only look. */
  get readOnly(): boolean {
    return this.roleValue === 'view';
  }

  /** The board has arrived from the server (until then the doc is empty). */
  get isLoaded(): boolean {
    return this.loaded;
  }

  /** Why the server refused joining (`denied`) or the last change; cleared once a change is accepted. */
  get error(): string | null {
    return this.errorValue;
  }

  /** Local changes the server hasn't confirmed yet (for a "saving…" indicator). */
  get hasUnsavedChanges(): boolean {
    return this.pending.length > 0 || this.unconfirmed > 0;
  }

  /** Called when any of the state above changes, including a new `doc`. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Sends what's pending, withdraws this user's presence, leaves the board and stops. */
  destroy(): void {
    if (this.destroyed) return;
    this.flush();
    // Sent (the origin isn't REMOTE), so the others drop this user's cursor right away.
    removeAwarenessStates(this.awarenessValue, [this.docValue.clientID], 'destroy');
    if (this.socket.connected) this.socket.emit(this.events.leave, this.boardId);
    this.destroyed = true;
    this.joinRun++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const s = this.socket;
    s.off('connect', this.join);
    s.off('disconnect', this.onDisconnect);
    s.off(this.events.update, this.onRemoteUpdate);
    s.off(this.events.awareness, this.onRemoteAwareness);
    this.detachDoc();
    this.awarenessValue.destroy();
    this.docValue.destroy();
    this.listeners.clear();
  }

  private setStatus(status: SyncStatus): void {
    if (status === this.statusValue) return;
    this.statusValue = status;
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.error('apeiro: a SocketSync listener failed', error);
      }
    }
  }

  private attachDoc(): void {
    this.docValue.on('update', this.onLocalUpdate);
    this.awarenessValue.on('update', this.onLocalAwareness);
  }

  private detachDoc(): void {
    this.docValue.off('update', this.onLocalUpdate);
    this.awarenessValue.off('update', this.onLocalAwareness);
  }

  // --- Joining ------------------------------------------------------------------------

  private readonly join = async (): Promise<void> => {
    if (this.destroyed || this.statusValue === 'denied') return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const run = ++this.joinRun;
    this.setStatus('connecting');
    let reply: unknown;
    try {
      reply = await this.socket
        .timeout(this.timeoutMs)
        .emitWithAck(this.events.join, this.boardId, Y.encodeStateVector(this.docValue));
    } catch {
      if (run === this.joinRun) this.retryJoin();
      return;
    }
    if (run !== this.joinRun || this.destroyed) return;

    const refused = replyError(reply);
    if (refused !== null) {
      this.errorValue = refused;
      this.statusValue = 'denied';
      this.notify();
      return;
    }
    const accepted = joinAccepted(reply);
    if (!accepted || !this.applyRemote(accepted.update)) {
      console.warn('apeiro: malformed answer to board:join, retrying');
      this.retryJoin();
      return;
    }
    this.retries = 0;
    this.roleValue = accepted.role;
    // What was waiting is in the doc: the reconciliation below covers it.
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.pending = [];
    this.unconfirmed = 0;
    // Always reconcile: an update sent before may have been lost on the way, although
    // nothing is waiting here. A viewer sends nothing at all.
    if (accepted.role === 'edit') {
      const missing = accepted.stateVector
        ? Y.encodeStateAsUpdate(this.docValue, accepted.stateVector)
        : Y.encodeStateAsUpdate(this.docValue);
      if (missing.byteLength > EMPTY_UPDATE) this.send(missing);
    }
    this.loaded = true;
    this.statusValue = 'synced';
    this.lastPresence = '';
    this.announce();
    this.notify();
  };

  private retryJoin(): void {
    if (this.destroyed || !this.socket.connected) return;
    const wait = Math.min(1000 * 2 ** this.retries++, MAX_RETRY_MS);
    this.retryTimer = setTimeout(() => void this.join(), wait);
  }

  private readonly onDisconnect = (): void => {
    this.joinRun++;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.flushTimer = null;
    this.retryTimer = null;
    // Not lost: the doc has them, and the next join sends what the server lacks.
    this.pending = [];
    this.unconfirmed = 0;
    if (this.statusValue !== 'denied') this.setStatus('offline');
  };

  /**
   * The server refused a change: this copy of the board no longer matches everyone else's.
   * Start over with a new, empty document and join again to get the board as it is.
   */
  private reset(reason: string): void {
    if (this.destroyed) return;
    this.joinRun++;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.pending = [];
    this.unconfirmed = 0;
    removeAwarenessStates(this.awarenessValue, [this.docValue.clientID], 'reset');
    this.detachDoc();
    const old = this.docValue;
    this.awarenessValue.destroy();
    this.docValue = this.createDoc();
    this.awarenessValue = new Awareness(this.docValue);
    this.attachDoc();
    this.loaded = false;
    this.errorValue = reason;
    this.statusValue = this.socket.connected ? 'connecting' : 'offline';
    this.notify(); // the binding moves to the new doc here
    old.destroy();
    if (this.socket.connected) void this.join();
  }

  // --- The document -------------------------------------------------------------------

  /** Applies bytes from the server; false if they are not a valid update. */
  private applyRemote(update: Uint8Array): boolean {
    try {
      Y.applyUpdate(this.docValue, update, REMOTE);
      return true;
    } catch (error) {
      console.warn('apeiro: invalid update from the server', error);
      return false;
    }
  }

  private readonly onLocalUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === REMOTE || this.roleValue === 'view') return;
    // Not synced: the next join sends it (from the doc), nothing is queued meanwhile.
    if (this.statusValue !== 'synced') return;
    this.pending.push(update);
    this.flushTimer ??= setTimeout(() => this.flush(), this.flushMs);
    if (this.pending.length === 1 && this.unconfirmed === 0) this.notify();
  };

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.pending.length === 0) return;
    const update = this.pending.length === 1 ? this.pending[0]! : Y.mergeUpdates(this.pending);
    this.pending = [];
    this.send(update);
  }

  /** Sends an update and waits for the server's verdict. */
  private send(update: Uint8Array): void {
    const run = this.joinRun;
    this.unconfirmed++;
    this.socket
      .timeout(this.timeoutMs)
      .emitWithAck(this.events.update, this.boardId, update)
      .then(
        (reply) => {
          if (run !== this.joinRun || this.destroyed) return;
          const refused = replyError(reply);
          if (refused !== null) {
            this.reset(refused);
            return;
          }
          if (this.errorValue !== null) {
            this.errorValue = null;
            this.notify();
          }
          this.confirmed();
        },
        // No answer in time (or a server that doesn't answer): the next join reconciles.
        () => {
          if (run === this.joinRun && !this.destroyed) this.confirmed();
        },
      );
  }

  private confirmed(): void {
    this.unconfirmed = Math.max(0, this.unconfirmed - 1);
    if (this.unconfirmed === 0 && this.pending.length === 0) this.notify();
  }

  private readonly onRemoteUpdate = (boardId: unknown, update: unknown): void => {
    if (boardId !== this.boardId || this.destroyed || !this.loaded || !isBytes(update)) return;
    // A broken update would leave this copy behind: join again, the state vectors catch up.
    if (!this.applyRemote(toBytes(update)) && this.socket.connected) void this.join();
  };

  // --- Presence -----------------------------------------------------------------------

  /** Sends this user's presence (cursor, selection, name) as it is now. */
  private announce(): void {
    if (this.awarenessValue.getLocalState() === null) return;
    this.socket.emit(
      this.events.awareness,
      this.boardId,
      encodeAwarenessUpdate(this.awarenessValue, [this.docValue.clientID]),
    );
  }

  private readonly onLocalAwareness = (
    { added, updated, removed }: Record<'added' | 'updated' | 'removed', number[]>,
    origin: unknown,
  ): void => {
    if (origin === REMOTE || !this.socket.connected || !this.loaded) return;
    const ids = [...added, ...updated, ...removed];
    const message = encodeAwarenessUpdate(this.awarenessValue, ids);
    const own = this.docValue.clientID;
    const presence = presenceWithoutCursor(this.awarenessValue.getLocalState());
    const cursorOnly =
      ids.length === 1 && ids[0] === own && removed.length === 0 && presence === this.lastPresence;
    this.lastPresence = presence;
    // A lost cursor position is replaced by the next one; selections and names are not.
    const channel = cursorOnly && this.socket.volatile ? this.socket.volatile : this.socket;
    channel.emit(this.events.awareness, this.boardId, message);
  };

  private readonly onRemoteAwareness = (boardId: unknown, update: unknown): void => {
    if (boardId !== this.boardId || this.destroyed || !isBytes(update)) return;
    const before = new Set(this.awarenessValue.getStates().keys());
    try {
      applyAwarenessUpdate(this.awarenessValue, toBytes(update), REMOTE);
    } catch (error) {
      console.warn('apeiro: invalid presence from the server', error);
      return;
    }
    // Someone new: they don't know about this user yet (the server keeps no presence).
    for (const id of this.awarenessValue.getStates().keys()) {
      if (!before.has(id) && id !== this.docValue.clientID) {
        this.announce();
        break;
      }
    }
  };
}

/** A presence state as text, without the cursor that changes on every pointer move. */
function presenceWithoutCursor(state: Record<string, unknown> | null): string {
  if (!state) return '';
  const board = state.board as Record<string, unknown> | undefined;
  return JSON.stringify({ ...state, board: board ? { ...board, cursor: undefined } : board });
}
