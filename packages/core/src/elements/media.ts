import type { ShapeElement } from './element';
import type { Vec2 } from '../geometry/math';

/** File behind an image or audio element. Plain data, synced like the rest of the element. */
export interface MediaInfo {
  /** Where to load the file from: an object URL locally, a storage (S3) URL in the app. */
  src: string;
  mime?: string;
  name?: string;
  /** Intrinsic size of an image, px. */
  naturalWidth?: number;
  naturalHeight?: number;
  /** Audio length, seconds. */
  duration?: number;
  /**
   * Audio waveform: peak amplitude per bar, 0..1. Computed once on import and stored
   * with the element, so other viewers can draw it without downloading and decoding the file.
   */
  peaks?: number[];
}

/** Default size of a new audio player, world units. */
export const AUDIO_SIZE = { w: 320, h: 40 } as const;

/** Scales an intrinsic size down so its longer side is at most `max` (never up). */
export function fitMediaSize(width: number, height: number, max: number): { w: number; h: number } {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const k = Math.min(1, max / Math.max(w, h));
  return { w: w * k, h: h * k };
}

/** Parts of the audio player in the element's local box (top-left origin, unrotated). */
export interface AudioLayout {
  /** Card the controls sit on: the whole box with rounded corners. */
  card: { radius: number };
  play: { cx: number; cy: number; r: number };
  wave: { x: number; y: number; w: number; h: number };
  /** Time label, right-aligned at `x + w`, vertically centred on `y`; `size` is the font size. */
  time: { x: number; y: number; w: number; size: number };
  speaker: { cx: number; cy: number; size: number };
  /** Volume track: the knob moves along it; value 0 at x, 1 at x + w. */
  volume: { x: number; y: number; w: number; knob: number };
}

/** Layout of the player for a box size. Shared by the renderer and hit testing. */
export function audioLayout(w: number, h: number): AudioLayout {
  // The controls fill the box height, so the selection frame hugs the player.
  const pad = h * 0.08;
  const gap = h * 0.3;
  const r = h * 0.42;
  const play = { cx: pad + r, cy: h / 2, r };
  const volW = Math.min(w * 0.24, h * 2.4);
  const volX = w - pad - volW;
  const speakerSize = h * 0.36;
  const speaker = { cx: volX + speakerSize * 0.5, cy: h / 2, size: speakerSize };
  const knob = h * 0.1;
  const trackX = volX + speakerSize * 1.6;
  const volume = { x: trackX, y: h / 2, w: Math.max(4, w - pad - knob - trackX), knob };
  const timeW = h * 1.1;
  const time = { x: volX - gap - timeW, y: h / 2, w: timeW, size: h * 0.3 };
  const waveX = play.cx + r + gap;
  const wave = { x: waveX, y: h * 0.2, w: Math.max(8, time.x - gap * 0.5 - waveX), h: h * 0.6 };
  // A card (if the element has a fill or border) is a pill around the round play button.
  return { card: { radius: h / 2 }, play, wave, time, speaker, volume };
}

/** World point → element-local point (top-left origin, unrotated). */
function toBoxLocal(el: ShapeElement, p: Vec2): Vec2 {
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  const c = Math.cos(-el.rotation);
  const s = Math.sin(-el.rotation);
  const dx = p.x - cx;
  const dy = p.y - cy;
  return { x: dx * c - dy * s + el.w / 2, y: dx * s + dy * c + el.h / 2 };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export type AudioHit =
  | { part: 'play' }
  | { part: 'wave'; fraction: number }
  | { part: 'volume'; value: number };

/** Which control of an audio player is under a world point (`tolerance` in world units). */
export function hitTestAudio(el: ShapeElement, world: Vec2, tolerance = 0): AudioHit | null {
  if (el.type !== 'audio') return null;
  const p = toBoxLocal(el, world);
  const L = audioLayout(el.w, el.h);
  if (Math.hypot(p.x - L.play.cx, p.y - L.play.cy) <= L.play.r + tolerance) return { part: 'play' };
  const v = L.volume;
  if (
    p.x >= v.x - v.knob - tolerance &&
    p.x <= v.x + v.w + v.knob + tolerance &&
    Math.abs(p.y - v.y) <= v.knob * 2.2 + tolerance
  ) {
    return { part: 'volume', value: clamp01((p.x - v.x) / v.w) };
  }
  const wv = L.wave;
  if (
    p.x >= wv.x - tolerance &&
    p.x <= wv.x + wv.w + tolerance &&
    p.y >= wv.y - tolerance &&
    p.y <= wv.y + wv.h + tolerance
  ) {
    return { part: 'wave', fraction: clamp01((p.x - wv.x) / wv.w) };
  }
  return null;
}

/** Seek position (0..1) for a world point, for dragging along the waveform past its ends. */
export function audioSeekAt(el: ShapeElement, world: Vec2): number {
  const L = audioLayout(el.w, el.h);
  return clamp01((toBoxLocal(el, world).x - L.wave.x) / L.wave.w);
}

/** Volume (0..1) for a world point, for dragging the knob past the track's ends. */
export function audioVolumeAt(el: ShapeElement, world: Vec2): number {
  const L = audioLayout(el.w, el.h);
  return clamp01((toBoxLocal(el, world).x - L.volume.x) / L.volume.w);
}

/**
 * Peak amplitude per bar from decoded channel data, normalised so the loudest bar is 1.
 * Rounded to 3 decimals to keep the stored element small.
 */
export function computePeaks(channels: Float32Array[], bars: number): number[] {
  const length = channels[0]?.length ?? 0;
  if (length === 0 || bars <= 0) return [];
  const out = new Array<number>(bars).fill(0);
  const bucket = length / bars;
  for (let b = 0; b < bars; b++) {
    const from = Math.floor(b * bucket);
    const to = Math.max(from + 1, Math.floor((b + 1) * bucket));
    let peak = 0;
    for (const ch of channels) {
      for (let i = from; i < to && i < ch.length; i++) {
        const v = Math.abs(ch[i]!);
        if (v > peak) peak = v;
      }
    }
    out[b] = peak;
  }
  let max = 0; // a loop, not Math.max(...out): spreading a huge array overflows the stack
  for (const v of out) if (v > max) max = v;
  return max > 0 ? out.map((v) => Math.round((v / max) * 1000) / 1000) : out;
}

/**
 * Whether a media `src` may be loaded. Element data comes from other participants, so
 * loading any URL would let one of them make every viewer request an arbitrary address
 * (tracking, requests into the viewer's network). Allowed: `blob:`, `data:` images/audio,
 * the page's own origin and the explicitly listed origins (e.g. the storage/CDN).
 */
export function isAllowedMediaSrc(
  src: string,
  allowedOrigins: readonly string[] = [],
  pageOrigin: string | undefined = typeof location !== 'undefined' ? location.origin : undefined,
): boolean {
  let url: URL;
  try {
    url = new URL(src, pageOrigin);
  } catch {
    return false;
  }
  if (url.protocol === 'blob:') return true;
  if (url.protocol === 'data:') return /^data:(image|audio)\//i.test(src);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  return url.origin === pageOrigin || allowedOrigins.includes(url.origin);
}
