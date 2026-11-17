import {
  Camera,
  CameraAnimator,
  clipboardFromHtml,
  clipboardText,
  clipboardToHtml,
  copyElements,
  createTextElement,
  defaultTextBlock,
  hexColor,
  History,
  isShape,
  LINE_HEIGHT,
  measureTextBox,
  pasteElements,
  Scene,
  validateElement,
  type BoardClipboard,
  type BoardElement,
  type Box,
  type CameraOptions,
  type ElementPatch,
  type ShapeElement,
  type UndoHistory,
  type Vec2,
} from '@apeiro/core';
import { createRenderer, type BoardRenderer, type GridStyle } from '@apeiro/renderer';
import { exportFrame, renderImage, sceneOf, type ExportImageOptions } from '../export/export-image';
import { newId } from '../ids';
import { attachControls, cropControls, type CropControls } from '../input/controls';
import { isTypingTarget } from '../input/keyboard';
import { AudioController } from '../media/audio-controller';
import {
  importFiles,
  localUploader,
  revokeUnusedObjectUrls,
  type Uploader,
} from '../media/import-files';
import {
  HANDLE_FILL,
  HANDLE_FILL_DARK,
  Overlay,
  SELECTION_COLOR,
  SELECTION_COLOR_DARK,
  type OverlayLayer,
} from '../overlay/overlay';
import {
  DraftScene,
  normalizeDraft,
  type BoardDraft,
  type NormalizedDraft,
} from '../preview/draft-preview';
import { groupSelection, ungroupSelection } from '../selection/grouping';
import { linkAtPoint } from '../text-editor/links';
import { openLink, TextEditor } from '../text-editor/text-editor';
import { createShape, SHAPE_PRESETS } from '../tools/shapes';
import {
  ToolState,
  VIEW_TOOLS,
  type ConnectorStyle,
  type PenStyle,
  type PlaceKind,
  type Tool,
  type ToolActivation,
} from '../tools/tool-state';
import { EN_LABELS, type BoardLabels } from '../ui/labels';
import {
  boardThemeColors,
  DARK_BOARD_COLORS,
  THEME_KEEP_TYPES,
  type BoardThemeName,
} from '../ui/theme';
import { activeBoard } from './active-board';
import { createBoardDom, watchPixelRatio } from './dom';
import { Emitter } from './emitter';
import { HistoryProxy } from './history-proxy';
import { NO_LOCKS, NO_PEERS, PeerCursors, type Peer, type PresenceSource } from './presence';
import { readSystemClipboard, writeSystemClipboard } from './system-clipboard';

export type { Peer, PresenceSource } from './presence';

export type ZoomTarget = 'in' | 'out' | 'fit' | 'selection' | 'reset' | number;

export interface BoardEditorOptions {
  /** Scene to edit; by default a new empty one. Pass one to share it (e.g. bound to Yjs). */
  scene?: Scene;
  /** Undo history; by default a local `History` of the scene. Can be replaced later with `setHistory`. */
  history?: UndoHistory;
  camera?: CameraOptions;
  /** 'light' (default) or 'dark'. Only changes how colors are drawn, never stored colors. */
  theme?: BoardThemeName;
  /** `auto` (default): WebGPU when available, otherwise WebGL2. */
  backend?: 'auto' | 'webgpu' | 'webgl';
  /** Grid of the board: dots, lines (default) or none. */
  grid?: GridStyle | 'none';
  /** CSS font-family of board text (default: Inter, then the system UI font). Load the font yourself. */
  fontFamily?: string;
  /** Smart guides while moving and resizing (default true). */
  snapping?: boolean;
  /** Animated zoom and pan (default true). */
  smoothCamera?: boolean;
  /** Formatting toolbar above the text being edited (default true). */
  textToolbar?: boolean;
  /** Texts of the built-in UI (default English; `RU_LABELS` for Russian). */
  labels?: Partial<BoardLabels>;
  /**
   * Where dropped or pasted images and audio are stored; returns their URL. By default
   * object URLs, which only this tab can open: on a shared board pass an upload to your
   * storage, or other participants will not see the files.
   */
  upload?: Uploader;
  /** Origins images and audio may be loaded from, besides blob:, data: and the page's own. */
  mediaOrigins?: readonly string[];
  /** Opens a link clicked in board text (default: a new tab, without an opener). */
  openLink?: (href: string) => void;
  /** The comment tool was clicked at a world point; show your comment UI there. */
  onComment?: (at: Vec2) => void;
  /** A file could not be added, or the renderer failed to start. */
  onError?: (error: unknown) => void;
  /** Keep the drawn frame (screenshots, `canvas.toDataURL`); forces WebGL. */
  preserveDrawingBuffer?: boolean;
  /**
   * A viewer's board: it can be panned, zoomed, selected and copied, links open and audio
   * plays, but nothing changes it — no creating tools, handles, moving, typing, deleting,
   * pasting or undo. Remote changes (collaboration) and `load` still apply. Can change
   * later with `setReadOnly` (e.g. when the user's role changes).
   */
  readOnly?: boolean;
}

/** What `on` can listen to. Every listener is called without arguments; read the state from the editor. */
export type BoardEditorEvent =
  | 'mount'
  | 'tool'
  | 'selection'
  | 'history'
  | 'camera'
  | 'editing'
  | 'theme'
  | 'pointer'
  | 'presence'
  | 'clipboard'
  | 'gesture'
  | 'readOnly'
  | 'preview';

/** Offset of a duplicate, and of each repeated paste at one place, in screen pixels. */
const PASTE_STEP_PX = 24;
/** Pasted text wider than this (world units) wraps. */
const MAX_PASTED_TEXT_WIDTH = 480;
/** Sticky size of the design (144×144, yellow, small corners). */
const STICKY_SIZE = 144;
/** A drag smaller than this (world units) still makes a default-sized element. */
const MIN_PLACE = 8;
/** Elements a draft would delete are outlined in this color during the preview. */
const PREVIEW_REMOVE_COLOR = '#ef4444';

interface Mounted {
  root: HTMLDivElement;
  stage: HTMLDivElement;
  renderer: BoardRenderer;
  /** Draws the draft being previewed, over the board (see `showPreview`). */
  preview: { renderer: BoardRenderer | null; canvas: HTMLCanvasElement; token: number };
  overlay: Overlay;
  text: TextEditor;
  audio: AudioController;
  crop: CropControls;
  dispose: () => void;
}

