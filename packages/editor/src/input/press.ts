import {
  effectiveRadius,
  HANDLE_SIGNS,
  hitTestAudio,
  isShape,
  polygonSides,
  shapeFrame,
  worldToFrame,
  type ConnectorElement,
  type ConnectorEnd,
  type Vec2,
} from '@apeiro/core';
import { selectionAfterPress } from '../selection/grouping';
import { isPlaceTool, type Tool } from '../tools/tool-state';
import { AUDIO_HIT_PX, HIT_TOLERANCE_PX } from './constants';
import { InputContext } from './context';
import { cropGrabAt, cropTarget, stopCrop } from './crop';
import { eraseAt, startInk } from './ink';
import {
  alongBisector,
  connectorHandleAt,
  countHandleAt,
  dotAt,
  radiusHandleAt,
  transformAt,
} from './hit-targets';
import type { DragOrigin } from './modes';
import { snapBoxOf, snapTargets } from './snap-targets';

/** The press that starts a gesture: where (screen and world) and which modifiers were held. */
export interface Press {
  p: Vec2;
  world: Vec2;
  shift: boolean;
  /** Ctrl/⌘: deep select. */
  deep: boolean;
}

/**
 * Crop mode: a press on its frame's sides or the image starts a crop gesture (true); a
 * press elsewhere ends crop mode.
 */
export function pressCrop(c: InputContext, { world }: Press): boolean {
  const cropping = cropTarget(c);
  if (!cropping) {
    if (c.overlay.cropping) stopCrop(c); // the image is gone
    return false;
  }
  const grab = cropGrabAt(c, cropping, world);
  if (!grab) {
    stopCrop(c);
    return false;
  }
  const frame = shapeFrame(cropping);
  c.mode = {
    kind: 'crop',
    action: grab.action,
    signs: grab.signs,
    original: cropping,
    frame,
    start: worldToFrame(frame, world),
  };
  if (grab.action === 'pan') c.setCursor('grabbing');
  return true;
}

/** Tools that create (or erase) right where the press is, without selecting. True if handled. */
export function pressCreatingTool(c: InputContext, tool: Tool, { p, world }: Press): boolean {
  if (isPlaceTool(tool)) {
    c.mode = { kind: 'place', shape: tool, down: p, start: world };
  } else if (tool === 'pen') {
    startInk(c, world, p);
  } else if (tool === 'eraser') {
    c.mode = { kind: 'erase', last: p };
    eraseAt(c, p);
    c.overlay.request();
  } else if (tool === 'comment') {
    c.tools.complete();
    c.hooks.addComment?.(world);
  } else {
    return false;
  }
  return true;
}

/**
 * Handles of the selection, in the order they are drawn on top of each other: a polygon's
 * corner count, the corner radius, the transform frame, a connector's ends and bend, and
 * the connection dots. True if one was grabbed.
 */
export function pressHandles(c: InputContext, { p, world }: Press): boolean {
  const { overlay, scene } = c;

  const counted = countHandleAt(c, p);
  if (counted) {
    c.mode = { kind: 'count', id: counted.id, original: counted.sides };
    overlay.countActive = true;
    overlay.countLabel = polygonSides(counted);
    overlay.request();
    return true;
  }

  const rounded = radiusHandleAt(c, p);
  if (rounded) {
    c.mode = {
      kind: 'radius',
      id: rounded.id,
      original: rounded.radius,
      startRadius: effectiveRadius(rounded),
      startAlong: alongBisector(rounded, world),
    };
    overlay.radiusActive = true;
    overlay.request();
    return true;
  }

  // Transform frame: resize handles and edges, rotation just outside the corners.
  const transform = transformAt(c, world);
  if (transform) {
    const originals = c.selectedElements();
    const { frame, hit } = transform;
    if (hit.kind === 'resize') {
      c.mode = {
        kind: 'resize',
        handle: hit.handle,
        frame,
        originals,
        start: worldToFrame(frame, world),
        // Text scaled from a corner keeps its proportions too, like in Miro. Images in
        // crop and fit modes too (the frame hugs the picture); fill never distorts, so
        // it resizes freely (Figma).
        lockAspect: originals.some(
          (el) =>
            (el.type === 'image' && (el.imageFit === 'crop' || el.imageFit === 'fit')) ||
            el.type === 'text',
        ),
        scaleText: HANDLE_SIGNS[hit.handle].every((s) => s !== 0),
        targets: snapTargets(c, new Set(originals.map((o) => o.id))),
      };
    } else {
      const center = { x: frame.cx, y: frame.cy };
      const only = originals.length === 1 ? originals[0]! : null;
      c.mode = {
        kind: 'rotate',
        center,
        originals,
        startAngle: Math.atan2(world.y - center.y, world.x - center.x),
        base: only && isShape(only) ? only.rotation : 0,
      };
    }
    c.clearDots();
    return true;
  }

  const handle = connectorHandleAt(c, p);
  if (handle) {
    const connector = scene.get(handle.id) as ConnectorElement;
    if (handle.hit.kind === 'end') {
      const { which } = handle.hit;
      c.mode = {
        kind: 'connect',
        id: handle.id,
        which,
        down: p,
        original: connector[which],
        fromDot: null,
      };
    } else {
      const { route, curve, elbowAt } = connector;
      c.mode = { kind: 'bend', id: handle.id, original: { route, curve, elbowAt } };
    }
    return true;
  }

  // Connection dots: drag out a new connector (a click quick-creates a shape on release).
  const dot = dotAt(c, p);
  if (dot) {
    const id = c.createConnector(
      { kind: 'element', id: dot.shape.id, anchor: dot.anchor },
      { kind: 'point', x: world.x, y: world.y },
    );
    c.clearDots();
    c.mode = {
      kind: 'connect',
      id,
      which: 'end',
      down: p,
      original: null,
      fromDot: { shape: dot.shape.id, anchor: dot.anchor },
    };
    return true;
  }
  return false;
}

