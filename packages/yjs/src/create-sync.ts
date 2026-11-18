import type { BoardEditor, BoardSync, SyncState } from '@apeiro/editor';
import type * as Y from 'yjs';
import { collaborate, type Collaboration, type CollaborateOptions } from './collaborate';
import type { AwarenessLike } from './presence';
import type { BoardSocket } from './protocol';
import { DEFAULT_MAP_NAME } from './scene-binding';
import { SocketSync, type SocketSyncOptions } from './socket-sync';

/** Options of both kinds of sync: how the board is shared with the others. */
export interface SyncOptions extends Omit<CollaborateOptions, 'awareness' | 'prefer' | 'map'> {
  /** Name of the doc's map that holds the elements (default `board`). */
  map?: string;
}

/** A board shared through your server over a socket.io socket (see `BOARD_EVENTS`). */
export interface SocketSyncSource extends SyncOptions, SocketSyncOptions {
  /** A socket.io client socket; one per tab is enough for any number of boards. */
  socket: BoardSocket;
  boardId: string;
  /**
   * What happens to the editor's own content when the board on the server is empty:
   * `keep` (default) sends it to the server, e.g. a template for a new board (such as
   * `initialElements`); `discard` clears it. Content of a board on the server always wins.
   */
  initialContent?: 'keep' | 'discard';
}

/** A board in a Yjs document of any provider (y-websocket, Hocuspocus, y-webrtc…). */
export interface DocSyncSource extends SyncOptions {
  doc: Y.Doc;
  /** The provider's awareness (`provider.awareness`): cursors and selections of others. */
  awareness?: AwarenessLike | null;
}

export type CreateSyncOptions = SocketSyncSource | DocSyncSource;

/** A shared board backed by Yjs. */
export interface YjsBoardSync extends BoardSync {
  /** The board's document now (with a socket: a new one after the server refused a change). */
  readonly doc: Y.Doc;
}

/**
 * Shares a board with others. Framework-free: create it in your logic, show it with
 * `<Board sync={sync}>` (React) or `sync.attach(editor)`, read `getState()` for
 * indicators, and `destroy()` it when leaving the board.
 *
 * ```ts
 * // your server over socket.io: loads the saved board, sends changes and cursors,
 * // catches up after the connection drops
 * const sync = createSync({ socket, boardId: 'b1', user: { name: 'Ann', color: '#e11d48' } });
 * // or any Yjs provider
 * const sync = createSync({ doc, awareness: provider.awareness, user });
 * ```
 *
 * Undo touches only this user's edits; others' cursors and selections show on the board.
 */
export function createSync(options: CreateSyncOptions): YjsBoardSync {
  return 'socket' in options ? socketSync(options) : docSync(options);
}

const SYNCED: SyncState = {
  status: 'synced',
  role: 'edit',
  readOnly: false,
  loaded: true,
  saving: false,
  error: null,
};

function docSync({ doc, awareness, map, ...options }: DocSyncSource): YjsBoardSync {
  let session: Collaboration | null = null;
  let destroyed = false;
  const detach = () => {
    session?.destroy();
    session = null;
  };
  return {
    doc,
    getState: () => SYNCED,
    subscribe: () => () => undefined,
    attach(editor) {
      checkAttach(destroyed, session !== null);
      const current = collaborate(editor, doc, {
        ...options,
        ...(map !== undefined ? { map } : {}),
        awareness: awareness ?? null,
      });
      session = current;
      return () => {
        if (session === current) detach();
      };
    },
    destroy() {
      destroyed = true;
      detach();
    },
  };
}

function socketSync(options: SocketSyncSource): YjsBoardSync {
  const {
    socket,
    boardId,
    flushMs,
    timeoutMs,
    events,
    createDoc,
    initialContent = 'keep',
    ...collab
  } = options;
  const transport = new SocketSync(socket, boardId, {
    ...(flushMs !== undefined ? { flushMs } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(events ? { events } : {}),
    ...(createDoc ? { createDoc } : {}),
  });
  const listeners = new Set<() => void>();
  let editor: BoardEditor | null = null;
  /** The editor's own read-only flag when attached, given back on detach. */
  let editorReadOnly = false;
  let session: Collaboration | null = null;
  let doc = transport.doc;
  /** After a reset the editor's content is what the server refused: never send it again. */
  let resetOnce = false;
  let destroyed = false;
  let state = read();

  function read(): SyncState {
    const loaded = transport.isLoaded;
    return {
      status: transport.status,
      role: transport.role,
      readOnly: !loaded || transport.readOnly,
      loaded,
      saving: transport.hasUnsavedChanges,
      error: transport.error,
    };
  }

  const unbind = () => {
    session?.destroy();
    session = null;
  };

  const bind = (target: BoardEditor) => {
    const docEmpty = transport.doc.getMap(collab.map ?? DEFAULT_MAP_NAME).size === 0;
    if (docEmpty && (resetOnce || initialContent === 'discard')) target.load([]);
    session = collaborate(target, transport.doc, {
      ...collab,
      awareness: transport.awareness,
      prefer: 'doc',
    });
  };

  const update = () => {
    if (destroyed) return;
    if (doc !== transport.doc) {
      // The server refused a change: drop the session with its history, wait for the board.
      doc = transport.doc;
      unbind();
      resetOnce = true;
    }
    if (editor && !session && transport.isLoaded) bind(editor);
    const next = read();
    if (sameState(state, next)) return;
    // Only on a change of its own: the editor's flag may have been set by others since.
    if (editor && next.readOnly !== state.readOnly)
      editor.setReadOnly(next.readOnly || editorReadOnly);
    state = next;
    for (const listener of [...listeners]) listener();
  };

  const detach = () => {
    const target = editor;
    if (!target) return;
    unbind();
    editor = null;
    if (!target.isDestroyed && state.readOnly) target.setReadOnly(editorReadOnly);
  };

  const off = transport.subscribe(update);

  return {
    get doc() {
      return transport.doc;
    },
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    attach(target) {
      checkAttach(destroyed, editor !== null);
      editor = target;
      editorReadOnly = target.readOnly;
      if (state.readOnly) target.setReadOnly(true);
      if (transport.isLoaded) bind(target);
      return () => {
        if (editor === target) detach();
      };
    },
    destroy() {
      if (destroyed) return;
      detach();
      destroyed = true;
      off();
      transport.destroy();
      listeners.clear();
    },
  };
}

function checkAttach(destroyed: boolean, attached: boolean): void {
  if (destroyed) throw new Error('apeiro: this sync was destroyed');
  if (attached) throw new Error('apeiro: this sync is already shown in a board (detach it first)');
}

function sameState(a: SyncState, b: SyncState): boolean {
  return (
    a.status === b.status &&
    a.role === b.role &&
    a.readOnly === b.readOnly &&
    a.loaded === b.loaded &&
    a.saving === b.saving &&
    a.error === b.error
  );
}