/**
 * An interactive board: scene, camera, tools, selection, undo and, once mounted into a DOM
 * element, the GPU renderer with all pointer and keyboard handling and the text editor.
 *
 * Everything but `mount` works without a DOM, so the editor can be created during server
 * rendering; `mount` must run in the browser. It can be mounted, unmounted and mounted
 * again (e.g. into another element) without losing the board, the camera or the history.
 */
export class BoardEditor {
  readonly scene: Scene;
  readonly camera: Camera;
  readonly animator: CameraAnimator;
  /** Current tool and the style of new connectors and pen strokes. */
  readonly tools = new ToolState();
  private historyImpl: UndoHistory;
  private ownsHistory: boolean;
  private readonly options: BoardEditorOptions;
  private mounted: Mounted | null = null;
  private mountToken = 0;
  private readonly events = new Emitter<BoardEditorEvent>((error) => this.reportError(error));
  /** Selection while unmounted (the overlay owns it while mounted). */
  private pendingSelection = new Set<string>();
  private selectionSnapshot: readonly string[] = [];
  private lastSelectionSet: ReadonlySet<string> | null = null;
  private editingSnapshot: string | null = null;
  private cameraSnapshot: { x: number; y: number; zoom: number };
  private themeName: BoardThemeName;
  private pointerWorld: Vec2 | null = null;
  private clipboardData: BoardClipboard | null = null;
  private interacting = false;
  private readonly labelsMerged: BoardLabels;
  /** Last paste, so pasting the same data at the same place again steps aside. */
  private lastPaste: { data: BoardClipboard; at: Vec2; count: number } | null = null;
  private presenceSource: PresenceSource | null = null;
  private readOnlyFlag: boolean;
  private readonly peerCursors = new PeerCursors();
  /** The draft being previewed, its scene and its subscription to the board. */
  private draft: { scene: DraftScene; off: () => void } | null = null;
  private disposers: Array<() => void> = [];
  private destroyed = false;
  /**
   * Stable object handed to the controls and the text editor: forwards to the current
   * history, so `setHistory` takes effect without remounting.
   */
  private readonly historyProxy: UndoHistory;

  constructor(options: BoardEditorOptions = {}) {
    this.options = options;
    this.scene = options.scene ?? new Scene();
    this.camera = new Camera({ minZoom: 0.01, maxZoom: 32, ...options.camera });
    this.animator = new CameraAnimator(this.camera);
    this.animator.enabled = options.smoothCamera ?? true;
    this.themeName = options.theme ?? 'light';
    this.labelsMerged = { ...EN_LABELS, ...options.labels };
    this.ownsHistory = !options.history;
    this.historyImpl = options.history ?? new History(this.scene);
    this.cameraSnapshot = { ...this.camera.getState() };
    this.historyProxy = new HistoryProxy(() => this.historyImpl);
    this.readOnlyFlag = options.readOnly ?? false;
    if (this.readOnlyFlag) this.applyGuard();
    let unsubscribeHistory = this.historyImpl.subscribe(() => this.emit('history'));
    this.disposers.push(() => unsubscribeHistory());
    this.resubscribeHistory = () => {
      unsubscribeHistory();
      unsubscribeHistory = this.historyImpl.subscribe(() => this.emit('history'));
    };
    this.disposers.push(
      this.camera.subscribe(() => {
        this.cameraSnapshot = { ...this.camera.getState() };
        this.emit('camera');
      }),
      // Elements removed (also by someone else) leave the selection.
      this.scene.subscribe((c) => {
        if (c.removed.length > 0 && !this.mounted) {
          for (const id of c.removed) this.pendingSelection.delete(id);
          this.syncSelection();
        }
      }),
    );
    this.tools.onChange = () => this.emit('tool');
  }

  private resubscribeHistory: () => void;

  // --- State ---------------------------------------------------------------------

  get history(): UndoHistory {
    return this.historyImpl;
  }

  /**
   * Replaces the undo history (e.g. with a Yjs one that undoes only this user's edits).
   * The previous history is disposed if the editor created it.
   */
  setHistory(history: UndoHistory): void {
    if (history === this.historyImpl) return;
    if (this.ownsHistory) this.historyImpl.dispose();
    this.ownsHistory = false;
    this.historyImpl = history;
    this.resubscribeHistory();
    this.emit('history');
  }

  get canUndo(): boolean {
    return this.historyImpl.canUndo;
  }

  get canRedo(): boolean {
    return this.historyImpl.canRedo;
  }

  get tool(): Tool {
    return this.tools.tool;
  }

  /** Picks a tool; on a read-only board only `select`, `hand` and `comment` (see `VIEW_TOOLS`). */
  setTool(tool: Tool, options: ToolActivation = {}): void {
    if (this.readOnlyFlag && !VIEW_TOOLS.has(tool)) return;
    this.mounted?.text.stop();
    this.tools.setTool(tool, options);
  }

  /** Style of new connectors; also applied to the selected connectors. */
  setConnectorStyle(style: Partial<ConnectorStyle>): void {
    this.tools.setDefaults('connector', style);
    const ids = this.selection.filter((id) => this.scene.get(id)?.type === 'connector');
    if (ids.length > 0) this.updateElements(ids, style as ElementPatch);
  }

  /** The board can't be changed here (a viewer). See the `readOnly` option. */
  get readOnly(): boolean {
    return this.readOnlyFlag;
  }

  /**
   * Makes the board read-only (a viewer) or editable again, e.g. when the user's role
   * changes. Going read-only ends text editing, crop mode and any creating tool.
   */
  setReadOnly(readOnly: boolean): void {
    if (readOnly === this.readOnlyFlag) return;
    if (readOnly) {
      this.mounted?.text.stop();
      this.mounted?.crop.stop();
      if (!VIEW_TOOLS.has(this.tools.tool)) this.tools.setTool('select');
    }
    // Cancel an in-flight custom gesture before the existing collaboration guard starts
    // refusing its inverse edits. Otherwise a half-created element could be stranded.
    this.readOnlyFlag = readOnly;
    if (this.mounted) {
      this.mounted.overlay.readOnly = readOnly;
      this.mounted.overlay.anchorsFor = null;
      this.mounted.overlay.request();
    }
    this.applyGuard();
    this.emit('readOnly');
  }

