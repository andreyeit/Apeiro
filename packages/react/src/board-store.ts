import type { SceneChanges } from '@apeiro/core';
import type { BoardEditor, BoardEditorEvent } from '@apeiro/editor';

/** What a hook can depend on: an editor event, or the scene's content. */
export type Dep = BoardEditorEvent | 'scene' | 'selectionScene' | 'sceneSize' | `element:${string}`;

type Listener = () => void;
type SceneListener = (changes: SceneChanges) => void;

/**
 * Which state each public member of `BoardEditor` reads, for `useBoardState`'s dependency
 * tracking; `null`: anything (commands, which a selector shouldn't call). A member missing
 * here is a type error, so new editor API has to say what it depends on.
 */
const MEMBER_DEPS: Record<keyof BoardEditor, readonly Dep[] | null> = {
  scene: ['scene'],
  getElements: ['scene'],
  camera: ['camera'],
  animator: ['camera'],
  view: ['camera'],
  viewCenter: ['camera', 'mount'],
  clientToWorld: ['camera', 'mount'],
  tools: ['tool'],
  tool: ['tool'],
  history: ['history'],
  canUndo: ['history'],
  canRedo: ['history'],
  selection: ['selection'],
  selectedElements: ['selection', 'selectionScene'],
  selectionBounds: ['selection', 'selectionScene'],
  editing: ['editing'],
  theme: ['theme'],
  labels: [],
  isInteracting: ['gesture'],
  pointer: ['pointer'],
  peers: ['presence'],
  locks: ['presence'],
  lockedBy: ['presence'],
  renderer: ['mount'],
  overlay: ['mount'],
  isMounted: ['mount'],
  isDestroyed: [],
  clipboard: ['clipboard'],
  readOnly: ['readOnly'],
  preview: ['preview'],
  // Commands.
  setReadOnly: null,
  exportImage: null,
  showPreview: null,
  applyPreview: null,
  discardPreview: null,
  setHistory: null,
  setTool: null,
  setConnectorStyle: null,
  setPenStyle: null,
  select: null,
  selectAll: null,
  clearSelection: null,
  setTheme: null,
  setPresence: null,
  on: null,
  undo: null,
  redo: null,
  batch: null,
  addElements: null,
  updateElements: null,
  updateSelection: null,
  deleteSelection: null,
  removeElements: null,
  reorderSelection: null,
  group: null,
  ungroup: null,
  zoomTo: null,
  place: null,
  addText: null,
  editText: null,
  stopEditing: null,
  addFiles: null,
  copy: null,
  cut: null,
  paste: null,
  pasteFromClipboard: null,
  duplicate: null,
  pasteText: null,
  cropImage: null,
  load: null,
  mount: null,
  unmount: null,
  destroy: null,
};

/** Every dependency there is (a selector that reads something unknown). */
const ALL: ReadonlySet<Dep> = new Set<Dep>([
  'mount',
  'tool',
  'selection',
  'history',
  'camera',
  'editing',
  'theme',
  'pointer',
  'presence',
  'clipboard',
  'gesture',
  'readOnly',
  'preview',
  'scene',
]);

/** The dependencies being collected by `track`, and how many members were read. */
let tracking: {
  deps: Set<Dep>;
  reads: number;
  unknown: boolean;
  sceneRead: boolean;
  sceneObserved: boolean;
} | null = null;

/**
 * The hooks' view of one editor: a single subscription per editor event and to the scene,
 * shared by every hook of every component, with listeners per event, per element and for
 * scene changes. Created on first use, kept as long as the editor.
 */
export class BoardStore {
  private readonly events = new Map<BoardEditorEvent, Set<Listener>>();
  private readonly offEvents = new Map<BoardEditorEvent, () => void>();
  private readonly sceneListeners = new Set<SceneListener>();
  private readonly elementListeners = new Map<string, Set<Listener>>();
  private offScene: (() => void) | null = null;
  private readonly bound = new Map<PropertyKey, unknown>();
  /** The editor as selectors see it: records what they read (see `track`). */
  private readonly tracked: BoardEditor;

