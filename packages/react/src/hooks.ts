import type { BoardElement, Box, SceneChanges, Vec2 } from '@apeiro/core';
import type {
  BoardDraft,
  BoardEditor,
  BoardEditorEvent,
  NormalizedDraft,
  BoardThemeName,
  Peer,
  Tool,
} from '@apeiro/editor';
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useChangeListener, type BoardChangeListener } from './changes';
import { boardApi } from './board-api';
import { useEditor } from './editor-context';
import { idSet, sameDeps, storeOf, touches, type BoardStore, type Dep } from './board-store';

type Subscribe = (onChange: () => void) => () => void;
type Equal<T> = (a: T, b: T) => boolean;

const isPlainObject = (v: object): boolean => {
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
};

/**
 * Equal values, or arrays / plain objects whose items are equal (`Object.is`). The default
 * comparison of `useBoardState`, so a selector may return a fresh array or object.
 */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    return true;
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  return ka.every((k) => Object.hasOwn(rb, k) && Object.is(ra[k], rb[k]));
}

/**
 * `useSyncExternalStore` that keeps returning the previous value while `isEqual` holds, so
 * a component re-renders only when the value really changes.
 */
function useStoreValue<T>(subscribe: Subscribe, select: () => T, isEqual: Equal<T> = Object.is): T {
  const last = useRef<{ value: T } | null>(null);
  const get = (): T => {
    const value = select();
    const prev = last.current;
    if (prev && isEqual(prev.value, value)) return prev.value;
    last.current = { value };
    return value;
  };
  return useSyncExternalStore(subscribe, get, get);
}

/** The editor of the surrounding board and its store. */
function useStore(): [BoardEditor, BoardStore] {
  const editor = useEditor();
  return [editor, storeOf(editor)];
}

/** A subscription to fixed dependencies, stable for the store. */
function useWatch(store: BoardStore, ...deps: Dep[]): Subscribe {
  const key = deps.join(',');
  return useCallback((onChange) => store.watch(key.split(',') as Dep[], onChange), [store, key]);
}

/** A watcher whose dependencies follow what the selector last read. */
interface Tracked<T> {
  store: BoardStore;
  /** What the selector read the last time it ran. */
  deps: ReadonlySet<Dep> | null;
  /** What the subscription listens to now. */
  watched: ReadonlySet<Dep> | null;
  /** React's callback while subscribed. */
  onChange: (() => void) | null;
  off: (() => void) | null;
  last: { value: T } | null;
  /** The selector that produced `last`: a new one (new props…) runs again. */
  select: ((editor: BoardEditor) => T) | null;
  /** Something the selector read may have changed since it last ran. */
  stale: boolean;
  /** Inside React's render: subscriptions are switched in an effect then, not here. */
  rendering: boolean;
}

/**
 * Any state of the board, picked by `select` from the editor; re-renders only when the
 * picked value changes (`isEqual`, shallow by default: arrays and plain objects are
 * compared item by item).
 *
 * `select` runs again only when something it read can have changed: reading `b.tool`
 * listens to tool changes, `b.view` to the camera, `b.scene` or `b.getElements()` to the
 * content… Read the state through the argument (not an editor from a closure) for this to
 * work; a selector that reads nothing known runs on every change.
 *
 * ```tsx
 * const zoom = useBoardState((board) => board.view.zoom);
 * const stickies = useBoardState((board) =>
 *   board.selectedElements().filter((el) => el.type === 'sticky'),
 * );
 * ```
 */
export function useBoardState<T>(
  select: (editor: BoardEditor) => T,
  isEqual: (a: T, b: T) => boolean = shallowEqual,
): T {
  const [, store] = useStore();
  const ref = useRef<Tracked<T> | null>(null);
  const state =
    ref.current?.store === store
      ? ref.current
      : (ref.current = {
          store,
          deps: null,
          watched: null,
          onChange: null,
          off: null,
          last: null,
          select: null,
          stale: true,
          rendering: false,
        });

  const listen = useCallback(() => {
    state.stale = true;
    state.onChange?.();
  }, [state]);

  /** Listens to what the selector read last; true if that changed. */
  const rewatch = useCallback((): boolean => {
    const deps = state.deps;
    if (!state.onChange || !deps || sameDeps(state.watched, deps)) return false;
    state.off?.();
    state.off = store.watch(deps, listen);
    state.watched = deps;
    return true;
  }, [store, state, listen]);

  const subscribe = useCallback<Subscribe>(
    (onChange) => {
      state.onChange = onChange;
      state.watched = null;
      rewatch();
      // Something may have changed between rendering and subscribing.
      state.stale = true;
      return () => {
        state.off?.();
        state.off = null;
        state.watched = null;
        state.onChange = null;
      };
    },
    [state, rewatch],
  );

  // The snapshot is cached: the selector runs again only after a change of what it read, or
  // when it is a new function (it may use new props). Running it on every call would hand
  // React a new value each time a selector builds fresh objects, and loop.
  const get = (): T => {
    if (!state.stale && state.last && state.select === select) return state.last.value;
    const { value, deps } = store.track(select);
    state.stale = false;
    state.select = select;
    if (!sameDeps(state.deps, deps)) {
      state.deps = deps;
      // After a change (not while rendering): listen to what it reads now right away.
      if (!state.rendering) rewatch();
    }
    const prev = state.last;
    if (prev && isEqual(prev.value, value)) return prev.value;
    state.last = { value };
    return value;
  };

  // A selector may branch on the state and read something else after a render: listen to
  // that, and check for a change missed meanwhile.
  useEffect(() => {
    if (rewatch()) listen();
  });

  state.rendering = true;
  try {
    return useSyncExternalStore(subscribe, get, get);
  } finally {
    state.rendering = false;
  }
}