  /**
   * The scene refuses local edits of what this user may not change: everything when
   * read-only, elements others hold on a shared board. A last line of defence: the board
   * already doesn't offer those edits.
   */
  private applyGuard(): void {
    const guarded = this.readOnlyFlag || !!this.presenceSource?.getLocks;
    this.scene.setEditGuard(guarded ? this.canChange : null);
  }

  /** May this user change element `id` now (not read-only, nobody else holds it)? */
  private readonly canChange = (id: string): boolean => !this.readOnlyFlag && this.canEdit(id);

  setPenStyle(style: Partial<PenStyle>): void {
    this.tools.setDefaults('pen', style);
  }

  /** Selected element ids. Same array until the selection changes. */
  get selection(): readonly string[] {
    return this.selectionSnapshot;
  }

  /** The selection as the controls see it (live set). */
  private get selectionSet(): Set<string> {
    return this.mounted ? this.mounted.overlay.selection : this.pendingSelection;
  }

  select(ids: Iterable<string>): void {
    const next = new Set<string>();
    for (const id of ids) if (this.scene.has(id) && this.canEdit(id)) next.add(id);
    if (this.mounted) {
      this.mounted.overlay.selection = next;
      this.mounted.overlay.request();
    } else this.pendingSelection = next;
    this.syncSelection();
  }

  selectAll(): void {
    this.select([...this.scene.all()].map((el) => el.id));
  }

  clearSelection(): void {
    this.select([]);
  }

  /** Elements currently selected (that still exist). */
  selectedElements(): BoardElement[] {
    const out: BoardElement[] = [];
    for (const id of this.selection) {
      const el = this.scene.get(id);
      if (el) out.push(el);
    }
    return out;
  }

  /** World bounds of the selection, or null if nothing is selected. */
  selectionBounds(): Box | null {
    return this.selection.length > 0 ? this.scene.bounds(this.selection) : null;
  }

  /** Element whose text is being edited, if any. */
  get editing(): string | null {
    return this.editingSnapshot;
  }

  /** Camera position and zoom. Same object until the camera moves. */
  get view(): Readonly<{ x: number; y: number; zoom: number }> {
    return this.cameraSnapshot;
  }

  get theme(): BoardThemeName {
    return this.themeName;
  }

  setTheme(theme: BoardThemeName): void {
    if (theme === this.themeName) return;
    this.themeName = theme;
    if (this.mounted) this.applyTheme(this.mounted);
    this.emit('theme');
  }

  /** Texts of the built-in UI (the `labels` option over English). */
  get labels(): BoardLabels {
    return this.labelsMerged;
  }

  /** A pointer gesture on the board is in progress (pressed, not yet released). */
  get isInteracting(): boolean {
    return this.interacting;
  }

  private setInteracting(on: boolean): void {
    if (on === this.interacting) return;
    this.interacting = on;
    this.emit('gesture');
  }

  /** Pointer position in world coordinates while it is over the board. */
  get pointer(): Vec2 | null {
    return this.pointerWorld;
  }

  /** Other participants, when a collaboration adapter is attached. */
  get peers(): readonly Peer[] {
    return this.presenceSource?.getPeers() ?? NO_PEERS;
  }

  /** Attaches a presence source (done by `apeiro/yjs`); null detaches it. */
  setPresence(source: PresenceSource | null): () => void {
    this.presenceSource = source;
    this.applyGuard();
    this.applyLocks();
    this.emit('presence');
    const off = source?.subscribe(() => {
      this.applyLocks();
      this.emit('presence');
      this.mounted?.overlay.request();
    });
    return () => {
      off?.();
      if (this.presenceSource === source) {
        this.presenceSource = null;
        this.applyGuard();
        this.emit('presence');
      }
    };
  }

  /** Elements other participants hold (they can't be selected or edited here), with who holds each. */
  get locks(): ReadonlyMap<string, Peer> {
    return this.presenceSource?.getLocks?.() ?? NO_LOCKS;
  }

  /** Who holds element `id`, if someone else does. */
  lockedBy(id: string): Peer | null {
    return this.locks.get(id) ?? null;
  }

  private readonly canEdit = (id: string): boolean => !this.locks.has(id);

  /** Lets go of elements someone else took: out of the selection and the text editor. */
  private applyLocks(): void {
    const locks = this.locks;
    if (this.mounted) {
      const m = this.mounted;
      if (m.text.editing && locks.has(m.text.editing)) m.text.stop();
      m.overlay.releaseLocked();
    } else {
      for (const id of this.pendingSelection) if (locks.has(id)) this.pendingSelection.delete(id);
    }
    this.syncSelection();
  }

  /** The renderer while mounted (advanced: stats, text layout, color theme). */
  get renderer(): BoardRenderer | null {
    return this.mounted?.renderer ?? null;
  }

  /** The 2D overlay while mounted: add drawing on top of the board with `addLayer`. */
  get overlay(): Overlay | null {
    return this.mounted?.overlay ?? null;
  }

  get isMounted(): boolean {
    return this.mounted !== null;
  }

  /** Listens to a kind of change. Returns the unsubscribe function. */
  on(event: BoardEditorEvent, listener: () => void): () => void {
    return this.events.on(event, listener);
  }

  private emit(event: BoardEditorEvent): void {
    this.events.emit(event);
  }

  /** Errors of listeners and custom tools: to `onError`, else the console. */
  private reportError(error: unknown): void {
    (this.options.onError ?? console.error)(error);
  }

  private syncSelection(): void {
    const set = this.selectionSet;
    const prev = this.selectionSnapshot;
    let changed = set !== this.lastSelectionSet || set.size !== prev.length;
    if (!changed) for (const id of prev) if (!set.has(id) || !this.scene.has(id)) changed = true;
    this.lastSelectionSet = set;
    if (!changed) return;
    const next = [...set].filter((id) => this.scene.has(id));
    if (next.length === prev.length && next.every((id, i) => id === prev[i])) return;
    this.selectionSnapshot = next;
    this.emit('selection');
  }

