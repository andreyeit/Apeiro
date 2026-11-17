import type { BoardElement } from '../elements/element';
import { validateElement } from '../elements/validation';
import type { Scene } from './scene';

/**
 * Changes as they travel between clients without Yjs: whole elements and ids of deleted
 * ones. `BoardChanges` (the second argument of `<Board onChange>`) is one.
 */
export interface ElementChanges {
  added?: readonly BoardElement[];
  updated?: readonly BoardElement[];
  removed?: readonly string[];
}

/** Scene origin of `applyChanges` batches by default. */
export const REMOTE_ORIGIN = 'remote';

/**
 * Applies changes received from elsewhere (your server, another tab) to a scene, in one
 * batch tagged `origin`: the undo history doesn't record them, and `onChange` reports them
 * with that origin so you don't send them back.
 *
 * Each element replaces the one with its id whole (last writer wins per element; deleted
 * ids that don't exist are ignored). Invalid elements are skipped and returned with the
 * reason, so a bad message can't break the board.
 */
export function applyChanges(
  scene: Scene,
  changes: ElementChanges,
  origin: string = REMOTE_ORIGIN,
): Array<{ id: string; problem: string }> {
  const skipped: Array<{ id: string; problem: string }> = [];
  scene.transact(() => {
    for (const id of changes.removed ?? []) scene.remove(id);
    for (const list of [changes.added, changes.updated]) {
      for (const el of list ?? []) {
        const problem = validateElement(el);
        if (problem) {
          skipped.push({ id: String((el as { id?: unknown } | null)?.id), problem });
          continue;
        }
        // Removed and added back in one batch: reported as an update, attachments kept.
        scene.remove(el.id);
        scene.add(el);
      }
    }
  }, origin);
  return skipped;
}
