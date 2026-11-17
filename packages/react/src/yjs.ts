import {
  collaborate,
  syncBoard,
  type BoardSocket,
  type BoardSync,
  type BoardSyncOptions,
  type BoardSyncState,
  type Collaboration,
  type CollaborateOptions,
} from '@apeiro/yjs';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type * as Y from 'yjs';
import { useEditor } from './editor-context';

/**
 * Makes the surrounding board a live view of `doc` (see `collaborate` in `apeiro/yjs`)
 * while the component is mounted: the content syncs both ways, undo touches only this
 * user's edits, and with `awareness` others' cursors and selections show. Null until it
 * runs (first effect), and while `doc` is null — pass null until the provider has synced
 * if the board has content of its own.
 *
 * Options may be written inline: the session is recreated only when `doc`, `awareness`,
 * a Y.Map in `map` or the plain options (`user`, `lock`, `prefer`…) change; the latest
 * callbacks are called.
 *
 * ```tsx
 * function Shared({ doc, provider, user }: Props) {
 *   useCollaboration(doc, { awareness: provider.awareness, user });
 *   return null;
 * }
 * <Board><Shared doc={doc} provider={provider} user={me} /></Board>
 * ```
 */
export function useCollaboration(
  doc: Y.Doc | null | undefined,
  options: CollaborateOptions = {},
): Collaboration | null {
  const editor = useEditor();
  const latest = useRef(options);
  latest.current = options;
  const [session, setSession] = useState<Collaboration | null>(null);
  const { awareness, map } = options;
  const mapObject = typeof map === 'string' ? null : (map ?? null);
  const key = plainKey(options);

  useEffect(() => {
    if (!doc) return;
    const current = collaborate(editor, doc, {
      ...latest.current,
      onInvalid: (id, problem) => (latest.current.onInvalid ?? warnInvalid)(id, problem),
      onUndoBlocked: (ids) => latest.current.onUndoBlocked?.(ids),
    });
    setSession(current);
    return () => {
      current.destroy();
      setSession((s) => (s === current ? null : s));
    };
    // `key` stands for the plain options; callbacks are read through `latest`.
  }, [editor, doc, awareness, mapObject, key]);

  return session;
}

const OFFLINE: BoardSyncState = {
  status: 'offline',
  role: 'edit',
  readOnly: false,
  loaded: false,
  saving: false,
  error: null,
};

/**
 * The surrounding board, shared through your server over a socket.io socket (see
 * `syncBoard` and the protocol in `apeiro/yjs`): loads the saved board, sends this
 * user's changes and cursor, shows everyone else's, catches up after the connection drops
 * and starts over when the server refuses a change. Returns the sync's state for
 * indicators; re-renders only when it changes.
 *
 * The board is read-only until it has arrived and for viewers. Options are `syncBoard`'s
 * (`user`, `lock`, `events`…) and may be written inline: the sync is recreated only when
 * the socket, the board id or plain options change; the latest callbacks are called. Pass
 * a null socket until there is one.
 *
 * ```tsx
 * const socket = io({ transports: ['websocket'] }); // one per tab, outside components
 *
 * function Sync({ boardId, user }: Props) {
 *   const { status, saving, readOnly } = useSocketSync(socket, boardId, { user });
 *   return <span>{status === 'offline' ? 'Нет связи' : saving ? 'Сохраняем…' : 'Сохранено'}</span>;
 * }
 * <Board><Sync boardId={id} user={me} /></Board>
 * ```
 */
export function useSocketSync(
  socket: BoardSocket | null | undefined,
  boardId: string,
  options: BoardSyncOptions = {},
): BoardSyncState {
  const editor = useEditor();
  const latest = useRef(options);
  latest.current = options;
  const key = plainKey(options);
  const [sync, setSync] = useState<BoardSync | null>(null);

  useEffect(() => {
    if (!socket) return;
    const current = syncBoard(editor, socket, boardId, {
      ...latest.current,
      onInvalid: (id, problem) => (latest.current.onInvalid ?? warnInvalid)(id, problem),
      onUndoBlocked: (ids) => latest.current.onUndoBlocked?.(ids),
      ...(latest.current.createDoc ? { createDoc: () => latest.current.createDoc!() } : {}),
    });
    setSync(current);
    return () => {
      current.destroy();
      setSync((s) => (s === current ? null : s));
    };
    // `key` stands for the plain options; callbacks are read through `latest`.
  }, [editor, socket, boardId, key]);

  return useSyncExternalStore(
    useCallback((onChange: () => void) => sync?.subscribe(onChange) ?? noop, [sync]),
    () => sync?.getState() ?? OFFLINE,
    () => OFFLINE,
  );
}

const noop = () => undefined;

/** The options that are plain data, as a string: a change of them recreates the session. */
function plainKey(options: CollaborateOptions | BoardSyncOptions): string {
  // Objects (the awareness, a Y.Map) are compared by identity instead.
  const map = typeof options.map === 'string' ? options.map : null;
  return JSON.stringify({ ...options, awareness: null, map }, (_key, value) =>
    typeof value === 'function' ? undefined : (value as unknown),
  );
}

/** Like `bindScene` without `onInvalid`. */
const warnInvalid = (id: string, problem: string) =>
  console.warn(`apeiro: skipped element ${id} from Yjs: ${problem}`);