  private syncEditing(): void {
    const id = this.mounted?.text.editing ?? null;
    if (id === this.editingSnapshot) return;
    this.editingSnapshot = id;
    this.emit('editing');
  }

  // --- Commands ------------------------------------------------------------------

  // Commands that change the board do nothing on a read-only one (see `readOnly`).

  undo(): void {
    if (this.readOnlyFlag) return;
    this.mounted?.text.stop();
    this.select(this.historyImpl.undo());
  }

  redo(): void {
    if (this.readOnlyFlag) return;
    this.mounted?.text.stop();
    this.select(this.historyImpl.redo());
  }

  /** Runs `fn` as one undo step (all scene changes inside merge). */
  batch<T>(fn: () => T): T {
    return this.historyImpl.batch(fn);
  }

  /** Adds elements (one undo step) and selects them. */
  addElements(elements: readonly BoardElement[], options: { select?: boolean } = {}): void {
    if (this.readOnlyFlag) return;
    this.scene.transact(() => {
      for (const el of elements) this.scene.add(el);
    });
    if (options.select ?? true) this.select(elements.map((el) => el.id));
  }

  /** Patches elements, one undo step. A function patch is called per element. */
  updateElements(
    ids: Iterable<string>,
    patch: ElementPatch | ((el: BoardElement) => ElementPatch | null),
  ): void {
    if (this.readOnlyFlag) return;
    this.scene.transact(() => {
      for (const id of ids) {
        const el = this.scene.get(id);
        if (!el) continue;
        const p = typeof patch === 'function' ? patch(el) : patch;
        if (p) this.scene.update(id, p);
      }
    });
    this.mounted?.overlay.request();
  }

  /** Patches every selected element, one undo step. */
  updateSelection(patch: ElementPatch | ((el: BoardElement) => ElementPatch | null)): void {
    this.updateElements(this.selection, patch);
  }

  /** Deletes the selection with the connectors attached to it. */
  deleteSelection(): void {
    if (this.selection.length === 0 || this.readOnlyFlag) return;
    this.mounted?.text.stop();
    this.scene.removeWithConnectors(this.selection);
    this.select([]);
  }

  /** Deletes elements with the connectors attached to them, one undo step; they leave the selection. */
  removeElements(ids: Iterable<string>): void {
    if (this.readOnlyFlag) return;
    const gone = new Set(ids);
    if (gone.size === 0) return;
    this.mounted?.text.stop();
    this.scene.removeWithConnectors(gone);
    this.select(this.selection.filter((id) => this.scene.has(id)));
  }

  /** Moves the selection above (`front`) or below (`back`) everything else. */
  reorderSelection(where: 'front' | 'back'): void {
    const els = this.selectedElements().sort((a, b) => a.z - b.z);
    if (els.length === 0 || this.readOnlyFlag) return;
    let min = Infinity;
    let max = -Infinity;
    for (const el of this.scene.all()) {
      min = Math.min(min, el.z);
      max = Math.max(max, el.z);
    }
    this.scene.transact(() => {
      els.forEach((el, i) => {
        const z = where === 'front' ? max + 1 + i : min - els.length + i;
        this.scene.update(el.id, { z });
      });
    });
    this.mounted?.overlay.request();
  }

  group(): void {
    if (this.readOnlyFlag) return;
    const next = groupSelection(this.scene, new Set(this.selection));
    if (next) this.select(next);
  }

  ungroup(): void {
    if (this.readOnlyFlag) return;
    const next = ungroupSelection(this.scene, new Set(this.selection));
    if (next) this.select(next);
  }

  /** Center of the view in world coordinates. */
  viewCenter(): Vec2 {
    return this.camera.screenToWorld({
      x: this.camera.viewportWidth / 2,
      y: this.camera.viewportHeight / 2,
    });
  }

  /** A point given in page client coordinates (e.g. a mouse event) in world coordinates. */
  clientToWorld(clientX: number, clientY: number): Vec2 {
    const r = this.mounted?.root.getBoundingClientRect();
    return this.camera.screenToWorld({ x: clientX - (r?.left ?? 0), y: clientY - (r?.top ?? 0) });
  }

  zoomTo(to: ZoomTarget): void {
    const center = { x: this.camera.viewportWidth / 2, y: this.camera.viewportHeight / 2 };
    if (to === 'in') this.animator.zoomAt(center, 1.25);
    else if (to === 'out') this.animator.zoomAt(center, 0.8);
    else if (to === 'fit' || to === 'selection') {
      const b = to === 'fit' ? this.scene.bounds() : this.selectionBounds();
      if (b) this.animator.fitBox(b, 96);
    } else this.animator.zoomAt(center, (to === 'reset' ? 1 : to) / this.camera.zoom);
  }

  /**
   * Adds a sticky note or shape at `at` (default: the view center), or over `box`,
   * and selects it. A new sticky opens for typing. Null on a read-only board.
   */
  place(kind: PlaceKind, at: Vec2 = this.viewCenter(), box: Box | null = null): string | null {
    if (this.readOnlyFlag) return null;
    this.mounted?.text.stop();
    const sized = box && box.maxX - box.minX >= MIN_PLACE && box.maxY - box.minY >= MIN_PLACE;
    let id: string;
    if (kind === 'sticky') {
      const defaults = this.tools.getDefaults('sticky');
      const w = sized ? box.maxX - box.minX : (defaults.w ?? STICKY_SIZE);
      const h = sized ? box.maxY - box.minY : (defaults.h ?? STICKY_SIZE);
      const el: ShapeElement = {
        id: newId('s'),
        type: 'sticky',
        x: sized ? box.minX : at.x - w / 2,
        y: sized ? box.minY : at.y - h / 2,
        rotation: 0,
        z: this.scene.maxZ() + 1,
        fill: hexColor('#fef3c7'),
        stroke: 0,
        strokeWidth: 0,
        radius: 4,
        ...defaults,
        w,
        h,
      };
      this.scene.add(el);
      id = el.id;
    } else {
      id = this.scene.transact(() => {
        const center = sized ? { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 } : at;
        const el = createShape(
          this.scene,
          { ...SHAPE_PRESETS[kind], ...this.tools.getDefaults(kind) },
          center,
        );
        if (sized)
          this.scene.update(el.id, {
            x: box.minX,
            y: box.minY,
            w: box.maxX - box.minX,
            h: box.maxY - box.minY,
          });
        return el.id;
      });
    }
    this.select([id]);
    if (kind === 'sticky') this.editText(id);
    return id;
  }

