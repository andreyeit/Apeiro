import { History } from '@apeiro/core';
import type { BoardEditor } from '@apeiro/editor';
import type * as Y from 'yjs';
import { SceneBinding, type SceneBindingOptions } from './scene-binding';
import { YjsHistory, type YjsHistoryOptions } from './history';
import { YjsPresence, type AwarenessLike, type PresenceOptions } from './presence';

export interface CollaborateOptions extends SceneBindingOptions, PresenceOptions {
  /** Awareness of the provider (`provider.awareness`) for cursors and selections of others. */
  awareness?: AwarenessLike | null;
  history?: YjsHistoryOptions;
  /**
   * Undo or redo was refused: it would change elements someone else holds (see `lock`).
   * E.g. show "Ann is editing this".
   */
  onUndoBlocked?: (ids: string[]) => void;
}

export interface Collaboration {
  readonly binding: SceneBinding;
  readonly history: YjsHistory;
  readonly presence: YjsPresence | null;
  /** Stops syncing; the editor keeps the board and gets a fresh local history. */
  destroy(): void;
}

/**
 * Makes `editor` a view of the board stored in `doc`: the scene is synced both ways,
 * undo/redo only touch this user's edits, and (with `awareness`) others' cursors and
 * selections are shown on the board.
 *
 * ```ts
 * const doc = new Y.Doc();
 * const provider = new WebsocketProvider(url, roomId, doc);
 * const session = collaborate(editor, doc, {
 *   awareness: provider.awareness,
 *   user: { name: 'Ann', color: '#e11d48' },
 * });
 * // later: session.destroy(); provider.destroy();
 * ```
 */
export function collaborate(
  editor: BoardEditor,
  doc: Y.Doc,
  options: CollaborateOptions = {},
): Collaboration {
  editor.stopEditing();
  const binding = new SceneBinding(editor.scene, doc, options);
  const history = new YjsHistory(binding, {
    isLocked: (id) => editor.lockedBy(id) !== null,
    ...(options.onUndoBlocked ? { onBlocked: options.onUndoBlocked } : {}),
    ...options.history,
  });
  editor.setHistory(history);
  const presence = options.awareness ? new YjsPresence(editor, options.awareness, options) : null;
  const detachPresence = presence ? editor.setPresence(presence) : () => undefined;
  let destroyed = false;
  return {
    binding,
    history,
    presence,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      detachPresence();
      presence?.destroy();
      binding.destroy();
      if (editor.history === history && !editor.isDestroyed)
        editor.setHistory(new History(editor.scene));
      history.dispose();
    },
  };
}