/**
 * Calls `handler` on an editor event (`'selection'`, `'tool'`, `'camera'`…) without
 * re-rendering, e.g. to log or sync something. The latest `handler` is called (no need to
 * memoize it). To show state, use `useBoardState` instead.
 */
export function useBoardEvent(
  event: BoardEditorEvent,
  handler: (editor: BoardEditor) => void,
): void {
  const editor = useEditor();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => editor.on(event, () => ref.current(editor)), [editor, event]);
}

/**
 * Calls `onChange` when the board's content changes, like `<Board onChange>` but from any
 * component below the board or its provider (an autosave, a "saved" badge…). Changes made
 * together are reported once, a drag or a stroke when it ends, each origin separately.
 *
 * ```tsx
 * function Autosave({ boardId }: { boardId: string }) {
 *   useBoardChange((elements) => saveBoard(boardId, elements));
 *   return null;
 * }
 * ```
 */
export function useBoardChange(onChange: BoardChangeListener): void {
  useChangeListener(useEditor(), onChange);
}

/** Current tool and a setter. */
export function useTool(): [Tool, (tool: Tool) => void] {
  const [editor, store] = useStore();
  const tool = useStoreValue(useWatch(store, 'tool'), () => editor.tool);
  const set = useCallback((t: Tool) => editor.setTool(t), [editor]);
  return [tool, set];
}

/** Ids of the selected elements (same array until the selection changes). */
export function useSelectedIds(): readonly string[] {
  const [editor, store] = useStore();
  return useStoreValue(useWatch(store, 'selection'), () => editor.selection);
}

/** Listens to the selection and to scene changes of selected elements only. */
function useSelectionWatch(store: BoardStore, onSelectionChange?: () => void): Subscribe {
  return useCallback(
    (onChange) => {
      const offSelection = store.on('selection', () => {
        onSelectionChange?.();
        onChange();
      });
      const offScene = store.onScene((c: SceneChanges) => {
        if (!touches(c, idSet(store.editor.selection))) return;
        onSelectionChange?.();
        onChange();
      });
      return () => {
        offSelection();
        offScene();
      };
    },
    [store, onSelectionChange],
  );
}

/** The selected elements, updated when they change (other elements' changes are skipped). */
export function useSelectedElements(): readonly BoardElement[] {
  const [editor, store] = useStore();
  return useStoreValue(useSelectionWatch(store), () => editor.selectedElements(), shallowEqual);
}

/** One element by id (undefined if it doesn't exist), updated when it changes. */
export function useElement(id: string | null | undefined): BoardElement | undefined {
  const [editor, store] = useStore();
  const subscribe = useCallback<Subscribe>(
    (onChange) => (id ? store.onElement(id, onChange) : () => undefined),
    [store, id],
  );
  return useStoreValue(subscribe, () => (id ? editor.scene.get(id) : undefined));
}

/** Number of elements on the board. */
export function useElementCount(): number {
  const [editor, store] = useStore();
  const subscribe = useCallback<Subscribe>(
    (onChange) =>
      store.onScene((c) => {
        if (c.added.length > 0 || c.removed.length > 0) onChange();
      }),
    [store],
  );
  return useStoreValue(subscribe, () => editor.scene.size);
}

export interface HistoryState {
  /** There is something to undo and the board isn't read-only. */
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
}

/** Undo/redo availability and actions (both unavailable on a read-only board). */
export function useHistory(): HistoryState {
  const [editor, store] = useStore();
  const { canUndo, canRedo } = useStoreValue(
    useWatch(store, 'history', 'readOnly'),
    () => ({
      canUndo: editor.canUndo && !editor.readOnly,
      canRedo: editor.canRedo && !editor.readOnly,
    }),
    shallowEqual,
  );
  const { undo, redo } = boardApi(editor).history;
  return useMemo(() => ({ canUndo, canRedo, undo, redo }), [canUndo, canRedo, undo, redo]);
}

