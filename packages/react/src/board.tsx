import type { BoardElement } from '@apeiro/core';
import type { BoardEditor, BoardSync, BoardThemeName } from '@apeiro/editor';
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useChangeListener, type BoardChanges } from './changes';
import {
  BoardContext,
  useIsClient,
  useOwnedEditor,
  type BoardContextValue,
  type BoardOptions,
} from './editor-context';

/** `'system'` follows the color scheme of the user's OS (`prefers-color-scheme`). */
export type BoardTheme = BoardThemeName | 'system';

/**
 * What a board is: its content, settings and callbacks. Given to `<BoardProvider>`, or to
 * a `<Board>` without a provider.
 *
 * `theme`, `readOnly`, `sync` and the callbacks can change at any time. The other options
 * (`initialElements`, `grid`, `backend`…) are read once, when the board is
 * created; changing one later logs a warning (give the component a new `key` to start over).
 */
export interface BoardSettings extends Omit<BoardOptions, 'onError' | 'theme' | 'readOnly'> {
  /** Light or dark drawing of the board, or `'system'`. Never changes stored colors. */
  theme?: BoardTheme;
  /** A viewer's board: nothing can be changed (see `readOnly` of `BoardEditor`). */
  readOnly?: boolean;
  /**
   * The board's content changed (by the user, undo, `load`, a collaborator…): all its
   * elements, e.g. to save them, and what changed (`changes`), e.g. to save or send only
   * that. Changes made together (one event handler, `batch`…) are reported once, a drag,
   * resize or pen stroke once when it ends; changes of different origins (this user, the
   * network…) in separate calls. Not called for `initialElements`.
   */
  onChange?: (elements: BoardElement[], changes: BoardChanges) => void;
  /**
   * Shares the board with others: a sync made by `createSync` (`apeiro/sync`). Shown while
   * the board is mounted; destroying it is up to you. Can change at any time (another
   * board of the same editor), and read with `useSyncState()`.
   */
  sync?: BoardSync | null;
  /** The renderer couldn't start (no WebGPU or WebGL2), or a file could not be added. */
  onError?: (error: unknown) => void;
}

/** How the board's canvas is shown on the page. */
export interface BoardViewProps {
  className?: string;
  style?: CSSProperties;
  /**
   * Your UI over the board (toolbars, menus, comment pins). Positioned against the board's
   * box; children receive pointer events, the empty space passes them to the board.
   */
  children?: ReactNode;
  /**
   * Shown in the board's box until the board runs: on the server, while hydrating and
   * until the GPU renderer has started (e.g. a spinner). Nothing by default.
   */
  fallback?: ReactNode;
  /** The renderer started. */
  onReady?: (editor: BoardEditor) => void;
}

export interface BoardProviderProps extends BoardSettings {
  /**
   * Show this editor instead of creating one (it is then not destroyed on unmount, and
   * its creation options are its own; `theme`, `readOnly` and `onChange` still apply).
   */
  editor?: BoardEditor;
  children?: ReactNode;
}

/**
 * Props of `<Board>`. Under a `<BoardProvider>` only the view props count (the provider
 * owns the settings; passing them here logs a warning). Without a provider `<Board>`
 * creates its board from the settings.
 */
export interface BoardProps extends BoardSettings, BoardViewProps {}

const darkScheme = (): MediaQueryList | null =>
  typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

const subscribeScheme = (onChange: () => void) => {
  const query = darkScheme();
  query?.addEventListener('change', onChange);
  return () => query?.removeEventListener('change', onChange);
};

const noSubscribe = () => () => undefined;

/** The theme to draw: `theme`, or the OS color scheme for `'system'` (light on the server). */
function useResolvedTheme(theme: BoardTheme | undefined): BoardThemeName | undefined {
  const dark = useSyncExternalStore(
    theme === 'system' ? subscribeScheme : noSubscribe,
    () => theme === 'system' && !!darkScheme()?.matches,
    () => false,
  );
  return theme === 'system' ? (dark ? 'dark' : 'light') : theme;
}

/** Settings the provider applies itself when they change (not reported as ignored). */
const LIVE_SETTINGS: ReadonlySet<string> = new Set(['theme', 'readOnly', 'sync']);

const consoleError = (error: unknown) => console.error('apeiro:', error);

const noSync = () => () => undefined;

/** Whether `sync` keeps the board read-only now. */
function useSyncReadOnly(sync: BoardSync | null): boolean {
  return useSyncExternalStore(
    useCallback((onChange: () => void) => (sync ? sync.subscribe(onChange) : noSync()), [sync]),
    () => !!sync?.getState().readOnly,
    () => !!sync?.getState().readOnly,
  );
}

/**
 * Owns a board: creates its editor from the settings (or shows `editor`) and makes it
 * available to everything below: `<Board>` (the canvas) and the hooks, so toolbars and
 * panels can live anywhere around the canvas.
 *
 * ```tsx
 * <BoardProvider initialElements={saved} onChange={save} theme="system">
 *   <Sidebar />
 *   <Board style={{ flex: 1 }} />
 * </BoardProvider>
 * ```
 */
