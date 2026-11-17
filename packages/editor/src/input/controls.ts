import {
  boxFromPoints,
  CameraAnimator,
  HANDLE_SIGNS,
  hugTextPatch,
  isConnector,
  resetBend,
  reverseConnector,
  type BoardElement,
  type Camera,
  type Scene,
  type Vec2,
} from '@apeiro/core';
import type { Overlay } from '../overlay/overlay';
import { VIEW_TOOLS, type ToolState } from '../tools/tool-state';
import { AutoPan } from './autopan';
import { CLICK_SLOP_PX, FLING_WINDOW_MS, HIT_TOLERANCE_PX, TEXTBOX_DRAG_PX } from './constants';
import { InputContext, type ControlsHooks } from './context';
import { finishConnect } from './connect';
import { startCrop, stopCrop, toggleCrop } from './crop';
import { connectorHandleAt, transformAt } from './hit-targets';
import { hover, idleCursor } from './hover';
import { extendInk, finishInk } from './ink';
import { handleShortcut, isTypingTarget } from './keyboard';
import { completesTool, type ModeOf } from './modes';
import { moveGesture } from './move';
import {
  pressConnectorTool,
  pressCreatingTool,
  pressCrop,
  pressHandles,
  pressSelect,
  pressTextTool,
  type Press,
} from './press';
import { revertGesture } from './revert';

export { cropControls, type ControlsHooks, type CropControls } from './context';

type CustomHandler = 'onPointerDown' | 'onPointerMove' | 'onPointerUp';

/**
 * Pointer and keyboard handling of a board: tools, selection, handles and every gesture.
 * Listens on `el` (pointer) and the window (keyboard); returns a function that detaches.
 *
 * Each pointer gesture becomes one undo step (see `ControlsHooks.history`). Gestures are
 * modules of this folder: `press.ts` starts one, `move.ts` applies it as the pointer
 * moves, `revert.ts` puts things back on Esc.
 */