  constructor(readonly editor: BoardEditor) {
    const bound = this.bound;
    const sceneMethods = new Map<PropertyKey, unknown>();
    const elementReads = new Set<PropertyKey>(['get', 'has', 'getBounds', 'connectorGeometry']);
    const scene = new Proxy(editor.scene, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop, target);
        if (prop === 'size') {
          if (tracking) {
            tracking.sceneObserved = true;
            tracking.deps.add('sceneSize');
          }
          return value;
        }
        if (!elementReads.has(prop) && tracking) {
          tracking.sceneObserved = true;
          tracking.deps.add('scene');
        }
        if (typeof value !== 'function') return value;
        let method = sceneMethods.get(prop);
        if (!method) {
          method = (...args: unknown[]) => {
            if (elementReads.has(prop) && tracking) {
              tracking.sceneObserved = true;
              tracking.deps.add(`element:${String(args[0])}`);
            }
            return Reflect.apply(value, target, args) as unknown;
          };
          sceneMethods.set(prop, method);
        }
        return method;
      },
    });
    this.tracked = new Proxy(editor, {
      get(target, prop) {
        if (prop === 'scene') {
          if (tracking) {
            tracking.reads++;
            tracking.sceneRead = true;
          }
          return scene;
        }
        if (tracking) {
          tracking.reads++;
          const deps =
            typeof prop === 'string' && Object.hasOwn(MEMBER_DEPS, prop)
              ? MEMBER_DEPS[prop as keyof BoardEditor]
              : null;
          if (deps) for (const d of deps) tracking.deps.add(d);
          else tracking.unknown = true;
        }
        const value: unknown = Reflect.get(target, prop, target);
        if (typeof value !== 'function') return value;
        // Methods run on the editor itself, so their internals aren't tracked.
        let fn = bound.get(prop);
        if (!fn) bound.set(prop, (fn = (value as (...a: unknown[]) => unknown).bind(target)));
        return fn;
      },
    });
  }

  /** Listens to an editor event. */
  on(event: BoardEditorEvent, listener: Listener): () => void {
    let set = this.events.get(event);
    if (!set) {
      const listeners = (set = new Set());
      this.events.set(event, listeners);
      this.offEvents.set(
        event,
        this.editor.on(event, () => {
          for (const l of listeners) l();
        }),
      );
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size > 0 || this.events.get(event) !== set) return;
      this.events.delete(event);
      this.offEvents.get(event)?.();
      this.offEvents.delete(event);
    };
  }

  /** Listens to every batch of scene changes. */
  onScene(listener: SceneListener): () => void {
    this.sceneListeners.add(listener);
    this.retainScene();
    return () => {
      this.sceneListeners.delete(listener);
      this.releaseScene();
    };
  }

  /** Listens to changes of one element (added, updated — re-routes included — or removed). */
  onElement(id: string, listener: Listener): () => void {
    let set = this.elementListeners.get(id);
    if (!set) this.elementListeners.set(id, (set = new Set()));
    set.add(listener);
    this.retainScene();
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.elementListeners.get(id) === set) this.elementListeners.delete(id);
      this.releaseScene();
    };
  }

  /** Listens to several dependencies at once; `onScene` (default: any change) for `scene`. */
  watch(
    deps: Iterable<Dep>,
    listener: Listener,
    onScene: SceneListener = () => listener(),
  ): () => void {
    const offs: Array<() => void> = [];
    for (const d of deps) {
      if (d === 'scene') offs.push(this.onScene(onScene));
      else if (d === 'selectionScene')
        offs.push(
          this.onScene((changes) => {
            if (touches(changes, idSet(this.editor.selection))) listener();
          }),
        );
      else if (d === 'sceneSize')
        offs.push(
          this.onScene((changes) => {
            if (changes.added.length > 0 || changes.removed.length > 0) listener();
          }),
        );
      else if (d.startsWith('element:'))
        offs.push(this.onElement(d.slice('element:'.length), listener));
      else offs.push(this.on(d as BoardEditorEvent, listener));
    }
    return () => {
      for (const off of offs) off();
    };
  }

  /**
   * Runs `select` on the editor and reports what it read: the dependencies to listen to
   * for its result to stay current. Reading nothing known (e.g. an editor captured from a
   * closure instead of the argument) depends on everything.
   */
  track<T>(select: (editor: BoardEditor) => T): { value: T; deps: ReadonlySet<Dep> } {
    const outer = tracking;
    const current = {
      deps: new Set<Dep>(),
      reads: 0,
      unknown: false,
      sceneRead: false,
      sceneObserved: false,
    };
    tracking = current;
    try {
      const value = select(this.tracked);
      if (current.sceneRead && !current.sceneObserved) current.deps.add('scene');
      return { value, deps: current.unknown || current.reads === 0 ? ALL : current.deps };
    } finally {
      tracking = outer;
    }
  }

  private retainScene(): void {
    if (this.offScene) return;
    this.offScene = this.editor.scene.subscribe(this.dispatchScene);
  }

  private releaseScene(): void {
    if (!this.offScene || this.sceneListeners.size > 0 || this.elementListeners.size > 0) return;
    this.offScene();
    this.offScene = null;
  }

  private readonly dispatchScene = (changes: SceneChanges): void => {
    for (const l of this.sceneListeners) l(changes);
    const byId = this.elementListeners;
    if (byId.size === 0) return;
    const fire = (id: string) => {
      const set = byId.get(id);
      if (set) for (const l of set) l();
    };
    for (const el of changes.added) fire(el.id);
    for (const el of changes.updated) fire(el.id);
    for (const id of changes.removed) fire(id);
  };
}

const stores = new WeakMap<BoardEditor, BoardStore>();

/** The store of an editor (one per editor, shared by all hooks). */
export function storeOf(editor: BoardEditor): BoardStore {
  let store = stores.get(editor);
  if (!store) stores.set(editor, (store = new BoardStore(editor)));
  return store;
}

/** Same dependencies (by content). */
export function sameDeps(a: ReadonlySet<Dep> | null, b: ReadonlySet<Dep>): boolean {
  if (a === b) return true;
  if (!a || a.size !== b.size) return false;
  for (const d of a) if (!b.has(d)) return false;
  return true;
}

/** Whether a batch touches any of `ids` (e.g. the selection). */
export function touches(changes: SceneChanges, ids: ReadonlySet<string>): boolean {
  if (ids.size === 0) return false;
  for (const el of changes.updated) if (ids.has(el.id)) return true;
  for (const id of changes.removed) if (ids.has(id)) return true;
  for (const el of changes.added) if (ids.has(el.id)) return true;
  return false;
}

const idSets = new WeakMap<readonly string[], ReadonlySet<string>>();

/** A set of the ids of an array that is replaced, never mutated (`editor.selection`). */
export function idSet(ids: readonly string[]): ReadonlySet<string> {
  let set = idSets.get(ids);
  if (!set) idSets.set(ids, (set = new Set(ids)));
  return set;
}
