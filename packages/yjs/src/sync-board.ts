import type { BoardEditor } from '@apeiro/editor';
import type * as Y from 'yjs';
import { collaborate, type Collaboration, type CollaborateOptions } from './collaborate';
import { DEFAULT_MAP_NAME } from './scene-binding';
import type { BoardRole, BoardSocket } from './protocol';
import { SocketSync, type SocketSyncOptions, type SyncStatus } from './socket-sync';

export interface BoardSyncOptions
  extends Omit<CollaborateOptions, 'awareness' | 'prefer' | 'map'>, SocketSyncOptions {
  /** Name of the doc's map that holds the elements (default `board`). */
  map?: string;
  /**
   * What happens to the editor's own content when the board on the server is empty:
   * `keep` (default) sends it to the server, e.g. a template for a new board; `discard`
   * clears it. Content of a board that exists on the server always wins.
   */
  initialContent?: 'keep' | 'discard';
}

/** A snapshot of the sync, for indicators ("offline", "saving…", "view only"). */
export interface BoardSyncState {
  status: SyncStatus;
  role: BoardRole;
  /** The board can't be changed here: a viewer's, or not loaded yet. */
  readOnly: boolean;
  /** The board has arrived from the server (until then the editor is read-only). */
  loaded: boolean;
  /** Changes not confirmed by the server yet. */
  saving: boolean;
  /** Why the server refused joining (status `denied`) or the last change (until one is accepted). */
  error: string | null;
}

export interface BoardSync {
  /** The sync's state now; the same object until something changes. */
  getState(): BoardSyncState;
  /** Called when the state changes. */
  subscribe(listener: () => void): () => void;
  /** The current session (scene binding, history, presence); null until loaded. */
  readonly collaboration: Collaboration | null;
  /** The transport, for advanced use. */
  readonly socketSync: SocketSync;
  /** The board's document now (a new one after a reset). */
  readonly doc: Y.Doc;
  /** Stops syncing; the editor keeps the board, becomes editable again and gets a local history. */
  destroy(): void;
}

/**
 * Shares `editor`'s board through your server over a socket.io socket (see `protocol.ts`
 * for what the server does): loads the saved board, sends this user's changes and cursor,
 * shows everyone else's, catches up after the connection drops, and starts over when the
 * server refuses a change. One call:
 *
 * ```ts
 * const socket = io({ transports: ['websocket'] }); // one socket per tab
 * const sync = syncBoard(editor, socket, boardId, { user: { name: 'Ann', color: '#e11d48' } });
 * sync.subscribe(() => showStatus(sync.getState()));
 * // leaving the board: sync.destroy()
 * ```
 *
 * The editor is read-only until the board has arrived (edits made into the empty board
 * would be merged into the real one) and for viewers (`role: 'view'`). Undo touches only
 * this user's edits; after a reset its history starts empty.
 */
export function syncBoard(
  editor: BoardEditor,
  socket: BoardSocket,
  boardId: string,
  options: BoardSyncOptions = {},
): BoardSync {
  const { flushMs, timeoutMs, events, createDoc, initialContent = 'keep', ...collab } = options;
  const sync = new SocketSync(socket, boardId, {
    ...(flushMs !== undefined ? { flushMs } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(events ? { events } : {}),
    ...(createDoc ? { createDoc } : {}),
  });
  const wasReadOnly = editor.readOnly;
  const listeners = new Set<() => void>();
  let session: Collaboration | null = null;
  let boundDoc: Y.Doc | null = null;
  /** After a reset the editor's content is what the server refused: never send it again. */
  let resetOnce = false;
  let destroyed = false;
  let state = read();

  function read(): BoardSyncState {
    const loaded = sync.isLoaded;
    return {
      status: sync.status,
      role: sync.role,
      readOnly: !loaded || sync.readOnly,
      loaded,
      saving: sync.hasUnsavedChanges,
      error: sync.error,
    };
  }

  const unbind = () => {
    session?.destroy();
    session = null;
    boundDoc = null;
  };

  const update = () => {
    if (destroyed) return;
    if (boundDoc && boundDoc !== sync.doc) {
      // The server refused a change: drop the session with its history, wait for the board.
      unbind();
      resetOnce = true;
    }
    if (!session && sync.isLoaded) {
      const docEmpty = sync.doc.getMap(mapName(collab.map)).size === 0;
      if (docEmpty && (resetOnce || initialContent === 'discard')) editor.load([]);
      session = collaborate(editor, sync.doc, {
        ...collab,
        awareness: sync.awareness,
        prefer: 'doc',
      });
      boundDoc = sync.doc;
    }
    const next = read();
    editor.setReadOnly(next.readOnly || wasReadOnly);
    if (!sameState(state, next)) {
      state = next;
      for (const listener of [...listeners]) listener();
    }
  };

  const off = sync.subscribe(update);
  update();

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get collaboration() {
      return session;
    },
    socketSync: sync,
    get doc() {
      return sync.doc;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      off();
      unbind();
      sync.destroy();
      listeners.clear();
      if (!editor.isDestroyed) editor.setReadOnly(wasReadOnly);
    },
  };
}

const mapName = (map: string | undefined): string => map ?? DEFAULT_MAP_NAME;

function sameState(a: BoardSyncState, b: BoardSyncState): boolean {
  return (
    a.status === b.status &&
    a.role === b.role &&
    a.readOnly === b.readOnly &&
    a.loaded === b.loaded &&
    a.saving === b.saving &&
    a.error === b.error
  );
}
