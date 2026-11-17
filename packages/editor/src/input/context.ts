import {
  isShape,
  type CameraAnimator,
  type BoardElement,
  type Box,
  type Camera,
  type ConnectorElement,
  type ConnectorEnd,
  type ElementPatch,
  type FontMeasurer,
  type History,
  type Scene,
  type ShapeElement,
  type Vec2,
} from '@apeiro/core';
import { newId } from '../ids';
import type { Overlay } from '../overlay/overlay';
import type { PlaceKind, ToolState } from '../tools/tool-state';
import { MIN_DOT_SHAPE_PX } from './constants';
import type { Mode } from './modes';

export interface ControlsHooks {
  onToolError?: (error: unknown) => void;
  /** A shape was created by clicking a connection dot: e.g. start editing its text. */
  onQuickCreate?: (id: string) => void;
  /** Playback of audio elements (play/pause button, seeking on the waveform). */
  audio?: {
    toggle(id: string): void;
    seek(id: string, fraction: number): void;
  };
  /**
   * Undo history: each pointer gesture becomes one step (a drag is one move, not one per
   * pointermove), and Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y undo and redo.
   */
  history?: Pick<History, 'beginGroup' | 'endGroup' | 'undo' | 'redo'>;
  /**
   * Text tool: a click at `at` (world) makes auto-width text there, a drag a text box
   * `width` wide that wraps. The element is created by the host (it opens the editor).
   */
  createText?: (at: Vec2, width?: number) => void;
  /** Crop mode started or ended (`id` of the image, or null), e.g. to update a toolbar. */
  onCrop?: (id: string | null) => void;
  /** Filled in by the controls: starts / ends crop mode from elsewhere (a toolbar button). */
  crop?: CropControls;
  /** Enter on one selected shape, or the text tool on a shape: edit its text. */
  editText?: (id: string) => void;
  /** Link in the text of a shape at a world point (Miro: a click on a link opens it). */
  linkAt?: (id: string, world: Vec2) => string | null;
  /** Opens a link clicked on the board. */
  openLink?: (href: string) => void;
  /** Lets auto-sized text boxes refit their text while being resized. */
  measurer?: FontMeasurer;
  /**
   * Sticky and shape tools: a click at `at` (`box` null) or a drag over `box` (world).
   * The host creates the element.
   */
  place?: (kind: PlaceKind, at: Vec2, box: Box | null) => void;
  /** Comment tool: a click pins a new comment thread there. */
  addComment?: (at: Vec2) => void;
  /** Ctrl+Shift+K: pick an image file. */
  pickImage?: () => void;
  /**
   * Smart guides while moving and resizing, like Figma, plus the board grid while Shift
   * is held (Ctrl/⌘ held during the gesture turns all snapping off). Off unless set.
   */
  snapping?: boolean;
  /** Shift+0 / Shift+1 / Shift+2 and Ctrl +/−: zoom to 100%, everything, the selection, or by a step. */
  zoom?: (to: 'reset' | 'fit' | 'selection' | 'in' | 'out') => void;
  /**
   * Elements another participant is working on: they can't be selected (see
   * `Overlay.isLocked`), erased, cropped, typed into or have their volume changed.
   */
  isLocked?: (id: string) => boolean;
  /**
   * A read-only board: pan, zoom, select (to copy), open links and play audio, but nothing
   * that changes it — no handles, creating tools, moving, typing, deleting or undo.
   */
  readOnly?: () => boolean;
  /**
   * Whether keyboard shortcuts are for this board. With several boards on a page, only the
   * one in use should react to Delete, Ctrl+Z and the tool keys. Default: always.
   */
  acceptsKeys?: () => boolean;
}

/** Crop mode, driven from outside the board (see `ControlsHooks.crop`). */
export interface CropControls {
  start: (id: string) => void;
  stop: () => boolean;
}

/** Placeholder until `attachControls` fills it in. */
export const cropControls = (): CropControls => ({ start: () => undefined, stop: () => false });

/** Modifier keys as last seen: they change a resize or rotation live, even mid-drag. */
export interface Modifiers {
  shift: boolean;
  alt: boolean;
  /** Ctrl/⌘ held: Figma's deep select (through groups). */
  deep: boolean;
}

/**
 * Everything the input handlers share: the board they act on, the gesture in progress and
 * small helpers. One per `attachControls`; the gesture modules take it as their first argument.
 */
export class InputContext {
  mode: Mode = { kind: 'idle' };
  readonly modifiers: Modifiers = { shift: false, alt: false, deep: false };
  /** Last pointer position (element-local screen px), null before the first event. */
  pointer: Vec2 | null = null;
  spaceDown = false;

  constructor(
    readonly el: HTMLElement,
    readonly scene: Scene,
    readonly camera: Camera,
    readonly overlay: Overlay,
    readonly tools: ToolState,
    readonly animator: CameraAnimator,
    readonly hooks: ControlsHooks,
  ) {}

  locked(id: string): boolean {
    return this.hooks.isLocked?.(id) ?? false;
  }

  readOnly(): boolean {
    return this.hooks.readOnly?.() ?? false;
  }

  /** Screen distance between screen point `a` and world point `worldB`. */
  screenDist(a: Vec2, worldB: Vec2): number {
    const b = this.camera.worldToScreen(worldB);
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  /** A world-space distance for `px` screen pixels at the current zoom. */
  px(px: number): number {
    return px / this.camera.zoom;
  }

  world(p: Vec2): Vec2 {
    return this.camera.screenToWorld(p);
  }

  getShape = (id: string): ShapeElement | undefined => {
    const s = this.scene.get(id);
    return s && isShape(s) ? s : undefined;
  };

  /** Shapes large enough on screen to show connection dots (pen strokes never do). */
  showsDots(s: ShapeElement): boolean {
    return s.type !== 'ink' && Math.min(s.w, s.h) * this.camera.zoom >= MIN_DOT_SHAPE_PX;
  }

  /** Pen strokes aren't connection targets. */
  notConnectable = (id: string): boolean => this.scene.get(id)?.type === 'ink';

  /** Shapes whose text can be typed into (not images, audio players or pen strokes). */
  static editable(s: BoardElement | null | undefined): s is ShapeElement {
    return !!s && isShape(s) && s.type !== 'image' && s.type !== 'audio' && s.type !== 'ink';
  }

  /** Selected elements that still exist, as they are now. */
  selectedElements(): BoardElement[] {
    const out: BoardElement[] = [];
    for (const id of this.overlay.selection) {
      const el = this.scene.get(id);
      if (el) out.push(el);
    }
    return out;
  }

  applyPatches(patches: Map<string, ElementPatch>): void {
    this.scene.transact(() => {
      for (const [id, patch] of patches) this.scene.update(id, patch);
    });
  }

  /** Adds a connector in the current connector style, on top; returns its id. */
  createConnector(start: ConnectorEnd, end: ConnectorEnd): string {
    const id = newId('c');
    const c: ConnectorElement = {
      id,
      type: 'connector',
      z: this.scene.maxZ() + 1,
      start,
      end,
      ...this.tools.style,
    };
    this.scene.add(c);
    return id;
  }

  setCursor(cursor: string): void {
    if (this.el.style.cursor !== cursor) this.el.style.cursor = cursor;
  }

  /** Hides the connection dots (and the highlighted one). */
  clearDots(): void {
    this.overlay.anchorsFor = null;
    this.overlay.hoverDot = null;
  }
}
