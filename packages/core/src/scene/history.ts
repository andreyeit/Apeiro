import type { BoardElement } from '../elements/element';
import { HISTORY_ORIGIN, type Scene, type SceneChanges } from './scene';

/** One undo step: each element touched, as it was before and after (undefined: absent). */
interface Entry {
  before: Map<string, BoardElement | undefined>;
  after: Map<string, BoardElement | undefined>;
}

/**
 * What the board editor needs from an undo history. `History` (local, below) implements it;
 * so does the Yjs history of `apeiro/yjs`, which undoes only this user's changes.
 */
export interface UndoHistory {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** Reverts the last step; returns the ids it touched that still exist. */
  undo(): string[];
  /** Re-applies the last undone step; returns the ids it touched that exist afterwards. */
  redo(): string[];
  /** Merges everything until the matching `endGroup` into one step. Nestable. */
  beginGroup(): void;
  endGroup(): void;
  /** Runs `fn` as one step. */
  batch<T>(fn: () => T): T;
  /** Forgets all steps. */
  clear(): void;
  /** Called whenever canUndo/canRedo may have changed. */
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export interface HistoryOptions {
  /** Steps kept; the oldest are dropped. */
  limit?: number;
  /**
   * Which batches are user edits worth undoing. By default only untagged ones
   * (`scene.transact(fn)` without an origin): remote changes, loading a board,
   * animations etc. pass an origin and stay out of the history.
   */
  record?: (origin: string | undefined) => boolean;
}

/**
 * Undo/redo for a Scene. Records the inverse of every local batch from the scene's change
 * events, so nothing else needs to know about it: any code that edits the scene is undoable.
 *
 * A gesture (dragging, drawing a connector, editing text) produces many batches; wrap it
 * in `beginGroup()`/`endGroup()` to make it one step. A group whose net effect is nothing
 * (e.g. a drag cancelled with Esc) leaves no step.
 *
 * Undo restores whole elements, so it also brings back deleted elements with their
 * connectors and z order. Elements changed since by someone else are overwritten with
 * the recorded state (last writer wins, like a local edit).
 */
export class History implements UndoHistory {
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private group: Entry | null = null;
  private groupDepth = 0;
  private listeners = new Set<() => void>();
  private readonly limit: number;
  private readonly shouldRecord: (origin: string | undefined) => boolean;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly scene: Scene,
    options: HistoryOptions = {},
  ) {
    this.limit = options.limit ?? 200;
    this.shouldRecord = options.record ?? ((origin) => origin === undefined);
    this.unsubscribe = scene.subscribe((c) => this.onChanges(c));
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Called whenever canUndo/canRedo may have changed (e.g. to update buttons). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Starts merging batches into one step. Nestable: the step ends with the outermost `endGroup`. */
  beginGroup(): void {
    if (this.groupDepth++ === 0) this.group = { before: new Map(), after: new Map() };
  }

  endGroup(): void {
    if (this.groupDepth === 0) return;
    if (--this.groupDepth > 0) return;
    const entry = this.group;
    this.group = null;
    if (entry) this.push(entry);
  }

  /** Runs `fn` as one undo step. */
  batch<T>(fn: () => T): T {
    this.beginGroup();
    try {
      return this.scene.transact(fn);
    } finally {
      this.endGroup();
    }
  }

  /** Reverts the last step. Returns the ids it touched that still exist (e.g. to select them). */
  undo(): string[] {
    return this.travel(this.undoStack, this.redoStack, 'before');
  }

  /** Re-applies the last undone step. Returns the ids it touched that exist afterwards. */
  redo(): string[] {
    return this.travel(this.redoStack, this.undoStack, 'after');
  }

  /** Forgets everything, e.g. after loading another board. */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    if (this.group) this.group = { before: new Map(), after: new Map() };
    this.emit();
  }

  dispose(): void {
    this.unsubscribe();
    this.listeners.clear();
  }

  private onChanges(c: SceneChanges): void {
    if (c.origin === HISTORY_ORIGIN || !this.shouldRecord(c.origin)) return;
    if (c.previous.size === 0) return;
    const entry = this.group ?? { before: new Map(), after: new Map() };
    for (const [id, was] of c.previous) {
      // In a group the first "before" wins; "after" is always the latest state.
      if (!entry.before.has(id)) entry.before.set(id, was);
      entry.after.set(id, this.scene.get(id));
    }
    if (!this.group) this.push(entry);
  }

  private push(entry: Entry): void {
    for (const [id, before] of entry.before) {
      if (sameElement(before, entry.after.get(id))) {
        entry.before.delete(id);
        entry.after.delete(id);
      }
    }
    if (entry.before.size === 0) return; // e.g. a drag that ended where it started
    this.undoStack.push(entry);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    this.emit();
  }

  private travel(from: Entry[], to: Entry[], side: 'before' | 'after'): string[] {
    const entry = from.pop();
    if (!entry) return [];
    const target = entry[side];
    const scene = this.scene;
    scene.transact(() => {
      // Remove first, then (re)create: an element may come back with a different z or type.
      for (const [id, el] of target) {
        if (scene.has(id) && el !== scene.get(id)) scene.remove(id);
      }
      for (const el of target.values()) if (el && !scene.has(el.id)) scene.add(el);
    }, HISTORY_ORIGIN);
    to.push(entry);
    this.emit();
    return [...target.keys()].filter((id) => scene.has(id));
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

/** Structural equality of two element snapshots (plain JSON-like data). */
function sameElement(a: BoardElement | undefined, b: BoardElement | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return deepEqual(a, b);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
      return false;
  }
  return true;
}
