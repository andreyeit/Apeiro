import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIO_SIZE, Camera, Scene, audioLayout, type ShapeElement } from '@apeiro/core';
import { AudioController, type AudioPlayer } from './audio-controller';
import { attachControls } from '../input/controls';
import { ToolState } from '../tools/tool-state';
import { synthWav } from './import-files';
import { Overlay } from '../overlay/overlay';

class FakePlayer implements AudioPlayer {
  volume = 1;
  currentTime = 0;
  duration = 10;
  paused = true;
  private ended: Array<() => void> = [];
  constructor(public src: string) {}
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  addEventListener(_: 'ended', cb: () => void) {
    this.ended.push(cb);
  }
  end() {
    this.paused = true;
    for (const cb of this.ended) cb();
  }
}

const audioEl = (id: string, x = 0, y = 0): ShapeElement => ({
  id,
  type: 'audio',
  x,
  y,
  w: AUDIO_SIZE.w,
  h: AUDIO_SIZE.h,
  rotation: 0,
  z: 0,
  fill: 0,
  stroke: 0,
  strokeWidth: 0,
  radius: 0,
  volume: 0.5,
  media: { src: `blob:${id}`, duration: 10, peaks: [0.2, 1, 0.5] },
});

function setup() {
  const scene = new Scene();
  scene.add(audioEl('a'));
  scene.add(audioEl('b', 0, 200));
  const states = new Map<string, { playing: boolean; progress: number }>();
  const players = new Map<string, FakePlayer>();
  const controller = new AudioController(
    scene,
    { setAudioState: (id, s) => states.set(id, s) },
    (src) => {
      const p = new FakePlayer(src);
      players.set(src, p);
      return p;
    },
  );
  return { scene, states, players, controller };
}

describe('AudioController', () => {
  it('plays and pauses, using the element volume', () => {
    const { controller, players, states } = setup();
    controller.toggle('a');
    const p = players.get('blob:a')!;
    expect(p.paused).toBe(false);
    expect(p.volume).toBe(0.5);
    expect(states.get('a')).toEqual({ playing: true, progress: 0 });
    controller.toggle('a');
    expect(p.paused).toBe(true);
    expect(states.get('a')!.playing).toBe(false);
  });

  it('plays one element at a time', () => {
    const { controller, players } = setup();
    controller.toggle('a');
    controller.toggle('b');
    expect(players.get('blob:a')!.paused).toBe(true);
    expect(players.get('blob:b')!.paused).toBe(false);
  });

  it('seeks while paused and reports progress', () => {
    const { controller, players, states } = setup();
    controller.seek('a', 0.25);
    expect(players.get('blob:a')!.currentTime).toBe(2.5);
    expect(states.get('a')).toEqual({ playing: false, progress: 0.25 });
  });

  it('follows volume changes made on the element', () => {
    const { scene, controller, players } = setup();
    controller.toggle('a');
    scene.update('a', { volume: 0.1 });
    expect(players.get('blob:a')!.volume).toBe(0.1);
  });

  it('rewinds at the end and stops when the element is removed', () => {
    const { scene, controller, players, states } = setup();
    controller.toggle('a');
    const p = players.get('blob:a')!;
    p.currentTime = 10;
    p.end();
    expect(p.currentTime).toBe(0);
    expect(states.get('a')).toEqual({ playing: false, progress: 0 });
    controller.toggle('a');
    scene.remove('a');
    expect(p.paused).toBe(true);
  });
});

describe('audio player interactions', () => {
  let scene: Scene;
  let stage: HTMLElement;
  let overlay: Overlay;
  const audio = { toggle: vi.fn(), seek: vi.fn() };
  const L = audioLayout(AUDIO_SIZE.w, AUDIO_SIZE.h);
  const pointer = (type: string, x: number, y: number) =>
    stage.dispatchEvent(
      new PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: 1, bubbles: true }),
    );

  beforeEach(() => {
    audio.toggle.mockClear();
    audio.seek.mockClear();
    document.body.innerHTML = '<div id="stage"></div><canvas id="overlay"></canvas>';
    stage = document.getElementById('stage')!;
    stage.setPointerCapture = () => undefined;
    stage.releasePointerCapture = () => undefined;
    stage.hasPointerCapture = () => false;
    scene = new Scene();
    scene.add(audioEl('a'));
    const camera = new Camera();
    camera.setViewport(1000, 1000);
    const canvas = document.getElementById('overlay') as HTMLCanvasElement;
    canvas.getContext = (() =>
      new Proxy({}, { get: () => () => undefined, set: () => true })) as never;
    overlay = new Overlay(canvas, scene, camera);
    attachControls(stage, scene, camera, overlay, new ToolState(), undefined, { audio });
  });

  it('toggles playback with the play button without selecting', () => {
    pointer('pointerdown', L.play.cx, L.play.cy);
    pointer('pointerup', L.play.cx, L.play.cy);
    expect(audio.toggle).toHaveBeenCalledWith('a');
    expect(overlay.selection.size).toBe(0);
    expect((scene.get('a') as ShapeElement).x).toBe(0);
  });

  it('seeks by clicking and dragging along the waveform', () => {
    pointer('pointerdown', L.wave.x + L.wave.w * 0.5, L.wave.y + 4);
    pointer('pointermove', L.wave.x + L.wave.w * 0.75, 500); // vertical drift doesn't matter
    pointer('pointerup', L.wave.x + L.wave.w * 0.75, 500);
    expect(audio.seek.mock.calls[0]![1]).toBeCloseTo(0.5);
    expect(audio.seek.mock.calls.at(-1)![1]).toBeCloseTo(0.75);
  });

  it('drags the volume knob and restores it on Esc', () => {
    pointer('pointerdown', L.volume.x + L.volume.w * 0.2, L.volume.y);
    expect((scene.get('a') as ShapeElement).volume).toBeCloseTo(0.2);
    pointer('pointermove', L.volume.x + L.volume.w * 2, L.volume.y); // past the end
    expect((scene.get('a') as ShapeElement).volume).toBe(1);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect((scene.get('a') as ShapeElement).volume).toBe(0.5);
  });

  it('selects and moves the player when grabbed outside its controls', () => {
    pointer('pointerdown', 2, 2);
    pointer('pointermove', 52, 2);
    pointer('pointerup', 52, 2);
    expect(overlay.selection).toEqual(new Set(['a']));
    expect((scene.get('a') as ShapeElement).x).toBe(50);
  });
});

describe('synthWav', () => {
  it('writes a valid PCM16 mono WAV header', async () => {
    const blob = synthWav(1, 8000);
    const bytes = new DataView(await blob.arrayBuffer());
    const text = (o: number, n: number) =>
      String.fromCharCode(...Array.from({ length: n }, (_, i) => bytes.getUint8(o + i)));
    expect(text(0, 4)).toBe('RIFF');
    expect(text(8, 4)).toBe('WAVE');
    expect(bytes.getUint32(24, true)).toBe(8000);
    expect(bytes.getUint32(40, true)).toBe(8000 * 2);
    expect(blob.size).toBe(44 + 8000 * 2);
  });
});
