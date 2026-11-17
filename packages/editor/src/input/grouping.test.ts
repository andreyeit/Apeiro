import { beforeEach, describe, expect, it } from 'vitest';
import { Camera, Scene, type ShapeElement } from '@apeiro/core';
import { attachControls } from './controls';
import { ToolState } from '../tools/tool-state';
import { enteredGroup, selectionAfterPress } from '../selection/grouping';
import { Overlay } from '../overlay/overlay';

const box = (id: string, x: number, y: number): ShapeElement => ({
  id,
  type: 'rect',
  x,
  y,
  w: 100,
  h: 100,
  rotation: 0,
  z: 0,
  fill: 0xffffffff,
  stroke: 0,
  strokeWidth: 0,
  radius: 0,
});

describe('controls: grouping', () => {
  let scene: Scene;
  let stage: HTMLElement;
  let overlay: Overlay;

  // Camera at zoom 1, origin at 0,0: screen == world.
  const pointer = (type: string, x: number, y: number, shiftKey = false, ctrlKey = false) =>
    stage.dispatchEvent(
      new PointerEvent(type, {
        clientX: x,
        clientY: y,
        button: 0,
        pointerId: 1,
        bubbles: true,
        shiftKey,
        ctrlKey,
      }),
    );
  const click = (x: number, y: number, shift = false) => {
    pointer('pointerdown', x, y, shift);
    pointer('pointerup', x, y, shift);
  };
  const key = (code: string, shiftKey = false) =>
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        code,
        key: code.slice(3).toLowerCase(),
        ctrlKey: true,
        shiftKey,
      }),
    );
  const selected = () => [...overlay.selection].sort();

  beforeEach(() => {
    document.body.innerHTML = '<div id="stage"></div><canvas id="overlay"></canvas>';
    stage = document.getElementById('stage')!;
    stage.setPointerCapture = () => undefined;
    stage.releasePointerCapture = () => undefined;
    stage.hasPointerCapture = () => false;
    scene = new Scene();
    scene.add(box('a', 0, 0));
    scene.add(box('b', 300, 0));
    scene.add(box('c', 600, 0));
    const camera = new Camera();
    camera.setViewport(1000, 1000);
    const canvas = document.getElementById('overlay') as HTMLCanvasElement;
    canvas.getContext = (() =>
      new Proxy({}, { get: () => () => undefined, set: () => true })) as never;
    overlay = new Overlay(canvas, scene, camera);
    attachControls(stage, scene, camera, overlay, new ToolState());
  });

  it('Ctrl+G groups the selection, Ctrl+Shift+G ungroups it', () => {
    overlay.selection = new Set(['a', 'b']);
    key('KeyG');
    const groupId = scene.get('a')!.groupId;
    expect(groupId).toBeTruthy();
    expect(scene.get('b')!.groupId).toBe(groupId);
    expect(scene.get('c')!.groupId).toBeUndefined();

    overlay.selection = new Set(['a']);
    key('KeyG', true);
    expect(scene.get('a')!.groupId).toBeUndefined();
    expect(scene.get('b')!.groupId).toBeUndefined();
    expect(selected()).toEqual(['a', 'b']);
  });

  it('a click selects the whole group; a second click goes inside to one element', () => {
    overlay.selection = new Set(['a', 'b']);
    key('KeyG');
    overlay.selection = new Set();

    click(350, 50); // on b
    expect(selected()).toEqual(['a', 'b']);
    click(350, 50); // again: just b
    expect(selected()).toEqual(['b']);
    expect(enteredGroup(scene, overlay.selection)?.sort()).toEqual(['a', 'b']);
    click(50, 50); // inside the group, the next element is picked alone
    expect(selected()).toEqual(['a']);
    click(650, 50); // outside: a plain element
    expect(selected()).toEqual(['c']);
    click(50, 50); // back to the group as a whole
    expect(selected()).toEqual(['a', 'b']);
  });

  it('dragging one element of a group moves the whole group', () => {
    overlay.selection = new Set(['a', 'b']);
    key('KeyG');
    overlay.selection = new Set();
    pointer('pointerdown', 50, 50);
    pointer('pointermove', 80, 70);
    pointer('pointerup', 80, 70);
    expect(scene.get('a')).toMatchObject({ x: 30, y: 20 });
    expect(scene.get('b')).toMatchObject({ x: 330, y: 20 });
    expect(scene.get('c')).toMatchObject({ x: 600, y: 0 });
    expect(selected()).toEqual(['a', 'b']); // a drag doesn't go inside
  });

  it('marquee touching one element selects its whole group', () => {
    overlay.selection = new Set(['a', 'b']);
    key('KeyG');
    overlay.selection = new Set();
    pointer('pointerdown', -50, 200);
    pointer('pointermove', 20, 50);
    pointer('pointerup', 20, 50);
    expect(selected()).toEqual(['a', 'b']);
  });

  it('Shift adds and removes whole groups', () => {
    overlay.selection = new Set(['a', 'b']);
    key('KeyG');
    let s = selectionAfterPress(scene, new Set(['c']), 'a', true);
    expect([...s.selection].sort()).toEqual(['a', 'b', 'c']);
    s = selectionAfterPress(scene, s.selection, 'b', true);
    // Removal waits for the release: a Shift+drag still moves the selection.
    expect([...s.selection].sort()).toEqual(['a', 'b', 'c']);
    expect([...s.onClick!]).toEqual(['c']);
  });

  it('Shift+click on a selected element deselects it; Shift+drag moves it instead', () => {
    overlay.selection = new Set(['a', 'c']);
    click(650, 50, true);
    expect(selected()).toEqual(['a']);
    pointer('pointerdown', 50, 50, true);
    pointer('pointermove', 90, 60, true);
    pointer('pointerup', 90, 60, true);
    expect(selected()).toEqual(['a']);
    expect(scene.get('a')).toMatchObject({ x: 40, y: 0 });
  });

  describe('Ctrl/⌘ deep select, like Figma', () => {
    const ctrlClick = (x: number, y: number, shift = false) => {
      pointer('pointerdown', x, y, shift, true);
      pointer('pointerup', x, y, shift, true);
    };
    beforeEach(() => {
      overlay.selection = new Set(['a', 'b']);
      key('KeyG');
      overlay.selection = new Set();
    });

    it('selects an element straight through its group', () => {
      ctrlClick(350, 50);
      expect(selected()).toEqual(['b']);
    });

    it('picks the element out of a selected group', () => {
      click(350, 50);
      expect(selected()).toEqual(['a', 'b']);
      ctrlClick(50, 50);
      expect(selected()).toEqual(['a']);
    });

    it('Ctrl+Shift adds single elements from groups', () => {
      click(650, 50);
      ctrlClick(350, 50, true);
      expect(selected()).toEqual(['b', 'c']);
      ctrlClick(350, 50, true); // and removes them again
      expect(selected()).toEqual(['c']);
    });

    it('Ctrl+drag moves only the element, not its group', () => {
      pointer('pointerdown', 50, 50, false, true);
      pointer('pointermove', 80, 70, false, true);
      pointer('pointerup', 80, 70, false, true);
      expect(scene.get('a')).toMatchObject({ x: 30, y: 20 });
      expect(scene.get('b')).toMatchObject({ x: 300, y: 0 });
    });

    it('Ctrl+marquee selects only the elements it touches', () => {
      pointer('pointerdown', -50, 200, false, true);
      pointer('pointermove', 20, 50, false, true);
      pointer('pointerup', 20, 50, false, true);
      expect(selected()).toEqual(['a']);
    });

    it('releasing Ctrl mid-marquee switches back to whole groups', () => {
      pointer('pointerdown', -50, 200, false, true);
      pointer('pointermove', 20, 50, false, true);
      expect(selected()).toEqual(['a']);
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', code: 'ControlLeft' }));
      expect(selected()).toEqual(['a', 'b']);
      pointer('pointerup', 20, 50);
    });

    it('shows the plain arrow over elements while Ctrl is held', () => {
      pointer('pointermove', 50, 50);
      expect(stage.style.cursor).toBe('move');
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Control', code: 'ControlLeft', ctrlKey: true }),
      );
      expect(stage.style.cursor).toBe(''); // switches without moving the pointer
      pointer('pointerdown', 50, 50, false, true);
      expect(stage.style.cursor).toBe(''); // and stays during a Ctrl+drag
      pointer('pointerup', 50, 50, false, true);
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', code: 'ControlLeft' }));
      expect(stage.style.cursor).toBe('move');
    });

    it('hover outlines the element, not the group frame, while Ctrl is held', () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Control', code: 'ControlLeft', ctrlKey: true }),
      );
      expect(overlay.deep).toBe(true);
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', code: 'ControlLeft' }));
      expect(overlay.deep).toBe(false);
    });
  });
});