export function BoardProvider({
  editor: editorProp,
  children,
  theme,
  readOnly,
  sync = null,
  onChange,
  onError,
  ...options
}: BoardProviderProps) {
  const resolvedTheme = useResolvedTheme(theme);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const reportError = useCallback(
    (error: unknown) => (onErrorRef.current ?? consoleError)(error),
    [],
  );
  const own = useOwnedEditor(
    editorProp
      ? null
      : {
          ...options,
          ...(resolvedTheme ? { theme: resolvedTheme } : {}),
          ...(readOnly !== undefined ? { readOnly } : {}),
          onError: reportError,
        },
    LIVE_SETTINGS,
  );
  const editor = editorProp ?? own;
  if (!editor) {
    throw new Error(
      'apeiro: keep passing `editor` to <BoardProvider> for its whole lifetime (or never)',
    );
  }
  useChangeListener(editor, onChange);
  useEffect(() => {
    if (resolvedTheme) editor.setTheme(resolvedTheme);
  }, [editor, resolvedTheme]);
  useEffect(() => sync?.attach(editor), [editor, sync]);
  const syncReadOnly = useSyncReadOnly(sync);
  // A viewer's board; follows the prop (the user's role can change while they're here).
  // The sync makes it read-only by itself too (not loaded yet, or a viewer).
  useEffect(() => {
    if (readOnly !== undefined) editor.setReadOnly(readOnly || syncReadOnly);
  }, [editor, readOnly, syncReadOnly]);

  const value = useMemo<BoardContextValue>(
    () => ({ editor, sync, reportError }),
    [editor, sync, reportError],
  );
  return <BoardContext.Provider value={value}>{children}</BoardContext.Provider>;
}

const VIEW_PROPS: ReadonlySet<string> = new Set([
  'className',
  'style',
  'children',
  'fallback',
  'onReady',
]);

/**
 * The board's canvas. Fills its box: give it a size (or a parent with one).
 *
 * Under a `<BoardProvider>` it shows the provider's board; on its own it is one: it takes
 * the board's settings (`initialElements`, `onChange`, `theme`…) directly.
 *
 * Rendered only in the browser: on the server (and while hydrating) it is an empty box of
 * the same size with `fallback` in it, and its children are not rendered either, so they
 * never run on the server or cause hydration mismatches.
 *
 * ```tsx
 * <Board style={{ height: '100vh' }} theme="system" initialElements={saved} onChange={save}>
 *   <MyToolbar />
 * </Board>
 * ```
 */
export function Board(props: BoardProps) {
  const context = useContext(BoardContext);
  const { className, style, children, fallback, onReady, ...settings } = props;
  const view = { className, style, children, fallback, onReady };
  useSettingsUnderProviderWarning(context ? settings : null);
  if (context) {
    return <BoardView {...view} context={context} />;
  }
  return (
    <BoardProvider {...settings}>
      <ProvidedBoardView {...view} />
    </BoardProvider>
  );
}

function ProvidedBoardView(props: BoardViewProps) {
  const context = useContext(BoardContext)!;
  return <BoardView {...props} context={context} />;
}

/** Mounts the editor of `context` into a box and shows the fallback until it runs. */
function BoardView({
  context,
  className,
  style,
  children,
  fallback,
  onReady,
}: BoardViewProps & { context: BoardContextValue }) {
  const { editor, reportError } = context;
  const client = useIsClient();
  const host = useRef<HTMLDivElement>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const ready = useSyncExternalStore(
    useCallback((onChange: () => void) => editor.on('mount', onChange), [editor]),
    () => editor.isMounted,
    () => false,
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let active = true;
    editor.mount(el).then(
      () => {
        if (active && editor.isMounted) onReadyRef.current?.(editor);
      },
      (error: unknown) => {
        if (!active) return;
        setFailed(true);
        reportError(error);
      },
    );
    return () => {
      active = false;
      editor.unmount();
    };
  }, [editor, client, reportError]);

  return (
    <div
      className={className ? `ap-host ${className}` : 'ap-host'}
      style={{ position: 'relative', overflow: 'hidden', ...style }}
    >
      {client && <div ref={host} className="ap-mount" style={{ position: 'absolute', inset: 0 }} />}
      {!ready && !failed && fallback !== undefined && fallback !== null && (
        <div className="ap-fallback" style={{ position: 'absolute', inset: 0 }}>
          {fallback}
        </div>
      )}
      {client && children !== undefined && children !== null && (
        <div className="ap-ui">{children}</div>
      )}
    </div>
  );
}

/** Warns once per setting passed to a `<Board>` under a provider: the provider owns them. */
function useSettingsUnderProviderWarning(settings: Record<string, unknown> | null): void {
  const warned = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!settings) return;
    for (const [key, value] of Object.entries(settings)) {
      if (value === undefined || VIEW_PROPS.has(key)) continue;
      const seen = (warned.current ??= new Set());
      if (seen.has(key)) continue;
      seen.add(key);
      console.warn(
        `apeiro: <Board ${key}> is ignored under a <BoardProvider>: pass it to the provider.`,
      );
    }
  });
}
