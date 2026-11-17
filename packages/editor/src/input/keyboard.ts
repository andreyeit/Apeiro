import { translateElements } from '@apeiro/core';
import { groupSelection, ungroupSelection } from '../selection/grouping';
import { VIEW_TOOLS } from '../tools/tool-state';
import { ARROWS, SHIFT_TOOL_KEYS, SHIFT_ZOOM, TOOL_KEYS } from './constants';
import { InputContext } from './context';
import { stopCrop, toggleCrop } from './crop';

/** Keys typed into a form field or editable text of the page are not board shortcuts. */
export const isTypingTarget = (t: EventTarget | null): boolean =>
  t instanceof HTMLInputElement ||
  t instanceof HTMLSelectElement ||
  t instanceof HTMLTextAreaElement ||
  (t instanceof HTMLElement && t.isContentEditable);

/** Latin letter of the key (by its position), or the typed key when the code is unknown. */
const letterOf = (e: KeyboardEvent): string =>
  e.code.startsWith('Key') ? e.code.slice(3) : e.key.toUpperCase();

/**
 * Board shortcuts (Figma/Miro). Shortcuts go by physical key (`e.code`) where a letter is
 * involved, so they work with any keyboard layout. `cancelGesture` handles Esc mid-gesture.
 */
export function handleShortcut(
  c: InputContext,
  e: KeyboardEvent,
  cancelGesture: () => boolean,
): void {
  const { overlay, scene, tools, hooks } = c;
  const mod = e.ctrlKey || e.metaKey;
  const plain = !mod && !e.altKey;
  const ro = c.readOnly();
  const letter = letterOf(e);

  if (e.code === 'Space') {
    if (c.spaceDown) return;
    c.spaceDown = true;
    if (c.mode.kind === 'idle') c.setCursor('grab');
    e.preventDefault();
    return;
  }
  if (e.key === 'Escape') {
    if (cancelGesture()) return;
    if (stopCrop(c)) return; // Esc leaves crop mode, keeping the image selected
    overlay.selection = new Set();
    tools.setTool('select');
    overlay.request();
    return;
  }
  if (c.mode.kind !== 'idle') return; // no other shortcuts mid-gesture

  if (hooks.history && !ro && mod && !e.altKey && (e.code === 'KeyZ' || e.code === 'KeyY')) {
    e.preventDefault();
    const redo = e.code === 'KeyY' || e.shiftKey;
    const ids = redo ? hooks.history.redo() : hooks.history.undo();
    overlay.selection = new Set(ids);
    overlay.hover = null;
    overlay.anchorsFor = null;
    overlay.request();
  } else if (ARROWS[e.key] && overlay.selection.size > 0 && !mod && !ro) {
    // Nudge like in Figma: 1 unit, 10 with Shift.
    e.preventDefault();
    const [dx, dy] = ARROWS[e.key]!;
    const step = e.shiftKey ? 10 : 1;
    c.applyPatches(translateElements(c.selectedElements(), dx * step, dy * step));
    overlay.request();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && !ro) {
    scene.removeWithConnectors(overlay.selection);
    overlay.selection = new Set();
    overlay.request();
  } else if (mod && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    overlay.selection = new Set(Array.from(scene.all(), (x) => x.id));
    overlay.request();
  } else if (
    plain &&
    !e.shiftKey &&
    TOOL_KEYS[letter] &&
    (!ro || VIEW_TOOLS.has(TOOL_KEYS[letter]!))
  ) {
    tools.setTool(TOOL_KEYS[letter]!);
  } else if (plain && e.shiftKey && SHIFT_TOOL_KEYS[letter] && !ro) {
    tools.setTool(SHIFT_TOOL_KEYS[letter]!);
  } else if (mod && !e.altKey && e.code === 'KeyG' && !ro) {
    // Ctrl+G groups, Ctrl+Shift+G ungroups.
    e.preventDefault();
    const next = e.shiftKey
      ? ungroupSelection(scene, overlay.selection)
      : groupSelection(scene, overlay.selection);
    if (next) overlay.selection = next;
    overlay.request();
  } else if (mod && e.shiftKey && !e.altKey && letter === 'K' && !ro) {
    e.preventDefault();
    hooks.pickImage?.();
  } else if (plain && e.shiftKey && hooks.zoom && SHIFT_ZOOM[e.code]) {
    e.preventDefault();
    hooks.zoom(SHIFT_ZOOM[e.code]!);
  } else if (
    hooks.zoom &&
    mod &&
    !e.altKey &&
    (e.key === '=' || e.key === '+' || e.key === '-' || e.key === '_')
  ) {
    e.preventDefault(); // not the browser's page zoom
    hooks.zoom(e.key === '-' || e.key === '_' ? 'out' : 'in');
  } else if (plain && e.key === 'Enter' && overlay.selection.size === 1 && !ro) {
    const only = scene.get(overlay.selection.values().next().value!);
    if (only?.type === 'image') {
      e.preventDefault();
      toggleCrop(c, only.id);
    } else if (InputContext.editable(only)) {
      e.preventDefault(); // the Enter must not reach the editor as a new line
      hooks.editText?.(only.id);
    }
  } else if (plain && (e.key === '=' || e.key === '+')) {
    zoomStep(c, 1.25);
  } else if (plain && (e.key === '-' || e.key === '_')) {
    zoomStep(c, 0.8);
  }
}

/** Zooms around the middle of the viewport. */
function zoomStep(c: InputContext, factor: number): void {
  const { camera } = c;
  c.animator.zoomAt({ x: camera.viewportWidth / 2, y: camera.viewportHeight / 2 }, factor);
}
