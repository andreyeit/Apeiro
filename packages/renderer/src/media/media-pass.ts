import {
  audioLayout,
  effectiveRadius,
  imageSize,
  imageUv,
  isAllowedMediaSrc,
  isMedia,
  type MediaInfo,
  type ShapeElement,
} from '@apeiro/core';

type MediaElement = ShapeElement & { media: MediaInfo };
import {
  DEFAULT_AUDIO_STYLE,
  drawAudioWidget,
  type AudioCard,
  type AudioVisualState,
  type AudioWidgetStyle,
} from './audio-widget';
import type { MediaQuad, MediaSource, MediaTextures, TextureHandle } from '../backend';

/**
 * Longest side of an image texture; bigger images are downscaled on load (and never past
 * what the GPU takes). 4096 keeps photos sharp when zoomed in; with mipmaps one is ~90 MB
 * of GPU memory at most, and the texture budget below evicts what is off screen.
 */
const MAX_IMAGE_SIZE = 4096;
/** Files larger than this are not downloaded at all. */
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
/** Longest side of an audio player texture, px. */
const MAX_AUDIO_TEXTURE = 4096;
/** Textures beyond this many bytes get evicted, least recently used first. */
const TEXTURE_BUDGET = 256 * 1024 * 1024;
/** Retry delays after a failed load: doubles from the first to the last. */
const RETRY_FIRST_MS = 2000;
const RETRY_MAX_MS = 60_000;

export interface MediaPassOptions {
  /** Origins (e.g. `https://cdn.example.com`) media may be loaded from, besides the page's own. */
  allowedOrigins?: readonly string[];
  /** Full control over which `src` may be loaded; overrides `allowedOrigins`. */
  isAllowedSrc?: (src: string) => boolean;
}

export interface MediaDrawItem {
  el: ShapeElement;
  /** Depth of the element's slot (see depth.ts). */
  depth: number;
}

interface ImageEntry {
  /** `decoded`: bitmap ready, waiting for its turn to be uploaded (one per frame). */
  state: 'loading' | 'decoded' | 'ready' | 'error' | 'blocked';
  texture: TextureHandle | null;
  bitmap: ImageBitmap | null;
  /** Decoded size: the image's proportions when the element doesn't store them. */
  width: number;
  height: number;
  bytes: number;
  lastUsed: number;
  failures: number;
  retryAt: number;
}

interface AudioEntry {
  canvas: MediaSource;
  texture: TextureHandle;
  signature: string;
  bytes: number;
  lastUsed: number;
}