/** Camera position and zoom (updates on every pan and zoom: keep the subscriber small). */
export function useCamera(): Readonly<{ x: number; y: number; zoom: number }> {
  const [editor, store] = useStore();
  return useStoreValue(useWatch(store, 'camera'), () => editor.view);
}

export interface ZoomState {
  /** Whole percent, for showing it: `83`. */
  percent: number;
  /** The same zoom as a factor, the unit of `editor.zoomTo(…)`: `0.83`. */
  zoom: number;
}

/**
 * The zoom rounded to whole percent: re-renders only when the shown number changes, not on
 * every frame of an animated zoom. The exact zoom: `useCamera().zoom`.
 *
 * ```tsx
 * const { percent } = useZoom();
 * <button onClick={() => editor.zoomTo('reset')}>{percent}%</button>
 * ```
 */
export function useZoom(): ZoomState {
  const [editor, store] = useStore();
  const percent = useStoreValue(useWatch(store, 'camera'), () =>
    Math.round(editor.camera.zoom * 100),
  );
  return useMemo(() => ({ percent, zoom: percent / 100 }), [percent]);
}

/** Id of the element whose text is being edited, or null. */
export function useEditingId(): string | null {
  const [editor, store] = useStore();
  return useStoreValue(useWatch(store, 'editing'), () => editor.editing);
}

/** The board theme and a setter. */
export function useBoardTheme(): [BoardThemeName, (theme: BoardThemeName) => void] {
  const [editor, store] = useStore();
  const theme = useStoreValue(useWatch(store, 'theme'), () => editor.theme);
  const set = useCallback((t: BoardThemeName) => editor.setTheme(t), [editor]);
  return [theme, set];
}

/** Whether the renderer runs (false on the server, before hydration and after unmount). */
export function useIsBoardReady(): boolean {
  const [editor, store] = useStore();
  return useStoreValue(useWatch(store, 'mount'), () => editor.isMounted);
}

/**
 * Screen box of the selection relative to the board's box (CSS pixels), for placing a
 * floating toolbar above it; null without a selection. Follows pans, zooms and edits.
 */
export function useSelectionScreenBounds(): Box | null {
  const [editor, store] = useStore();
  // World bounds change with the selection and its elements only; a pan or zoom just
  // projects them again (O(1) instead of a pass over the selection).
  const worldRef = useRef<{ box: Box | null; valid: boolean; store: BoardStore } | null>(null);
  if (worldRef.current?.store !== store) worldRef.current = { box: null, valid: false, store };
  const world = worldRef.current;
  const invalidate = useCallback(() => {
    world.valid = false;
  }, [world]);
  const selection = useSelectionWatch(store, invalidate);
  const subscribe = useCallback<Subscribe>(
    (onChange) => {
      // Something may have changed between rendering and subscribing.
      world.valid = false;
      const offSelection = selection(onChange);
      const offView = store.watch(['camera', 'mount'], onChange);
      return () => {
        offSelection();
        offView();
      };
    },
    [selection, store, world],
  );
  const compute = (): Box | null => {
    if (!world.valid) {
      world.box = editor.selectionBounds();
      world.valid = true;
    }
    const b = world.box;
    if (!b) return null;
    const a = editor.camera.worldToScreen({ x: b.minX, y: b.minY });
    const c = editor.camera.worldToScreen({ x: b.maxX, y: b.maxY });
    return { minX: a.x, minY: a.y, maxX: c.x, maxY: c.y };
  };
  return useStoreValue(subscribe, compute, shallowEqual);
}

/** A world box projected to the board's box (CSS pixels). */
function toScreen(editor: BoardEditor, b: Box): Box {
  const a = editor.camera.worldToScreen({ x: b.minX, y: b.minY });
  const c = editor.camera.worldToScreen({ x: b.maxX, y: b.maxY });
  return { minX: a.x, minY: a.y, maxX: c.x, maxY: c.y };
}

/**
 * Screen box of element `id` relative to the board's box (CSS pixels), or null if it
 * doesn't exist: for UI pinned to an element (a comment marker, a badge). Follows pans,
 * zooms and changes of that element only.
 *
 * ```tsx
 * const box = useElementScreenBounds(thread.elementId);
 * return box && <CommentPin style={{ left: box.maxX, top: box.minY }} />;
 * ```
 */
