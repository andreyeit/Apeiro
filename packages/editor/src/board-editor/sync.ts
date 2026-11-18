import type { BoardEditor } from './board-editor';

/**
 * - `connecting`: (re)joining the board;
 * - `synced`: up to date and live;
 * - `offline`: no connection (editing goes on, changes are sent when it is back);
 * - `denied`: the server refused to let this user in (see `error`); the sync has stopped.
 */
export type SyncStatus = 'connecting' | 'synced' | 'offline' | 'denied';

/** What the server lets this user do: edit the board, or only look. */
export type BoardRole = 'edit' | 'view';

/** A snapshot of a sync, for indicators ("offline", "saving…", "view only"). */
export interface SyncState {
  status: SyncStatus;
  role: BoardRole;
  /** The board can't be changed here: a viewer's, or not loaded yet. */
  readOnly: boolean;
  /** The board has arrived (until then the editor is read-only). */
  loaded: boolean;
  /** Changes not confirmed by the server yet. */
  saving: boolean;
  /** Why the server refused joining (status `denied`) or the last change (until one is accepted). */
  error: string | null;
}

/**
 * A shared board, made by `createSync` (`apeiro/sync`). It lives on its own (logic), and
 * shows in an editor while attached (`<Board sync={sync}>` does that in React).
 */
export interface BoardSync {
  /** The state now; the same object until something changes. */
  getState(): SyncState;
  /** Called when the state changes. */
  subscribe(listener: () => void): () => void;
  /**
   * Shows the shared board in `editor` and sends its changes: one editor at a time. The
   * editor is read-only while the board hasn't arrived and for viewers. Returns `detach`:
   * the editor keeps the board, becomes editable again and gets a local history.
   */
  attach(editor: BoardEditor): () => void;
  /** Detaches, leaves the board and stops syncing. */
  destroy(): void;
}
