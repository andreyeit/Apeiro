import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardEditor } from './board-editor';
import { attachControls } from '../input/controls';
import { Overlay } from '../overlay/overlay';

let editor: BoardEditor;
let stage: HTMLDivElement;
let dispose: (() => void) | undefined;
beforeEach(() => {
  editor = new BoardEditor();
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  editor.destroy();
  document.body.innerHTML = '';
});

function controls() {
  stage = document.createElement('div');
  document.body.append(stage);
  stage.setPointerCapture = () => undefined;
  stage.releasePointerCapture = () => undefined;
  stage.hasPointerCapture = () => false;
  editor.camera.setViewport(800, 600);
  const canvas = document.createElement('canvas');
  canvas.getContext = (() =>
    new Proxy({}, { get: () => () => undefined, set: () => true })) as never;
  const overlay = new Overlay(canvas, editor.scene, editor.camera);
  dispose = attachControls(
    stage,
    editor.scene,
    editor.camera,
    overlay,
    editor.tools,
    editor.animator,
    {
      history: editor.history,
      place: (kind, at, box) => {
        editor.place(kind, at, box);
      },
      readOnly: () => editor.readOnly,
    },
  );
}
const pointer = (type: string, x = 50, y = 60) =>
  stage.dispatchEvent(
    new PointerEvent(type, {
      clientX: x,
      clientY: y,
      button: 0,
      pointerId: 1,
      bubbles: true,
    }),
  );

describe('tool settings and activation', () => {
  it('changes only future elements, with stable defaults and no history entry', () => {
    const id = editor.place('rect')!;
    const previous = editor.scene.get(id);
    const changes = vi.fn();
    editor.scene.subscribe(changes);
    editor.history.clear();
    editor.tools.setDefaults('rect', { fill: 42, w: 250, strokeStyle: 'dashed' });
    expect(editor.scene.get(id)).toBe(previous);
    expect(changes).not.toHaveBeenCalled();
    expect(editor.canUndo).toBe(false);
    const settings = editor.tools.getDefaults('rect');
    editor.tools.setDefaults('rect', { fill: 42 });
    expect(editor.tools.getDefaults('rect')).toBe(settings);
    const next = editor.place('rect')!;
    expect(editor.scene.get(next)).toMatchObject({ fill: 42, w: 250, strokeStyle: 'dashed' });
    expect(editor.scene.get(id)).toBe(previous);
  });

  it('applies sticky and text defaults at creation', () => {
    editor.tools.setDefaults('sticky', { fill: 19, w: 200, h: 300 });
    editor.tools.setDefaults('text', { color: 29, fontSize: 40 });
    const sticky = editor.place('sticky')!;
    const text = editor.addText()!;
    expect(editor.scene.get(sticky)).toMatchObject({ fill: 19, w: 200, h: 300 });
    expect(editor.scene.get(text)).toMatchObject({
      w: 20,
      h: 52,
      text: { color: 29, fontSize: 40 },
    });
  });

  it('keeps a repeating shape tool active and returns to select for a one-shot tool', () => {
    controls();
    editor.setTool('rect', { repeat: true });
    pointer('pointerdown');
    pointer('pointerup');
    expect(editor.tool).toBe('rect');
    pointer('pointerdown', 250);
    pointer('pointerup', 250);
    expect(editor.scene.size).toBe(2);
    editor.setTool('ellipse');
    pointer('pointerdown', 400);
    pointer('pointerup', 400);
    expect(editor.tool).toBe('select');
    expect(editor.scene.size).toBe(3);
  });
});

describe('registered tools', () => {
  const register = (onCancel = vi.fn()) => {
    let id: string;
    return editor.tools.register('stamp', {
      cursor: 'copy',
      onPointerDown: ({ point }) => {
        id = editor.place('sticky', point)!;
      },
      onPointerMove: ({ point }) => editor.updateElements([id], { x: point.x }),
      onCancel,
    });
  };

  it('receives world coordinates, captures a gesture into one undo step and repeats', () => {
    controls();
    register();
    editor.setTool('stamp', { repeat: true });
    pointer('pointerdown');
    pointer('pointermove', 120);
    pointer('pointermove', 160);
    pointer('pointerup', 160);
    expect(editor.scene.size).toBe(1);
    expect([...editor.scene.all()][0]).toMatchObject({
      x: editor.camera.screenToWorld({ x: 160, y: 60 }).x,
    });
    expect(editor.tool).toBe('stamp');
    editor.undo();
    expect(editor.scene.size).toBe(0);
    expect(editor.canUndo).toBe(false);
    editor.redo();
    expect(editor.scene.size).toBe(1);
  });

  it.each(['escape', 'pointercancel', 'switch', 'unregister', 'unmount'])(
    'cancels a custom gesture on %s without leaving content or history',
    (reason) => {
      controls();
      const cancel = vi.fn();
      const unregister = register(cancel);
      editor.setTool('stamp');
      pointer('pointerdown');
      pointer('pointermove', 100);
      if (reason === 'escape')
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      if (reason === 'pointercancel') pointer('pointercancel');
      if (reason === 'switch') editor.setTool('rect');
      if (reason === 'unregister') unregister();
      if (reason === 'unmount') {
        dispose?.();
        dispose = undefined;
      }
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(editor.scene.size).toBe(0);
      expect(editor.canUndo).toBe(false);
    },
  );

  it('does not roll back remote changes when cancelling a gesture', () => {
    controls();
    register();
    editor.setTool('stamp');
    pointer('pointerdown');
    const id = [...editor.scene.all()][0]!.id;
    editor.scene.transact(() => editor.scene.update(id, { fill: 77 }), 'remote');
    pointer('pointercancel');
    expect(editor.scene.get(id)).toMatchObject({ fill: 77 });
  });

  it('commits a one-shot custom tool before switching back to selection', () => {
    controls();
    register();
    editor.setTool('stamp');
    pointer('pointerdown');
    pointer('pointerup');
    expect(editor.tool).toBe('select');
    expect(editor.scene.size).toBe(1);
    expect(editor.canUndo).toBe(true);
  });

  it('cancels an active custom tool when becoming read-only', () => {
    editor.setPresence({
      getPeers: () => [],
      getLocks: () => new Map(),
      subscribe: () => () => undefined,
    });
    controls();
    register();
    editor.setTool('stamp');
    pointer('pointerdown');
    editor.setReadOnly(true);
    expect(editor.scene.size).toBe(0);
    expect(editor.canUndo).toBe(false);
  });

  it('cannot activate editing tools on a read-only board', () => {
    register();
    editor.setReadOnly(true);
    editor.setTool('stamp');
    expect(editor.tool).toBe('select');
    expect(() => editor.tools.register('rect', {})).toThrow(/reserved/);
    expect(() => editor.setTool('missing')).not.toThrow(); // Refused by readOnly first.
    editor.setReadOnly(false);
    expect(() => editor.setTool('missing')).toThrow(/Register/);
  });
});