export function attachControls(
  el: HTMLElement,
  scene: Scene,
  camera: Camera,
  overlay: Overlay,
  tools: ToolState,
  animator: CameraAnimator = new CameraAnimator(camera),
  hooks: ControlsHooks = {},
): () => void {
  const c = new InputContext(el, scene, camera, overlay, tools, animator, hooks);
  const autoPan = new AutoPan(c, (p) => moveGesture(c, p));
  /** Pointer that owns the current gesture: a second finger/pen must not hijack it. */
  let activePointer: number | null = null;
  /** True while the current pointer gesture is being recorded as one undo step. */
  let grouping = false;

  const beginGroup = () => {
    if (grouping || !hooks.history) return;
    grouping = true;
    hooks.history.beginGroup();
  };
  const endGroup = () => {
    if (!grouping) return;
    grouping = false;
    hooks.history?.endGroup();
  };

  if (hooks.crop) {
    hooks.crop.start = (id) => startCrop(c, id);
    hooks.crop.stop = () => stopCrop(c);
  }

  /** Element-local screen point of an event. Pass `rect` to reuse one layout read for several events. */
  const local = (
    e: { clientX: number; clientY: number },
    rect: DOMRect = el.getBoundingClientRect(),
  ): Vec2 => ({ x: e.clientX - rect.left, y: e.clientY - rect.top });

  // --- Modifiers ----------------------------------------------------------------------

  /** Records Shift/Alt/Ctrl; true if Shift or Alt changed (a transform re-applies then). */
  const readModifiers = (e: {
    shiftKey: boolean;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
  }): boolean => {
    const changed = c.modifiers.shift !== e.shiftKey || c.modifiers.alt !== e.altKey;
    c.modifiers.shift = e.shiftKey;
    c.modifiers.alt = e.altKey;
    setDeep(e.ctrlKey || e.metaKey);
    return changed;
  };
  /** Ctrl/⌘ pressed or released: hover and a running marquee switch between groups and elements. */
  const setDeep = (deep: boolean) => {
    if (c.modifiers.deep === deep) return;
    c.modifiers.deep = deep;
    overlay.deep = deep;
    if (c.mode.kind === 'marquee' && c.pointer) moveGesture(c, c.pointer);
    // The cursor follows Ctrl/⌘ right away, without waiting for the pointer to move.
    else if (c.mode.kind === 'idle' && c.pointer) hover(c, c.pointer);
    overlay.request();
  };

  // --- Gesture lifecycle --------------------------------------------------------------

  /** Clears the transient overlay state of a gesture and goes idle. */
  const endGesture = () => {
    autoPan.stop();
    overlay.marquee = null;
    overlay.guides = [];
    overlay.spacing = [];
    overlay.target = null;
    overlay.snap = null;
    overlay.radiusActive = false;
    overlay.countActive = false;
    overlay.countLabel = null;
    overlay.badge = null;
    c.mode = { kind: 'idle' };
    c.setCursor(idleCursor(c));
    overlay.request();
  };

  /** Esc during a gesture: put everything back as it was. False if no gesture runs. */
  const cancelGesture = (): boolean => {
    const m = c.mode;
    if (m.kind === 'custom') {
      m.off();
      // End the mode first: a user's cancellation handler may activate another tool.
      endGesture();
      try {
        m.definition.onCancel?.();
      } finally {
        scene.transact(() => {
          for (const [id, previous] of m.before) {
            if (scene.has(id)) scene.remove(id);
            if (previous) scene.add(previous);
          }
        });
        endGroup();
      }
      return true;
    }
    if (!revertGesture(c)) return false;
    endGesture();
    return true;
  };

  /** Starts a custom tool's gesture; its changes are recorded so a cancel can undo them. */
  const startCustom = (name: string, definition: ModeOf<'custom'>['definition']) => {
    const before = new Map<string, BoardElement | undefined>();
    const off = scene.subscribe((changes) => {
      for (const [id, previous] of changes.previous) {
        if (changes.origin !== undefined) before.delete(id); // Never undo a remote edit.
        else if (!before.has(id)) before.set(id, previous);
      }
    });
    c.mode = { kind: 'custom', name, definition, before, off };
  };

  /** Calls a custom tool's handler; a throwing tool cancels its gesture. False if it threw. */
  const customPointer = (handler: CustomHandler, event: PointerEvent, p: Vec2): boolean => {
    if (c.mode.kind !== 'custom') return false;
    try {
      c.mode.definition[handler]?.({ point: c.world(p), event });
      return true;
    } catch (error) {
      cancelGesture();
      if (hooks.onToolError) hooks.onToolError(error);
      else throw error;
      return false;
    }
  };

  // --- Finishing gestures -------------------------------------------------------------

  const finishTextBox = (m: ModeOf<'textbox'>, p: Vec2) => {
    const end = c.world(p);
    tools.complete();
    if (Math.abs(p.x - m.down.x) >= TEXTBOX_DRAG_PX) {
      const x = Math.min(m.start.x, end.x);
      hooks.createText?.({ x, y: Math.min(m.start.y, end.y) }, Math.abs(end.x - m.start.x));
    } else {
      hooks.createText?.(m.start);
    }
  };

  const finishPlace = (m: ModeOf<'place'>, p: Vec2) => {
    const end = c.world(p);
    tools.complete();
    const dragged = c.screenDist(p, m.start) >= CLICK_SLOP_PX;
    hooks.place?.(m.shape, m.start, dragged ? boxFromPoints(m.start, end) : null);
  };

  /** A press on an element that ended without a drag: open a link or apply the click selection. */
  const finishClick = (m: ModeOf<'drag'>, p: Vec2) => {
    if (c.screenDist(p, m.start) >= CLICK_SLOP_PX) return;
    if (m.link) {
      // A click on a link opens it; a drag that started on one just moves the shape.
      const link = m.link;
      cancelGesture(); // put back the sub-threshold move
      hooks.openLink?.(link);
    } else if (m.onClick) {
      // A click, not a drag: go inside a group, or Shift-deselect.
      const next = m.onClick;
      cancelGesture(); // put back the sub-threshold move
      overlay.selection = next;
    }
  };

  // --- Pointer handlers ---------------------------------------------------------------

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      // Pinch on trackpads arrives as ctrl+wheel with small deltas.
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.01));
      animator.zoomAt(local(e), factor);
    } else {
      const k = e.deltaMode === 1 ? 16 : 1; // lines → px
      animator.panBy(-e.deltaX * k, -e.deltaY * k);
    }
  };

  const onPointerDown = (e: PointerEvent) => {
    if (activePointer !== null && activePointer !== e.pointerId) return; // one gesture at a time
    el.setPointerCapture(e.pointerId);
    activePointer = e.pointerId;
    readModifiers(e);
    beginGroup();
    const p = local(e);
    c.pointer = p;
    if (e.button === 1 || (e.button === 0 && (c.spaceDown || tools.tool === 'hand'))) {
      animator.stop(); // grabbing the board stops any camera animation
      c.mode = { kind: 'pan', last: p, lastTime: e.timeStamp, vx: 0, vy: 0 };
      c.setCursor('grabbing');
      return;
    }
    if (e.button !== 0) return;
    animator.stop();
    const press: Press = { p, world: c.world(p), shift: e.shiftKey, deep: e.ctrlKey || e.metaKey };
    if (pressCrop(c, press)) return;

    // A read-only board only selects (and pins comments) whatever tool is set.
    const readOnly = c.readOnly();
    const tool = readOnly && !VIEW_TOOLS.has(tools.tool) ? 'select' : tools.tool;
    const custom = tools.customTool(tool);
    if (custom) {
      startCustom(tool, custom);
      customPointer('onPointerDown', e, p);
      return;
    }
    if (pressCreatingTool(c, tool, press)) return;
    if (pressHandles(c, press)) return;
    if (tool === 'connector') pressConnectorTool(c, press);
    else if (tool === 'text') pressTextTool(c, press);
    else pressSelect(c, press, readOnly);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (activePointer !== null && activePointer !== e.pointerId) return;
    readModifiers(e);
    const rect = el.getBoundingClientRect();
    const p = local(e, rect);
    c.pointer = p;
    const m = c.mode;
    if (m.kind === 'custom') {
      customPointer('onPointerMove', e, p);
      return;
    }
    if (m.kind === 'pan') {
      const dx = p.x - m.last.x;
      const dy = p.y - m.last.y;
      camera.panBy(dx, dy);
      // Smoothed velocity (px/s) for the fling on release.
      const dt = Math.max(1, e.timeStamp - m.lastTime) / 1000;
      m.vx = m.vx * 0.6 + (dx / dt) * 0.4;
      m.vy = m.vy * 0.6 + (dy / dt) * 0.4;
      m.last = p;
      m.lastTime = e.timeStamp;
      return;
    }
    if (m.kind === 'idle') {
      hover(c, p);
      return;
    }
    // Drawing: every position the browser saw between frames, not just the last one,
    // so a fast stroke keeps its shape. One scene update for all of them.
    if (m.kind === 'ink' && typeof e.getCoalescedEvents === 'function') {
      const points = e.getCoalescedEvents().map((ce) => local(ce, rect));
      points.push(p);
      if (extendInk(c, m, points)) overlay.request();
    } else {
      moveGesture(c, p);
    }
    autoPan.maybeStart(p);
  };

  const releasePointer = (e: PointerEvent): boolean => {
    if (activePointer !== null && activePointer !== e.pointerId) return false;
    activePointer = null;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    return true;
  };

  const onPointerUp = (e: PointerEvent) => {
    if (!releasePointer(e)) return;
    const p = local(e);
    const completed = c.mode.kind;
    if (c.mode.kind === 'custom') {
      if (!customPointer('onPointerUp', e, p)) return;
      if (c.mode.kind === 'custom') c.mode.off();
    }
    const m = c.mode;
    if (m.kind === 'connect') finishConnect(c, m, p);
    else if (m.kind === 'textbox') finishTextBox(m, p);
    else if (m.kind === 'place') finishPlace(m, p);
    else if (m.kind === 'ink') finishInk(c, m);
    else if (m.kind === 'drag') finishClick(m, p);
    else if (m.kind === 'pan' && e.timeStamp - m.lastTime < FLING_WINDOW_MS) {
      animator.fling(m.vx, m.vy);
    }
    endGesture();
    endGroup();
    if (completesTool(completed)) tools.complete();
    hover(c, p);
  };

  /** The system took the pointer away (OS gesture, scroll, palm rejection): undo, don't commit. */
  const onPointerCancel = (e: PointerEvent) => {
    if (!releasePointer(e)) return;
    if (!cancelGesture()) endGesture();
    endGroup();
  };

  /** Keys released while the window is in the background never send keyup. */
  const onBlur = () => {
    c.spaceDown = false;
    setDeep(false);
    if (c.mode.kind === 'idle') c.setCursor(idleCursor(c));
  };

  const onDoubleClick = (e: MouseEvent) => {
    if (c.readOnly()) return; // everything below changes the board
    const p = local(e);
    const world = c.world(p);
    // Figma: a double click on a resize handle of a text box makes it hug its text —
    // a corner or a left/right side fits the width (auto width), top/bottom the height.
    const only =
      overlay.selection.size === 1
        ? c.getShape(overlay.selection.values().next().value!)
        : undefined;
    const handle = only?.type === 'text' && hooks.measurer ? transformAt(c, world) : null;
    if (only && hooks.measurer && handle?.hit.kind === 'resize') {
      const [sx] = HANDLE_SIGNS[handle.hit.handle];
      const patch = hugTextPatch(only, hooks.measurer, sx !== 0 ? 'auto-width' : 'auto-height');
      if (patch) scene.update(only.id, patch);
      e.stopImmediatePropagation(); // not a text-edit double click
      overlay.request();
      return;
    }
    // An image: crop mode on (or off, double clicking it again), as in Figma.
    const pic = tools.tool === 'select' ? scene.hitTest(world, c.px(HIT_TOLERANCE_PX)) : undefined;
    if (pic?.type === 'image') {
      toggleCrop(c, pic.id);
      return;
    }
    // The bend handle of a connector: remove the manual bend.
    const h = connectorHandleAt(c, p);
    if (!h || h.hit.kind !== 'bend') return;
    e.stopImmediatePropagation(); // not a text-edit double click
    scene.update(h.id, resetBend());
    overlay.request();
  };

  // --- Keyboard -----------------------------------------------------------------------

  /** Shift/Alt pressed or released mid-transform: re-apply at the current pointer. */
  const liveModifiers = (e: KeyboardEvent) => {
    const kind = c.mode.kind;
    if (
      readModifiers(e) &&
      c.pointer &&
      (kind === 'resize' || kind === 'rotate' || kind === 'drag')
    ) {
      moveGesture(c, c.pointer);
      if (e.key === 'Alt') e.preventDefault(); // keep the browser menu bar from taking focus
    }
  };

  const acceptsKeys = (e: KeyboardEvent) =>
    !isTypingTarget(e.target) && (hooks.acceptsKeys?.() ?? true);

  const onKeyDown = (e: KeyboardEvent) => {
    liveModifiers(e);
    if (acceptsKeys(e)) handleShortcut(c, e, cancelGesture);
  };

  const onKeyUp = (e: KeyboardEvent) => {
    liveModifiers(e);
    if (e.code === 'Space') {
      c.spaceDown = false;
      if (c.mode.kind === 'idle') c.setCursor(idleCursor(c));
    }
  };

  const onLeave = () => {
    if (c.mode.kind !== 'idle') return;
    overlay.hover = null;
    overlay.hoverDot = null;
    overlay.request();
  };

  const prevOnChange = tools.onChange;
  tools.onChange = () => {
    if (c.mode.kind === 'custom' && c.mode.name !== tools.tool) cancelGesture();
    prevOnChange();
    overlay.transformEnabled = tools.tool === 'select';
    c.setCursor(idleCursor(c));
    c.clearDots();
    overlay.request();
  };

  const listeners: Array<[EventTarget, string, (e: never) => void, AddEventListenerOptions?]> = [
    [el, 'wheel', onWheel, { passive: false }],
    [el, 'pointerdown', onPointerDown],
    [el, 'pointermove', onPointerMove],
    [el, 'pointerup', onPointerUp],
    [el, 'pointercancel', onPointerCancel],
    [el, 'pointerleave', onLeave],
    [el, 'dblclick', onDoubleClick],
    [window, 'keydown', onKeyDown],
    [window, 'keyup', onKeyUp],
    [window, 'blur', onBlur],
  ];
  for (const [target, type, fn, options] of listeners) {
    target.addEventListener(type, fn as EventListener, options);
  }
  return () => {
    if (c.mode.kind === 'custom') cancelGesture();
    tools.onChange = prevOnChange;
    autoPan.stop();
    for (const [target, type, fn] of listeners) {
      target.removeEventListener(type, fn as EventListener);
    }
  };
}

/** Swaps start and end of every selected connector (arrows then point the other way). */
export function reverseSelected(scene: Scene, selection: Iterable<string>): void {
  scene.transact(() => {
    for (const id of selection) {
      const el = scene.get(id);
      if (el && isConnector(el)) scene.update(id, reverseConnector(el));
    }
  });
}