  /** Adds an empty text box at `at` and opens it for typing; null on a read-only board. */
  addText(at: Vec2 = this.viewCenter(), width?: number): string | null {
    if (this.readOnlyFlag) return null;
    const defaults = this.tools.getDefaults('text');
    const block = { ...defaultTextBlock('text'), ...defaults };
    const size = block.fontSize;
    const y = width === undefined ? at.y - (size * LINE_HEIGHT) / 2 : at.y;
    const el = createTextElement(newId('t'), { x: at.x, y }, this.scene.maxZ() + 1, width, block);
    if (defaults.sizing !== undefined) el.text!.sizing = defaults.sizing;
    this.select([]);
    if (this.mounted) {
      const m = this.mounted;
      requestAnimationFrame(() => {
        if (this.mounted !== m) return;
        m.text.create(el);
        this.select([el.id]);
      });
    } else this.scene.add(el);
    return el.id;
  }

  /** Opens the text of a shape for editing (next frame, after the current pointer event). */
  editText(id: string): void {
    const m = this.mounted;
    if (!m) return;
    requestAnimationFrame(() => {
      if (this.mounted === m && this.scene.has(id) && this.canChange(id)) m.text.start(id);
    });
  }

  stopEditing(): void {
    this.mounted?.text.stop();
  }

  /** Adds image and audio files around `at` (default: the view center) and selects them. */
  async addFiles(files: Iterable<File>, at: Vec2 = this.viewCenter()): Promise<string[]> {
    if (this.readOnlyFlag) return [];
    const ids = await importFiles(
      [...files],
      at,
      this.scene,
      this.options.upload ?? localUploader,
      (file, error) =>
        this.options.onError?.(new Error(`Could not add ${file.name}`, { cause: error })),
    );
    if (ids.length > 0) this.select(ids);
    return ids;
  }

  // --- Clipboard -------------------------------------------------------------------

  /** What `copy`/`cut` put on this editor's clipboard last (also kept when the system one fails). */
  get clipboard(): BoardClipboard | null {
    return this.clipboardData;
  }

  /**
   * Copies the selection (with the lines between selected shapes). Kept by the editor for
   * `paste`, and also written to the system clipboard when the browser allows it (call it
   * from a click or key handler), so it can be pasted into another board or tab.
   * Ctrl/⌘+C does this on the board. Returns the copied data, or null with nothing selected.
   */
  copy(): BoardClipboard | null {
    const data = this.takeCopy();
    if (data) void writeSystemClipboard(data);
    return data;
  }

  /** Copies the selection and deletes it (Ctrl/⌘+X). */
  cut(): BoardClipboard | null {
    if (this.readOnlyFlag) return null;
    const data = this.copy();
    if (data) this.deleteSelection();
    return data;
  }

  /**
   * Pastes `data` (default: this editor's clipboard) as new elements, selected, one undo step.
   * Placed centered at `at`, else under the pointer when it is over the board, else in the
   * middle of the view; pasting the same data at the same place again steps aside each time.
   * Ctrl/⌘+V does this on the board (also with data copied in another tab or board).
   */
  paste(data: BoardClipboard | null = this.clipboardData, at?: Vec2): string[] {
    if (!data || this.readOnlyFlag) return [];
    this.mounted?.text.stop();
    const target = at ?? this.pointerWorld ?? this.viewCenter();
    const last = this.lastPaste;
    const again =
      last && last.data === data && Math.hypot(last.at.x - target.x, last.at.y - target.y) < 1e-6;
    const count = again ? last.count + 1 : 0;
    this.lastPaste = { data, at: target, count };
    const step = (PASTE_STEP_PX / this.camera.zoom) * count;
    const ids = pasteElements(this.scene, data, {
      at: { x: target.x + step, y: target.y + step },
      newId: (el) => newId(el.type === 'connector' ? 'c' : 's'),
    });
    this.select(ids);
    return ids;
  }

  /**
   * Pastes what the system clipboard holds: board elements, images, or text (as a text box).
   * Needs the browser's permission to read the clipboard; falls back to this editor's
   * clipboard. For a "Paste" button; Ctrl/⌘+V on the board doesn't need it.
   */
  async pasteFromClipboard(at?: Vec2): Promise<string[]> {
    if (this.readOnlyFlag) return [];
    const content = await readSystemClipboard();
    if (content?.kind === 'image') return this.addFiles([content.file], at);
    if (content?.kind === 'board') return this.paste(content.data, at);
    if (content?.kind === 'text') {
      const id = this.pasteText(content.text, at);
      if (id) return [id];
    }
    // Nothing usable, or no permission: what this editor copied.
    return this.paste(this.clipboardData, at);
  }

  /**
   * Duplicates the selection next to itself and selects the copies, one undo step
   * (Ctrl/⌘+D). Lines between selected shapes are duplicated with them.
   */
  duplicate(): string[] {
    if (this.selection.length === 0 || this.readOnlyFlag) return [];
    this.mounted?.text.stop();
    const step = PASTE_STEP_PX / this.camera.zoom;
    const data = copyElements(this.scene, this.selection);
    if (!data) return [];
    const ids = pasteElements(this.scene, data, {
      offset: { x: step, y: step },
      newId: (el) => newId(el.type === 'connector' ? 'c' : 's'),
    });
    this.select(ids);
    return ids;
  }

  /**
   * Adds `text` as a text box centered at `at` (default: pointer or view center); returns
   * its id, or null on a read-only board.
   */
  pasteText(text: string, at?: Vec2): string | null {
    if (this.readOnlyFlag) return null;
    this.mounted?.text.stop();
    const target = at ?? this.pointerWorld ?? this.viewCenter();
    const block = { ...defaultTextBlock('text'), runs: [{ text: text.replace(/\r\n?/g, '\n') }] };
    let el = createTextElement(newId('t'), target, this.scene.maxZ() + 1, undefined, block);
    const measurer = this.mounted?.renderer.measurer;
    if (measurer) {
      let size = measureTextBox(el, measurer);
      // Long text wraps in a column instead of running off in one line.
      if (size && size.w > MAX_PASTED_TEXT_WIDTH) {
        el = { ...el, w: MAX_PASTED_TEXT_WIDTH, text: { ...block, sizing: 'auto-height' } };
        size = measureTextBox(el, measurer);
      }
      if (size) el = { ...el, w: size.w, h: size.h };
    }
    el = { ...el, x: target.x - el.w / 2, y: target.y - el.h / 2 };
    this.scene.add(el);
    this.select([el.id]);
    return el.id;
  }

