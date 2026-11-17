import { Camera, Scene, type ShapeElement } from '@apeiro/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachControls } from '../input/controls';
import { Overlay } from '../overlay/overlay';
import { ToolState } from '../tools/tool-state';
import { activeBoard } from './active-board';
import { BoardEditor } from './board-editor';
import { Emitter } from './emitter';

const box = (id: string): ShapeElement => ({
  id,
  type: 'rect',
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  rotation: 0,
  z: 0,
  fill: 0xffffffff,
  stroke: 0,
  strokeWidth: 0,
  radius: 0,
});

/** A board with controls attached, without a renderer. */
function board(acceptsKeys: () => boolean) {
  const stage = document.createElement('div');
  const canvas = document.createElement('canvas');
  canvas.getContext = (() =>
    new Proxy({}, { get: () => () => undefined, set: () => true })) as never;
  document.body.append(stage, canvas);
  const scene = new Scene();
  scene.add(box('a'));
  const camera = new Camera();
  camera.setViewport(500, 500);
  const overlay = new Overlay(canvas, scene, camera);
  overlay.selection = new Set(['a']);
  const detach = attachControls(stage, scene, camera, overlay, new ToolState(), undefined, {
    acceptsKeys,
  });
  return { scene, detach };
}

describe('keyboard shortcuts with several boards on a page', () => {
  const detach: Array<() => void> = [];
  afterEach(() => {
    for (const d of detach.splice(0)) d();
    document.body.innerHTML = '';
  });

  it('go only to the board that accepts them', () => {
    let active: 'left' | 'right' = 'left';
    const left = board(() => active === 'left');
    const right = board(() => active === 'right');
    detach.push(left.detach, right.detach);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }));
    expect(left.scene.has('a')).toBe(false);
    expect(right.scene.has('a')).toBe(true);

    active = 'right';
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }));
    expect(right.scene.has('a')).toBe(false);
  });
});

describe('activeBoard', () => {
  it('routes keys to the pressed board, or to a board alone on the page', () => {
    const a = {};
    const b = {};
    const offA = activeBoard.mounted(a);
    expect(activeBoard.acceptsKeys(a, false)).toBe(true); // alone: no press needed
    expect(activeBoard.accepts(a, false)).toBe(false); // clipboard waits for pointer or press
    const offB = activeBoard.mounted(b);
    expect(activeBoard.acceptsKeys(a, false)).toBe(false);
    expect(activeBoard.acceptsKeys(b, true)).toBe(true); // under the pointer
    activeBoard.pressed(b);
    expect(activeBoard.acceptsKeys(a, true)).toBe(false);
    expect(activeBoard.accepts(b, false)).toBe(true);
    offB();
    expect(activeBoard.acceptsKeys(a, false)).toBe(true);
    offA();
  });
});

describe('editor events', () => {
  it('a throwing listener does not stop the others; the error is reported', () => {
    const onError = vi.fn();
    const editor = new BoardEditor({ onError });
    const after = vi.fn();
    editor.on('tool', () => {
      throw new Error('listener bug');
    });
    editor.on('tool', after);
    editor.setTool('rect');
    expect(after).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'listener bug' }));
    editor.destroy();
  });

  it('listeners may unsubscribe while being called', () => {
    const emitter = new Emitter<'x'>(() => undefined);
    const calls: string[] = [];
    const off = emitter.on('x', () => {
      calls.push('first');
      off();
    });
    emitter.on('x', () => calls.push('second'));
    emitter.emit('x');
    emitter.emit('x');
    expect(calls).toEqual(['first', 'second', 'second']);
  });
});