/** Connector tool: a new connector from the shape under the press, or from a free point. */
export function pressConnectorTool(c: InputContext, { p, world }: Press): void {
  const shape = c.scene.hitTestShape(world, c.px(HIT_TOLERANCE_PX), c.notConnectable);
  const start: ConnectorEnd = shape
    ? { kind: 'element', id: shape.id }
    : { kind: 'point', x: world.x, y: world.y };
  const id = c.createConnector(start, { kind: 'point', x: world.x, y: world.y });
  c.mode = { kind: 'connect', id, which: 'end', down: p, original: null, fromDot: null };
}

/** Text tool: type into the shape under the press, or start a new text box on the empty board. */
export function pressTextTool(c: InputContext, { p, world }: Press): void {
  const shape = c.scene.hitTestShape(world, c.px(HIT_TOLERANCE_PX));
  if (shape && c.locked(shape.id)) return; // someone else is working on it
  if (InputContext.editable(shape)) {
    c.overlay.selection = new Set([shape.id]);
    c.tools.complete();
    c.hooks.editText?.(shape.id);
  } else {
    c.mode = { kind: 'textbox', down: p, start: world };
  }
  c.overlay.request();
}

/**
 * Select tool: audio player controls act right away; a press on an element selects it
 * and starts moving the selection; on the empty board it starts a marquee.
 */
export function pressSelect(c: InputContext, press: Press, readOnly: boolean): void {
  const { overlay, scene } = c;
  const { world } = press;
  const hit = scene.hitTest(world, c.px(HIT_TOLERANCE_PX));

  // Audio player controls act right away and don't change the selection.
  const control = hit && isShape(hit) ? hitTestAudio(hit, world, c.px(AUDIO_HIT_PX)) : null;
  if (hit && isShape(hit) && control) {
    if (control.part === 'play') {
      c.hooks.audio?.toggle(hit.id);
    } else if (control.part === 'wave') {
      c.hooks.audio?.seek(hit.id, control.fraction);
      c.mode = { kind: 'seek', id: hit.id };
    } else if (!c.locked(hit.id) && !readOnly) {
      c.mode = { kind: 'volume', id: hit.id, original: hit.volume };
      scene.update(hit.id, { volume: control.value });
    }
    return;
  }

  if (hit) {
    const pressed = selectionAfterPress(scene, overlay.selection, hit.id, press.shift, press.deep);
    overlay.selection = pressed.selection;
    // Read-only: a press selects (and a click opens a link) but moves nothing.
    const origin = new Map<string, DragOrigin>();
    for (const id of readOnly ? [] : overlay.selection) {
      const s = scene.get(id);
      if (!s) continue;
      origin.set(
        id,
        isShape(s)
          ? { kind: 'shape', x: s.x, y: s.y }
          : { kind: 'connector', start: s.start, end: s.end },
      );
    }
    const link = !press.shift && isShape(hit) ? (c.hooks.linkAt?.(hit.id, world) ?? null) : null;
    c.mode = {
      kind: 'drag',
      start: world,
      origin,
      link,
      onClick: pressed.onClick,
      box: snapBoxOf(c, origin.keys()),
      targets: snapTargets(c, new Set(origin.keys())),
      moved: false,
    };
    c.setCursor(press.deep || readOnly ? '' : 'move');
  } else {
    const base = press.shift ? new Set(overlay.selection) : new Set<string>();
    if (!press.shift) overlay.selection = new Set();
    c.mode = { kind: 'marquee', start: world, base };
  }
  c.clearDots();
  overlay.request();
}