  /** Copies the selection without touching the system clipboard. */
  private takeCopy(): BoardClipboard | null {
    const data = copyElements(this.scene, this.selection);
    if (!data) return null;
    this.clipboardData = data;
    this.lastPaste = null;
    this.emit('clipboard');
    return data;
  }

  /** Starts crop mode for a selected image (Enter or double click do it on the board). */
  cropImage(id: string): void {
    if (this.readOnlyFlag) return;
    this.mounted?.crop.start(id);
  }

  /**
   * Replaces the board's content; not undoable (the history is cleared).
   * Invalid elements or duplicate ids throw before changing the board.
   */
  load(elements: readonly BoardElement[]): void {
    const ids = new Set<string>();
    for (const el of elements) {
      const problem = validateElement(el);
      if (problem) throw new Error(`Invalid element ${el?.id}: ${problem}`);
      if (ids.has(el.id)) throw new Error(`Element ${el.id} already exists`);
      ids.add(el.id);
    }
    this.mounted?.text.stop();
    this.scene.transact(() => {
      this.scene.clear();
      for (const el of elements) this.scene.add(el);
    }, 'load');
    this.historyImpl.clear();
    this.select([]);
  }

  /** Every element of the board (plain data, e.g. to save as JSON). */
  getElements(): BoardElement[] {
    return this.scene.sortedByZ();
  }

  // --- Export ----------------------------------------------------------------------

  /**
   * An image of the board (PNG by default): everything, the elements `ids` (e.g. the
   * selection) or a world `area`, drawn off screen at `scale` pixels per unit without the
   * selection, handles or cursors, once images and text are ready. Browser only; works
   * whether or not the board is mounted.
   *
   * ```ts
   * const png = await editor.exportImage({ ids: editor.selection, scale: 2 });
   * ```
   */
  async exportImage(options: ExportImageOptions = {}): Promise<Blob> {
    const ids = options.area ? null : options.ids ? [...options.ids] : null;
    const bounds = options.area ?? (ids ? this.scene.bounds(ids) : this.scene.bounds());
    if (!bounds) throw new Error('apeiro: nothing to export');
    const frame = exportFrame(
      bounds,
      options.scale ?? 2,
      options.padding ?? (options.area ? 0 : 24),
      options.maxSize ?? 8192,
    );
    const colors = boardThemeColors(this.themeName);
    const dark = this.themeName === 'dark';
    const grid = this.options.grid ?? 'lines';
    return renderImage(
      ids ? sceneOf(this.scene, ids) : this.scene,
      frame,
      {
        background:
          options.background === 'transparent' ? 0 : (options.background ?? colors.background),
        gridColor: options.grid && grid !== 'none' ? colors.gridColor : 0,
        gridStyle: grid === 'none' ? 'dots' : grid,
        ...(this.options.fontFamily ? { fontFamily: this.options.fontFamily } : {}),
        ...(this.options.mediaOrigins ? { mediaOrigins: this.options.mediaOrigins } : {}),
        colorTheme: dark ? DARK_BOARD_COLORS : [],
        keepTypes: THEME_KEEP_TYPES,
        audio: colors.audio,
      },
      options,
    );
  }

  // --- Preview of proposed changes -------------------------------------------------

  /**
   * Shows proposed changes (e.g. an AI assistant's) over the board for this user only:
   * new and changed elements drawn see-through on top, elements to delete outlined in red.
   * Nothing changes on the board (or for collaborators) until `applyPreview`;
   * `discardPreview` drops it. A new preview replaces the current one. Throws, showing
   * nothing, if an element of the draft is invalid.
   */
  showPreview(draft: BoardDraft): void {
    const scene = new DraftScene(this.scene, normalizeDraft(this.scene, draft));
    this.endPreview();
    const off = this.scene.subscribe((c) => scene.boardChanged(c));
    this.draft = { scene, off };
    if (this.mounted) this.startPreviewRenderer(this.mounted);
    this.emit('preview');
  }

  /** The draft being previewed, as applying it would change the board; null without one. */
  get preview(): NormalizedDraft | null {
    return this.draft?.scene.draft ?? null;
  }

  /**
   * Applies the previewed draft to the board as one undo step and selects what it added
   * and changed; returns those ids. Elements deleted meanwhile by someone else are
   * skipped. Nothing on a read-only board (the preview stays).
   */
  applyPreview(): string[] {
    const d = this.draft?.scene.draft;
    if (!d || this.readOnlyFlag) return [];
    this.endPreview();
    this.mounted?.text.stop();
    const ids: string[] = [];
    this.batch(() =>
      this.scene.transact(() => {
        for (const el of d.add) {
          if (this.scene.has(el.id)) continue;
          this.scene.add(el);
          ids.push(el.id);
        }
        for (const { id, ...patch } of d.update) if (this.scene.update(id, patch)) ids.push(id);
        this.scene.removeWithConnectors(d.remove.filter((id) => this.scene.has(id)));
      }),
    );
    this.select(ids);
    this.emit('preview');
    return ids;
  }

  /** Drops the previewed draft; the board stays as it is. */
  discardPreview(): void {
    if (!this.draft) return;
    this.endPreview();
    this.emit('preview');
  }

  private endPreview(): void {
    if (!this.draft) return;
    this.draft.off();
    this.draft = null;
    if (this.mounted) this.stopPreviewRenderer(this.mounted);
  }