export function useElementScreenBounds(id: string | null | undefined): Box | null {
  const [editor, store] = useStore();
  const subscribe = useCallback<Subscribe>(
    (onChange) => {
      const offElement = id ? store.onElement(id, onChange) : () => undefined;
      const offView = store.watch(['camera', 'mount'], onChange);
      return () => {
        offElement();
        offView();
      };
    },
    [store, id],
  );
  const compute = (): Box | null => {
    const b = id ? editor.scene.getBounds(id) : undefined;
    return b ? toScreen(editor, b) : null;
  };
  return useStoreValue(subscribe, compute, shallowEqual);
}

/**
 * A world point (e.g. where a comment was pinned) on screen, relative to the board's box
 * (CSS pixels); null for null. Follows pans and zooms.
 */
export function useScreenPoint(at: Vec2 | null | undefined): Vec2 | null {
  const [editor, store] = useStore();
  const x = at?.x;
  const y = at?.y;
  const compute = (): Vec2 | null =>
    x === undefined || y === undefined ? null : editor.camera.worldToScreen({ x, y });
  return useStoreValue(useWatch(store, 'camera', 'mount'), compute, shallowEqual);
}

/** Whether the board is read-only here (a viewer; see the `readOnly` prop). */
export function useIsReadOnly(): boolean {
  const [editor, store] = useStore();
  return useStoreValue(useWatch(store, 'readOnly'), () => editor.readOnly);
}

export interface PreviewState {
  /** The draft being previewed (as applying it would change the board), or null. */
  draft: NormalizedDraft | null;
  /** Shows a draft over the board for this user only; throws if it is invalid. */
  show: (draft: BoardDraft) => void;
  /** Applies the draft as one undo step; returns the ids added and changed. */
  apply: () => string[];
  /** Drops the draft. */
  discard: () => void;
}

/**
 * Proposed changes shown before they are made, e.g. an AI assistant's result: `show` it,
 * then let the user `apply` or `discard` it. Until applied, nobody else sees it.
 *
 * ```tsx
 * const preview = usePreview();
 * // after the AI answered: preview.show({ add: stickers });
 * {preview.draft && <><button onClick={preview.apply}>Apply</button>
 *   <button onClick={preview.discard}>Discard</button></>}
 * ```
 */
export function usePreview(): PreviewState {
  const [editor, store] = useStore();
  const draft = useStoreValue(useWatch(store, 'preview'), () => editor.preview);
  const { show, apply, discard } = boardApi(editor).preview;
  return useMemo(() => ({ draft, show, apply, discard }), [draft, show, apply, discard]);
}

/** Other participants of a shared board (see `collaborate` in `apeiro/yjs`). */
export function usePeers(): readonly Peer[] {
  const [editor, store] = useStore();
  return useStoreValue(useWatch(store, 'presence'), () => editor.peers);
}

/**
 * Who holds element `id` on a shared board (it can't be selected or edited here meanwhile),
 * or null. See the `lock` option of `collaborate`.
 */
export function useLockedBy(id: string | null | undefined): Peer | null {
  const [editor, store] = useStore();
  return useStoreValue(useWatch(store, 'presence'), () => (id ? editor.lockedBy(id) : null));
}

/** Every element others hold, with who holds it. */
export function useLocks(): ReadonlyMap<string, Peer> {
  const [editor, store] = useStore();
  return useStoreValue(useWatch(store, 'presence'), () => editor.locks);
}

export interface ClipboardState {
  /** Something is selected. */
  canCopy: boolean;
  /** This board copied something (the system clipboard may hold more: `paste` reads it). */
  hasCopy: boolean;
  /** Something is selected and the board isn't read-only (also for `duplicate`). */
  canCut: boolean;
  /** The board isn't read-only. */
  canPaste: boolean;
  copy: () => void;
  cut: () => void;
  /** Pastes from the system clipboard (asks the browser), else what this board copied. */
  paste: () => void;
  duplicate: () => void;
}

/** Copy, cut, paste and duplicate, for toolbar buttons (the keyboard shortcuts work anyway). */
export function useClipboard(): ClipboardState {
  const [editor, store] = useStore();
  const { canCopy, hasCopy, readOnly } = useStoreValue(
    useWatch(store, 'selection', 'clipboard', 'readOnly'),
    () => ({
      canCopy: editor.selection.length > 0,
      hasCopy: editor.clipboard !== null,
      readOnly: editor.readOnly,
    }),
    shallowEqual,
  );
  const api = boardApi(editor).clipboard;
  return useMemo(
    () => ({
      canCopy,
      hasCopy,
      canCut: canCopy && !readOnly,
      canPaste: !readOnly,
      copy: api.copy,
      cut: api.cut,
      paste: () => void api.paste(),
      duplicate: api.duplicate,
    }),
    [api, canCopy, hasCopy, readOnly],
  );
}