function createCanvas(w: number, h: number): MediaSource {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/**
 * CPU side of images and audio players. Images load in the background (fetch → decode →
 * downscale), are uploaded with mipmaps at most one per frame, and show a placeholder
 * meanwhile. Audio players are drawn with Canvas 2D into a texture, redrawn only when what
 * they show changes, at a resolution that follows the zoom.
 *
 * The owner reports when an image src or audio element is no longer used
 * (`releaseImage`, `releaseAudio`), so their textures are freed right away. Textures are
 * created by the backend (`MediaTextures`): this class decides what to upload and when,
 * and turns the visible elements into quads for the backend to draw.
 */
export class MediaPass {
  /** False while the GPU is lost: textures can be neither created nor freed. */
  private alive = false;
  private images = new Map<string, ImageEntry>();
  private audio = new Map<string, AudioEntry>();
  private audioState = new Map<string, AudioVisualState>();
  private audioStyle: AudioWidgetStyle = DEFAULT_AUDIO_STYLE;
  private audioStyleVersion = 0;
  /** Drawn colour of a stored element colour (the renderer's colour theme). */
  colorOf: (type: string, color: number) => number = (_type, color) => color;
  private frame = 0;
  private generation = 0;
  private errorLogged = false;
  private readonly allowed: (src: string) => boolean;

  constructor(
    private readonly textures: MediaTextures,
    private readonly requestRender: () => void,
    options: MediaPassOptions = {},
  ) {
    this.allowed =
      options.isAllowedSrc ?? ((src) => isAllowedMediaSrc(src, options.allowedOrigins ?? []));
  }

  /** True while any image is still loading, or decoded and visible but not uploaded yet. */
  get pending(): boolean {
    for (const e of this.images.values()) {
      if (e.state === 'loading') return true;
      if (e.state === 'decoded' && e.lastUsed >= this.frame - 1) return true;
    }
    return false;
  }

  /** The GPU is (again) available. */
  init(): void {
    this.alive = true;
    // Textures from a previous context are gone: everything reloads/redraws on demand.
    for (const e of this.images.values()) e.bitmap?.close();
    this.images.clear();
    this.audio.clear();
    this.generation++;
  }

  lose(): void {
    this.alive = false;
    this.generation++;
  }

  dispose(): void {
    for (const e of this.images.values()) {
      if (e.texture && this.alive) this.textures.release(e.texture);
      e.bitmap?.close();
    }
    if (this.alive) for (const e of this.audio.values()) this.textures.release(e.texture);
    this.images.clear();
    this.audio.clear();
    this.audioState.clear();
    this.alive = false;
  }

  setAudioState(id: string, state: AudioVisualState): void {
    this.audioState.set(id, state);
  }

  /** Colours of the audio players (e.g. on a theme switch); every player redraws. */
  setAudioStyle(style: Partial<AudioWidgetStyle>): void {
    this.audioStyle = { ...this.audioStyle, ...style };
    this.audioStyleVersion++;
  }

  /** No element uses this image any more: free its texture (an in-flight load is dropped). */
  releaseImage(src: string): void {
    const e = this.images.get(src);
    if (!e) return;
    if (e.texture && this.alive) this.textures.release(e.texture);
    e.bitmap?.close();
    this.images.delete(src);
  }

  /** The audio element is gone (or no longer audio): free its texture and playback state. */
  releaseAudio(id: string): void {
    const e = this.audio.get(id);
    if (e && this.alive) this.textures.release(e.texture);
    this.audio.delete(id);
    this.audioState.delete(id);
  }

  /** Quads for the visible media, in the given order; uploads what they need first. */
  prepare(items: MediaDrawItem[], x: number, y: number, zoom: number, dpr: number): MediaQuad[] {
    if (!this.alive || items.length === 0) return [];
    this.frame++;
    this.uploadOneDecoded();
    const quads: MediaQuad[] = [];
    const k = zoom * dpr; // device pixels per world unit
    for (const { el, depth } of items) {
      if (!isMedia(el)) continue;
      try {
        quads.push(this.quad(el, depth, x, y, k));
      } catch (e) {
        // Element data (from other participants, eventually) must not stop the frame:
        // this element shows the placeholder, everything else is drawn as usual.
        if (!this.errorLogged) {
          this.errorLogged = true;
          console.error('apeiro: a media element could not be drawn, showing a placeholder', e);
        }
        quads.push({
          rect: [el.x, el.y, el.w, el.h],
          rotation: el.rotation,
          depth,
          radius: 0,
          uv: [0, 0, 1, 1],
          texture: null,
        });
      }
    }
    this.evict();
    return quads;
  }

  private quad(el: MediaElement, depth: number, x: number, y: number, k: number): MediaQuad {
    let texture: TextureHandle | null;
    let rect: MediaQuad['rect'] = [el.x, el.y, el.w, el.h];
    let uv: MediaQuad['uv'];
    if (el.type === 'image') {
      texture = this.imageTexture(el.media.src);
      const decoded = this.images.get(el.media.src);
      const fit = imageUv(
        el,
        imageSize(el, decoded?.width ? { w: decoded.width, h: decoded.height } : null),
      );
      uv = [fit.u, fit.v, fit.du, fit.dv];
    } else {
      // Audio textures are drawn 1:1 to device pixels: the box is snapped to the pixel
      // grid and sized to the texture, so the thin controls stay sharp (no resampling).
      const a = this.audioTexture(el, k);
      texture = a.texture;
      uv = [0, 0, 1, 1]; // the player texture is the box
      if (el.rotation === 0 && a.scale === k) {
        const sx = Math.round((el.x - x) * k) / k + x;
        const sy = Math.round((el.y - y) * k) / k + y;
        rect = [sx, sy, a.width / k, a.height / k];
      }
    }
    return {
      rect,
      rotation: el.rotation,
      depth,
      radius: el.type === 'image' ? effectiveRadius(el) : 0,
      uv,
      // An image without one shows the placeholder: loading, failed or not allowed.
      texture,
    };
  }

  // --- Images -------------------------------------------------------------------

  private imageTexture(src: string): TextureHandle | null {
    let entry = this.images.get(src);
    if (!entry) {
      entry = {
        state: 'loading',
        texture: null,
        bitmap: null,
        width: 0,
        height: 0,
        bytes: 0,
        lastUsed: this.frame,
        failures: 0,
        retryAt: 0,
      };
      this.images.set(src, entry);
      if (this.allowed(src)) void this.load(src, entry, this.generation);
      else entry.state = 'blocked';
    } else if (entry.state === 'error' && performance.now() >= entry.retryAt) {
      entry.state = 'loading';
      void this.load(src, entry, this.generation);
    }
    entry.lastUsed = this.frame;
    return entry.state === 'ready' ? entry.texture : null;
  }

  private async load(src: string, entry: ImageEntry, generation: number): Promise<void> {
    const current = () => generation === this.generation && this.images.get(src) === entry;
    try {
      const response = await fetch(src, { credentials: 'omit' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (declared > MAX_IMAGE_BYTES) throw new Error('image too large');
      const blob = await response.blob();
      if (blob.size > MAX_IMAGE_BYTES) throw new Error('image too large');
      let bitmap = await createImageBitmap(blob);
      const limit = Math.min(MAX_IMAGE_SIZE, this.textures.maxTextureSize ?? MAX_IMAGE_SIZE);
      const k = Math.min(1, limit / Math.max(bitmap.width, bitmap.height));
      if (k < 1) {
        const w = Math.round(bitmap.width * k) || 1;
        const h = Math.round(bitmap.height * k) || 1;
        bitmap.close();
        bitmap = await createImageBitmap(blob, {
          resizeWidth: w,
          resizeHeight: h,
          resizeQuality: 'high',
        });
      }
      if (!current()) {
        bitmap.close();
        return; // context was lost/restored, or the image was released meanwhile
      }
      entry.bitmap = bitmap;
      entry.width = bitmap.width;
      entry.height = bitmap.height;
      entry.state = 'decoded';
      entry.failures = 0;
    } catch {
      if (!current()) return;
      entry.failures++;
      entry.state = 'error';
      // Retried when it's drawn again after a growing delay (network may come back).
      entry.retryAt =
        performance.now() + Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** (entry.failures - 1));
      setTimeout(() => this.requestRender(), entry.retryAt - performance.now() + 1);
    }
    this.requestRender();
  }

  /**
   * Uploads one decoded image: the canvas round-trip, upload and mipmap generation of a
   * 4096² image take noticeable time, so several images arriving at once are spread over frames.
   */
  private uploadOneDecoded(): void {
    let found: ImageEntry | null = null;
    let more = false;
    for (const e of this.images.values()) {
      if (e.state !== 'decoded') continue;
      if (found) {
        more = true;
        break;
      }
      found = e;
    }
    if (!found || !found.bitmap) return;
    const bitmap = found.bitmap;
    // Go through a 2D canvas so every backend premultiplies it the same way in every browser.
    const canvas = createCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d') as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D;
    ctx.drawImage(bitmap, 0, 0);
    found.texture = this.textures.upload(canvas, true);
    found.bytes = Math.round(bitmap.width * bitmap.height * 4 * 1.33);
    found.state = 'ready';
    found.bitmap = null;
    bitmap.close();
    if (more) this.requestRender();
  }

  // --- Audio players --------------------------------------------------------------

  private audioTexture(
    el: ShapeElement & { media: { peaks?: number[]; duration?: number } },
    devicePxPerWorld: number,
  ): { texture: TextureHandle; scale: number; width: number; height: number } {
    // Drawn at the exact device resolution (players are few and cheap to redraw), so
    // hairlines and text stay crisp at any zoom; very large ones are capped.
    const scale = Math.min(
      Math.max(devicePxPerWorld, 1e-3),
      MAX_AUDIO_TEXTURE / Math.max(el.w, el.h, 1e-3),
    );
    const state = this.audioState.get(el.id) ?? { playing: false, progress: 0 };
    const volume = el.volume ?? 1;
    const pw = Math.max(1, Math.round(el.w * scale));
    const ph = Math.max(1, Math.round(el.h * scale));
    const duration = el.media.duration ?? 0;
    // The time label changes once per second, the waveform at bar granularity.
    const card = this.audioCard(el);
    const signature = `${pw}x${ph}|${card.fill}|${card.stroke}|${card.strokeWidth}|${card.radius}|${volume.toFixed(3)}|${state.playing}|${Math.floor(state.progress * 400)}|${Math.floor(state.progress * duration)}|${duration}|${this.audioStyleVersion}|${el.media.peaks?.length ?? 0}:${el.media.peaks?.[0] ?? ''}`;
    let entry = this.audio.get(el.id);
    if (entry && entry.signature === signature) {
      entry.lastUsed = this.frame;
      return { texture: entry.texture, scale, width: pw, height: ph };
    }
    const canvas = entry?.canvas ?? createCanvas(pw, ph);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const ctx = canvas.getContext('2d') as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D;
    drawAudioWidget(
      ctx,
      el.w,
      el.h,
      scale,
      el.media.peaks,
      volume,
      state,
      this.audioStyle,
      duration,
      card,
    );
    if (entry) {
      entry.texture = this.textures.upload(canvas, false, entry.texture);
      entry.signature = signature;
      entry.bytes = pw * ph * 4;
      entry.lastUsed = this.frame;
    } else {
      entry = {
        canvas,
        texture: this.textures.upload(canvas, false),
        signature,
        bytes: pw * ph * 4,
        lastUsed: this.frame,
      };
      this.audio.set(el.id, entry);
    }
    return { texture: entry.texture, scale, width: pw, height: ph };
  }

  /** Background and border of a player: the element's own fill and stroke, none by default. */
  private audioCard(el: ShapeElement): AudioCard {
    const css = (c: number) => {
      const a = c & 255;
      if (a === 0) return null;
      return `rgba(${c >>> 24}, ${(c >>> 16) & 255}, ${(c >>> 8) & 255}, ${(a / 255).toFixed(3)})`;
    };
    return {
      fill: css(this.colorOf(el.type, el.fill)),
      stroke: el.strokeWidth > 0 ? css(this.colorOf(el.type, el.stroke)) : null,
      strokeWidth: el.strokeWidth,
      radius: el.radius > 0 ? el.radius : audioLayout(el.w, el.h).card.radius,
    };
  }

  /** Frees least recently used textures (not used this frame) while over budget. */
  private evict(): void {
    let total = 0;
    for (const e of this.images.values()) total += e.bytes;
    for (const e of this.audio.values()) total += e.bytes;
    if (total <= TEXTURE_BUDGET) return;
    const candidates: Array<{
      key: string;
      kind: 'image' | 'audio';
      lastUsed: number;
      bytes: number;
    }> = [];
    for (const [key, e] of this.images)
      if (e.state === 'ready' && e.lastUsed < this.frame)
        candidates.push({ key, kind: 'image', lastUsed: e.lastUsed, bytes: e.bytes });
    for (const [key, e] of this.audio)
      if (e.lastUsed < this.frame)
        candidates.push({ key, kind: 'audio', lastUsed: e.lastUsed, bytes: e.bytes });
    candidates.sort((a, b) => a.lastUsed - b.lastUsed);
    for (const c of candidates) {
      if (total <= TEXTURE_BUDGET) break;
      const tex =
        c.kind === 'image' ? this.images.get(c.key)!.texture : this.audio.get(c.key)!.texture;
      if (tex) this.textures.release(tex);
      if (c.kind === 'image') this.images.delete(c.key);
      else this.audio.delete(c.key);
      total -= c.bytes;
    }
  }
}