  /** Draws the draft on its own see-through canvas over the board, with the same camera. */
  private startPreviewRenderer(m: Mounted): void {
    this.stopPreviewRenderer(m);
    const draft = this.draft;
    if (!draft) return;
    const token = ++m.preview.token;
    m.preview.canvas.hidden = false;
    m.overlay.request();
    const colors = boardThemeColors(this.themeName);
    void createRenderer({
      backend: m.renderer.backend,
      canvas: m.preview.canvas,
      scene: draft.scene.scene,
      camera: this.camera,
      transparent: true,
      background: 0,
      gridColor: 0,
      ...(this.options.fontFamily ? { fontFamily: this.options.fontFamily } : {}),
      ...(this.options.mediaOrigins
        ? { media: { allowedOrigins: this.options.mediaOrigins } }
        : {}),
    }).then(
      (renderer) => {
        if (this.mounted !== m || m.preview.token !== token || this.draft !== draft) {
          renderer.destroy();
          return;
        }
        m.preview.renderer = renderer;
        renderer.setColorTheme(
          this.themeName === 'dark' ? DARK_BOARD_COLORS : [],
          THEME_KEEP_TYPES,
        );
        renderer.setAudioStyle(colors.audio);
        renderer.resize();
      },
      (error: unknown) => this.options.onError?.(error),
    );
  }

  private stopPreviewRenderer(m: Mounted): void {
    m.preview.token++;
    m.preview.renderer?.destroy();
    m.preview.renderer = null;
    m.preview.canvas.hidden = true;
    if (this.mounted === m) m.overlay.request();
  }

  /** Elements the previewed draft would delete: outlined in red. */
  private readonly drawPreview: OverlayLayer = () => {
    const remove = this.draft?.scene.draft.remove;
    if (remove && remove.length > 0)
      this.mounted?.overlay.drawForeignSelection(new Set(remove), PREVIEW_REMOVE_COLOR);
  };

  // --- Mounting --------------------------------------------------------------------

  /**
   * Renders the board into `container` (it fills it: give the container a size) and
   * starts handling input. Resolves once the renderer runs. Mounting again moves the board.
   */
  async mount(container: HTMLElement): Promise<void> {
    if (this.destroyed) throw new Error('BoardEditor is destroyed');
    this.unmount();
    const token = ++this.mountToken;
    const { root, stage, canvas, previewCanvas, overlayCanvas, editorLayer } = createBoardDom(
      container,
      { theme: this.themeName, textToolbar: this.options.textToolbar !== false },
    );

    let renderer: BoardRenderer;
    try {
      const colors = boardThemeColors(this.themeName);
      const grid = this.options.grid ?? 'lines';
      renderer = await createRenderer({
        backend: this.options.backend ?? 'auto',
        canvas,
        scene: this.scene,
        camera: this.camera,
        preserveDrawingBuffer: this.options.preserveDrawingBuffer ?? false,
        gridStyle: grid === 'none' ? 'dots' : grid,
        background: colors.background,
        gridColor: grid === 'none' ? 0 : colors.gridColor,
        ...(this.options.fontFamily ? { fontFamily: this.options.fontFamily } : {}),
        ...(this.options.mediaOrigins
          ? { media: { allowedOrigins: this.options.mediaOrigins } }
          : {}),
      });
    } catch (error) {
      root.remove();
      this.options.onError?.(error);
      throw error;
    }
    if (token !== this.mountToken || this.destroyed) {
      renderer.destroy();
      root.remove();
      return;
    }

    const disposers: Array<() => void> = [activeBoard.mounted(this)];
    /** The pointer is over the board (shortcuts go to it before any board was pressed). */
    let pointerInside = false;
    const overlay = new Overlay(overlayCanvas, this.scene, this.camera);
    overlay.isLocked = (id) => !this.canEdit(id);
    overlay.readOnly = this.readOnlyFlag;
    overlay.selection = this.pendingSelection;
    disposers.push(renderer.onAfterRender(() => overlay.draw()));
    const text = new TextEditor(
      editorLayer,
      this.scene,
      this.camera,
      renderer,
      this.historyProxy,
      this.labelsMerged,
    );
    const audio = new AudioController(
      this.scene,
      renderer,
      undefined,
      this.options.mediaOrigins ?? [],
    );
    const crop = cropControls();
    const m: Mounted = {
      root,
      stage,
      renderer,
      preview: { renderer: null, canvas: previewCanvas, token: 0 },
      overlay,
      text,
      audio,
      crop,
      dispose: () => undefined,
    };
    this.mounted = m;
    disposers.push(overlay.addLayer(this.drawPreview), overlay.addLayer(this.drawPeers));
    overlay.onDraw = () => {
      this.syncSelection();
      this.syncEditing();
    };
    // While text is edited the board shows just its outline: no handles over the typing.
    text.onStart = (id) => {
      overlay.editing = id;
      overlay.request();
      this.syncEditing();
    };
    text.onStop = (id) => {
      overlay.editing = null;
      overlay.selection = id ? new Set([id]) : new Set();
      overlay.request();
      this.syncEditing();
    };
    disposers.push(
      attachControls(stage, this.scene, this.camera, overlay, this.tools, this.animator, {
        crop,
        history: this.historyProxy,
        onQuickCreate: (id) => this.editText(id),
        createText: (at, width) => void this.addText(at, width),
        editText: (id) => this.editText(id),
        linkAt: (id, world) => {
          const el = this.scene.get(id);
          return el && isShape(el)
            ? linkAtPoint(el, renderer.textLayout(el), world, 2 / this.camera.zoom)
            : null;
        },
        openLink: this.options.openLink ?? openLink,
        measurer: renderer.measurer,
        audio,
        place: (kind, at, box) => void this.place(kind, at, box),
        addComment: (at) => this.options.onComment?.(at),
        zoom: (to) => this.zoomTo(to),
        snapping: this.options.snapping ?? true,
        isLocked: (id) => !this.canEdit(id),
        readOnly: () => this.readOnlyFlag,
        acceptsKeys: () => activeBoard.acceptsKeys(this, pointerInside),
        onToolError: (error) => this.reportError(error),
      }),
    );
    disposers.push(revokeUnusedObjectUrls(this.scene));

    const listen = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement | Window,
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
    ) => {
      target.addEventListener(type, fn as EventListener);
      disposers.push(() => target.removeEventListener(type, fn as EventListener));
    };
    // Double click on a shape edits its text (images, audio and pen strokes have none).
    listen(stage, 'dblclick', (e) => {
      const hit = this.scene.hitTest(this.clientToWorld(e.clientX, e.clientY));
      const editable =
        hit && isShape(hit) && hit.type !== 'image' && hit.type !== 'audio' && hit.type !== 'ink';
      if (editable && this.canChange(hit.id)) text.start(hit.id);
    });
    // Files dropped on the board or pasted while the pointer is over it.
    listen(stage, 'pointermove', (e) => {
      pointerInside = true;
      this.pointerWorld = this.clientToWorld(e.clientX, e.clientY);
      this.emit('pointer');
    });
    listen(stage, 'pointerleave', () => {
      pointerInside = false;
      this.pointerWorld = null;
      this.emit('pointer');
    });
    listen(stage, 'dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    });
    listen(stage, 'drop', (e) => {
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length === 0) return;
      e.preventDefault();
      void this.addFiles(files, this.clientToWorld(e.clientX, e.clientY));
    });
    // Keyboard and clipboard shortcuts go to the board in use: the one pressed last or, before
    // any press, the one under the pointer. Never while typing in a field or in board text.
    listen(stage, 'pointerdown', () => {
      activeBoard.pressed(this);
      this.setInteracting(true);
    });
    const release = () => this.setInteracting(false);
    listen(window, 'pointerup', release);
    listen(window, 'pointercancel', release);
    disposers.push(release);
    const active = (t: EventTarget | null) =>
      !isTypingTarget(t) && activeBoard.accepts(this, pointerInside);