describe('Shift+drag locks the move to one axis, like Figma', () => {
  let scene: Scene;
  let stage: HTMLElement;
  const pointer = (type: string, x: number, y: number, shiftKey = false) =>
    stage.dispatchEvent(
      new PointerEvent(type, {
        clientX: x,
        clientY: y,
        button: 0,
        pointerId: 1,
        bubbles: true,
        shiftKey,
      }),
    );

  beforeEach(() => {
    document.body.innerHTML = '<div id="stage"></div><canvas id="overlay"></canvas>';
    stage = document.getElementById('stage')!;
    stage.setPointerCapture = () => undefined;
    stage.releasePointerCapture = () => undefined;
    stage.hasPointerCapture = () => false;
    scene = new Scene();
    scene.add(box('a', 0, 0));
    const camera = new Camera();
    camera.setViewport(1000, 1000);
    const canvas = document.getElementById('overlay') as HTMLCanvasElement;
    canvas.getContext = (() =>
      new Proxy({}, { get: () => () => undefined, set: () => true })) as never;
    attachControls(stage, scene, camera, new Overlay(canvas, scene, camera), new ToolState());
  });

  it('moves along the dominant axis only', () => {
    pointer('pointerdown', 50, 50, true);
    pointer('pointermove', 130, 70, true); // mostly right
    expect(scene.get('a')).toMatchObject({ x: 80, y: 0 });
    pointer('pointermove', 70, 160, true); // now mostly down
    expect(scene.get('a')).toMatchObject({ x: 0, y: 110 });
    pointer('pointerup', 70, 160, true);
  });

  it('pressing or releasing Shift mid-drag switches the lock right away', () => {
    pointer('pointerdown', 50, 50);
    pointer('pointermove', 130, 70);
    expect(scene.get('a')).toMatchObject({ x: 80, y: 20 });
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Shift', code: 'ShiftLeft', shiftKey: true }),
    );
    expect(scene.get('a')).toMatchObject({ x: 80, y: 0 });
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', code: 'ShiftLeft' }));
    expect(scene.get('a')).toMatchObject({ x: 80, y: 20 });
    pointer('pointerup', 130, 70);
  });
});
