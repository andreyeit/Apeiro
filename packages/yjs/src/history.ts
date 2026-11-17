import type { UndoHistory } from '@apeiro/core';
import * as Y from 'yjs';
import type { SceneBinding } from './scene-binding';

type StackItem = Y.UndoManager['undoStack'][number];

/** Origin of the read-only transactions that inspect undo steps. */
const INSPECT_ORIGIN = { binding: 'apeiro', kind: 'inspect' };

export interface YjsHistoryOptions {
  /** Steps kept; the oldest are dropped (default 200). */
  limit?: number;
  /**
   * Elements this user may not change now (another participant holds them). An undo or
   * redo step that would change one is not applied; it stays on its stack.
   */
  isLocked?: (id: string) => boolean;
  /** An undo or redo was refused because it would change these locked elements. */
  onBlocked?: (ids: string[]) => void;
}

/**
 * Undo/redo of this user's own edits on a shared board, on top of `Y.UndoManager`.
 *
 * Unlike the local `History`, undo reverts only what this user changed, field by field:
 * if someone else recolored a shape this user moved, undoing the move keeps the new color,
 * and other people's edits are never undone. Steps are the scene's local batches; gestures
 * (a drag, a text editing session) are grouped with `beginGroup`/`endGroup` as usual.
 */
export class YjsHistory implements UndoHistory {
  readonly undoManager: Y.UndoManager;
  private groupDepth = 0;
  private listeners = new Set<() => void>();
  private readonly limit: number;
  private readonly isLocked: ((id: string) => boolean) | undefined;
  private readonly onBlocked: ((ids: string[]) => void) | undefined;

  constructor(
    private readonly binding: SceneBinding,
    options: YjsHistoryOptions = {},
  ) {
    this.limit = options.limit ?? 200;
    this.isLocked = options.isLocked;
    this.onBlocked = options.onBlocked;
    this.undoManager = new Y.UndoManager(binding.map, {
      trackedOrigins: new Set([binding.localOrigin]),
      // Every local batch is its own step unless grouped (see beginGroup).
      captureTimeout: 0,
    });
    const notify = () => {
      for (const l of [...this.listeners]) l();
    };
    const trim = () => {
      const stack = this.undoManager.undoStack;
      if (stack.length > this.limit) stack.splice(0, stack.length - this.limit);
      notify();
    };
    this.undoManager.on('stack-item-added', trim);
    this.undoManager.on('stack-item-popped', notify);
    this.undoManager.on('stack-cleared', notify);
  }

  get canUndo(): boolean {
    return this.undoManager.canUndo();
  }

  get canRedo(): boolean {
    return this.undoManager.canRedo();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  beginGroup(): void {
    if (this.groupDepth++ > 0) return;
    // The group starts a new step and keeps merging into it until endGroup.
    this.undoManager.stopCapturing();
    this.undoManager.captureTimeout = Number.MAX_SAFE_INTEGER;
  }

  endGroup(): void {
    if (this.groupDepth === 0 || --this.groupDepth > 0) return;
    this.undoManager.captureTimeout = 0;
    this.undoManager.stopCapturing();
  }

  batch<T>(fn: () => T): T {
    this.beginGroup();
    try {
      return this.binding.scene.transact(fn);
    } finally {
      this.endGroup();
    }
  }

  undo(): string[] {
    if (this.blocked(this.undoManager.undoStack)) return [];
    return this.travel(() => this.undoManager.undo());
  }

  redo(): string[] {
    if (this.blocked(this.undoManager.redoStack)) return [];
    return this.travel(() => this.undoManager.redo());
  }

  /** Ids of the elements the step changes (inserted or deleted content below `map[id]`). */
  touchedBy(item: StackItem): Set<string> {
    const ids = new Set<string>();
    const root = this.binding.map;
    const visit = (struct: Y.AbstractStruct) => {
      let it: Y.Item | null = struct instanceof Y.Item ? struct : null;
      while (it) {
        const parent = it.parent as Y.AbstractType<unknown> | null;
        if (parent === root) {
          if (it.parentSub) ids.add(it.parentSub);
          return;
        }
        it = parent?._item ?? null;
      }
    };
    // A read-only transaction (iterating may split structs, which needs one); no content changes.
    this.binding.doc.transact((tr) => {
      Y.iterateDeletedStructs(tr, item.insertions, visit);
      Y.iterateDeletedStructs(tr, item.deletions, visit);
    }, INSPECT_ORIGIN);
    return ids;
  }

  /** Whether the next step of `stack` would change an element someone else holds. */
  private blocked(stack: readonly StackItem[]): boolean {
    const item = stack[stack.length - 1];
    if (!item || !this.isLocked) return false;
    const locked = [...this.touchedBy(item)].filter((id) => this.isLocked!(id));
    if (locked.length === 0) return false;
    this.onBlocked?.(locked);
    return true;
  }

  clear(): void {
    this.undoManager.clear();
  }

  dispose(): void {
    this.undoManager.destroy();
    this.listeners.clear();
  }

  /** Runs an undo or redo and returns the ids it touched that exist afterwards. */
  private travel(run: () => unknown): string[] {
    const ids = new Set<string>();
    const scene = this.binding.scene;
    const off = scene.subscribe((c) => {
      for (const el of c.added) ids.add(el.id);
      for (const id of c.previous.keys()) ids.add(id);
    });
    try {
      run();
    } finally {
      off();
    }
    return [...ids].filter((id) => scene.has(id));
  }
}