    // Native clipboard events carry the data both ways without asking for permission, and
    // work between tabs and boards. `fired`: the browser sent one for the last shortcut.
    let fired = false;
    const onCopy = (e: ClipboardEvent, cut: boolean) => {
      fired = true;
      if (!active(e.target) || this.selection.length === 0) return;
      // Text selected on the page is copied as usual.
      const textSelection = getSelection();
      if (textSelection && !textSelection.isCollapsed) return;
      const data = this.takeCopy();
      if (!data || !e.clipboardData) return;
      e.preventDefault();
      e.clipboardData.setData('text/html', clipboardToHtml(data));
      e.clipboardData.setData('text/plain', clipboardText(data));
      if (cut) this.deleteSelection();
    };
    listen(window, 'copy', (e) => onCopy(e, false));
    listen(window, 'cut', (e) => onCopy(e, true));
    listen(window, 'paste', (e) => {
      fired = true;
      if (!active(e.target)) return;
      const dt = e.clipboardData;
      const files = [...(dt?.files ?? [])];
      const data = clipboardFromHtml(dt?.getData('text/html') ?? '');
      const text = dt?.getData('text/plain') ?? '';
      if (files.length > 0) void this.addFiles(files);
      else if (data) this.paste(data);
      else if (text.trim()) this.pasteText(text);
      // Nothing usable on the system clipboard: what was copied on this board.
      else if (this.clipboardData) this.paste();
      else return;
      e.preventDefault();
    });
    listen(window, 'keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || !active(e.target)) return;
      if (e.code === 'KeyD') {
        e.preventDefault(); // not the browser's bookmark
        this.duplicate();
        return;
      }
      const code = e.code;
      if (code !== 'KeyC' && code !== 'KeyX' && code !== 'KeyV') return;
      // Some browsers (Safari) send no clipboard event without a text selection or a field:
      // then copy and paste through the async clipboard API instead.
      fired = false;
      setTimeout(() => {
        if (fired || this.mounted?.root !== root) return;
        if (code === 'KeyC') this.copy();
        else if (code === 'KeyX') this.cut();
        else void this.pasteFromClipboard();
      }, 0);
    });

    const resize = () => {
      renderer.resize();
      m.preview.renderer?.resize();
      overlay.resize();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(root);
    disposers.push(() => observer.disconnect());
    disposers.push(watchPixelRatio(resize));

    m.dispose = () => {
      this.stopPreviewRenderer(m);
      for (const d of disposers.reverse()) d();
      overlay.dispose();
      text.destroy();
      audio.dispose();
      renderer.destroy();
      root.remove();
    };
    this.applyTheme(m);
    resize();
    if (this.draft) this.startPreviewRenderer(m);
    this.syncSelection();
    this.emit('mount');
  }

  /** Removes the board from the page; the scene, camera, selection and history stay. */
  unmount(): void {
    this.mountToken++;
    const m = this.mounted;
    if (!m) return;
    m.text.stop();
    this.pendingSelection = new Set(m.overlay.selection);
    this.mounted = null;
    m.dispose();
    this.pointerWorld = null;
    this.syncSelection();
    this.syncEditing();
    this.emit('mount');
  }

  /** Unmounts and releases everything; the editor can't be used afterwards. */
  destroy(): void {
    if (this.destroyed) return;
    this.unmount();
    this.endPreview();
    this.destroyed = true;
    for (const d of this.disposers) d();
    this.disposers = [];
    if (this.ownsHistory) this.historyImpl.dispose();
    this.animator.stop();
    this.events.clear();
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  private applyTheme(m: Mounted): void {
    const dark = this.themeName === 'dark';
    m.overlay.accent = dark ? SELECTION_COLOR_DARK : SELECTION_COLOR;
    m.overlay.handleFill = dark ? HANDLE_FILL_DARK : HANDLE_FILL;
    m.overlay.request();
    const colors = boardThemeColors(this.themeName);
    m.root.dataset.apTheme = this.themeName;
    const grid = this.options.grid ?? 'lines';
    m.renderer.setBackdrop({
      background: colors.background,
      gridColor: grid === 'none' ? 0 : colors.gridColor,
    });
    m.renderer.setColorTheme(dark ? DARK_BOARD_COLORS : [], THEME_KEEP_TYPES);
    m.renderer.setAudioStyle(colors.audio);
    m.preview.renderer?.setColorTheme(dark ? DARK_BOARD_COLORS : [], THEME_KEEP_TYPES);
    m.preview.renderer?.setAudioStyle(colors.audio);
  }

  /** Other participants' selections and cursors, on top of the overlay. */
  private readonly drawPeers: OverlayLayer = (ctx, zoom) =>
    this.peerCursors.draw(ctx, zoom, this.presenceSource?.getPeers(), this.mounted?.overlay);
}
