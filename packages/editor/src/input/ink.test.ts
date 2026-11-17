import { Camera, Scene } from '@apeiro/core';
import { afterEach, describe, expect, it } from 'vitest';
import { Overlay } from '../overlay/overlay';
import { ToolState } from '../tools/tool-state';
import { attachControls } from './controls';

describe('pen: coalesced pointer events', () => {
  let detach: () => void = () => undefined;
  afterEach(() => {
    detach();
    document.body.innerHTML = '';
  });

  it('adds every coalesced position with one scene change per pointermove', () => {
    const stage = document.createElement('div');
    stage.setPointerCapture = () => undefined;
    stage.releasePointerCapture = () => undefined;
    stage.hasPointerCapture = () => false;
    const canvas = document.createElement('canvas');
    canvas.getContext = (() =>
      new Proxy({}, { get: () => () => undefined, set: () => true })) as never;
    document.body.append(stage, canvas);
    const scene = new Scene();
    const camera = new Camera();
    camera.setViewport(1000, 1000);
    const tools = new ToolState();
    tools.setTool('pen');
    detach = attachControls(stage, scene, camera, new Overlay(canvas, scene, camera), tools);

    const event = (type: string, x: number, y: number) =>
      new PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: 1, bubbles: true });
    stage.dispatchEvent(event('pointerdown', 10, 10));
    let batches = 0;
    const off = scene.subscribe(() => batches++);
    const move = event('pointermove', 40, 10);
    const coalesced = [event('pointermove', 20, 10), event('pointermove', 30, 10), move];
    Object.defineProperty(move, 'getCoalescedEvents', { value: () => coalesced });
    stage.dispatchEvent(move);
    off();
    stage.dispatchEvent(event('pointerup', 40, 10));

    expect(batches).toBe(1);
    const ink = scene.sortedByZ().find((el) => el.type === 'ink');
    expect(ink).toBeDefined();
    expect(ink!.type === 'ink' && ink!.w).toBeCloseTo(30);
  });
});
