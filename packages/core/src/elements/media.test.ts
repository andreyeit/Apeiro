import { describe, expect, it } from 'vitest';
import {
  AUDIO_SIZE,
  audioLayout,
  audioSeekAt,
  audioVolumeAt,
  computePeaks,
  fitMediaSize,
  hitTestAudio,
} from './media';
import { isMedia } from './element';
import { makeRect } from '../test-utils';

const audio = (patch = {}) =>
  makeRect('au', { type: 'audio', x: 100, y: 100, w: AUDIO_SIZE.w, h: AUDIO_SIZE.h, ...patch });

describe('fitMediaSize', () => {
  it('scales the longer side down to the limit, keeping the aspect ratio', () => {
    expect(fitMediaSize(2000, 1000, 500)).toEqual({ w: 500, h: 250 });
    expect(fitMediaSize(300, 600, 500)).toEqual({ w: 250, h: 500 });
    expect(fitMediaSize(100, 50, 500)).toEqual({ w: 100, h: 50 }); // never up
  });
});

describe('audio player layout and hit testing', () => {
  it('places play, waveform and volume left to right without overlap', () => {
    const L = audioLayout(AUDIO_SIZE.w, AUDIO_SIZE.h);
    expect(L.play.cx + L.play.r).toBeLessThan(L.wave.x);
    expect(L.wave.x + L.wave.w).toBeLessThan(L.speaker.cx - L.speaker.size / 2);
    expect(L.speaker.cx + L.speaker.size / 2).toBeLessThan(L.volume.x);
    expect(L.volume.x + L.volume.w + L.volume.knob).toBeLessThanOrEqual(AUDIO_SIZE.w);
  });

  it('finds the control under a point', () => {
    const el = audio();
    const L = audioLayout(el.w, el.h);
    expect(hitTestAudio(el, { x: 100 + L.play.cx, y: 100 + L.play.cy })).toEqual({ part: 'play' });
    const mid = hitTestAudio(el, { x: 100 + L.wave.x + L.wave.w / 2, y: 100 + L.wave.y + 2 });
    expect(mid).toMatchObject({ part: 'wave' });
    expect((mid as { fraction: number }).fraction).toBeCloseTo(0.5);
    const vol = hitTestAudio(el, { x: 100 + L.volume.x + L.volume.w * 0.25, y: 100 + L.volume.y });
    expect(vol).toMatchObject({ part: 'volume' });
    expect((vol as { value: number }).value).toBeCloseTo(0.25);
    expect(hitTestAudio(el, { x: 100 + 2, y: 100 + 2 })).toBeNull(); // empty corner: select/drag
    expect(hitTestAudio(makeRect('r'), { x: 1, y: 1 })).toBeNull();
  });

  it('follows the element rotation', () => {
    const el = audio({ x: 0, y: 0, rotation: Math.PI }); // upside down
    const L = audioLayout(el.w, el.h);
    // Play button is now on the right side.
    expect(hitTestAudio(el, { x: el.w - L.play.cx, y: el.h - L.play.cy })).toEqual({
      part: 'play',
    });
  });

  it('clamps seek and volume while dragging past the ends', () => {
    const el = audio();
    expect(audioSeekAt(el, { x: -1000, y: 0 })).toBe(0);
    expect(audioSeekAt(el, { x: 5000, y: 0 })).toBe(1);
    expect(audioVolumeAt(el, { x: 5000, y: 999 })).toBe(1);
  });
});

describe('computePeaks', () => {
  it('takes the max absolute value per bar across channels, normalised', () => {
    const left = Float32Array.from([0, 0.1, -0.5, 0.2, 0, 0, 0.05, 0]);
    const right = Float32Array.from([0, 0, 0, 0, 0.25, -0.1, 0, 0]);
    expect(computePeaks([left, right], 4)).toEqual([0.2, 1, 0.5, 0.1]);
  });

  it('handles silence and empty input', () => {
    expect(computePeaks([new Float32Array(10)], 2)).toEqual([0, 0]);
    expect(computePeaks([], 4)).toEqual([]);
  });
});

describe('isMedia', () => {
  it('needs a media payload on an image or audio element', () => {
    expect(isMedia(makeRect('i', { type: 'image', media: { src: 'blob:x' } }))).toBe(true);
    expect(isMedia(makeRect('i', { type: 'image' }))).toBe(false);
    expect(isMedia(makeRect('r', { media: { src: 'blob:x' } }))).toBe(false);
  });
});
