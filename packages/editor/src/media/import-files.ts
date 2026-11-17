import {
  AUDIO_SIZE,
  fitBox,
  computePeaks,
  fitMediaSize,
  isMedia,
  type Scene,
  type ShapeElement,
  type Vec2,
} from '@apeiro/core';
import { newId } from '../ids';

/** New images are scaled so their longer side is at most this (world units). */
export const IMAGE_MAX_SIZE = 480;
/** Waveform resolution stored with the element. */
export const WAVE_BARS = 120;
/** Corner radius of new images (world units); changeable like any corner radius. */
export const IMAGE_RADIUS = 6;

/**
 * Where a file lives. Locally an object URL; in the app this is where an upload to
 * storage (S3) plugs in, returning the file's URL.
 */
export type Uploader = (file: Blob) => Promise<string>;
export const localUploader: Uploader = async (file) => URL.createObjectURL(file);

/**
 * Revokes `blob:` URLs once no element in the scene refers to them any more, so the files
 * of deleted images/audio (or of a replaced board) don't stay in memory until the tab closes.
 * Returns the unsubscribe function.
 */
export function revokeUnusedObjectUrls(
  scene: Scene,
  revoke: (url: string) => void = (url) => URL.revokeObjectURL(url),
): () => void {
  const srcOf = new Map<string, string>();
  const refs = new Map<string, number>();
  const release = (src: string) => {
    const n = (refs.get(src) ?? 1) - 1;
    if (n > 0) refs.set(src, n);
    else {
      refs.delete(src);
      revoke(src);
    }
  };
  const track = (id: string, src: string | undefined) => {
    const old = srcOf.get(id);
    if (old === src) return;
    if (old !== undefined) release(old);
    if (src === undefined) srcOf.delete(id);
    else {
      srcOf.set(id, src);
      refs.set(src, (refs.get(src) ?? 0) + 1);
    }
  };
  for (const el of scene.all())
    if (isMedia(el) && el.media.src.startsWith('blob:')) track(el.id, el.media.src);
  return scene.subscribe((c) => {
    for (const id of c.removed) track(id, undefined);
    for (const el of [...c.added, ...c.updated]) {
      const src = isMedia(el) && el.media.src.startsWith('blob:') ? el.media.src : undefined;
      track(el.id, src);
    }
  });
}

export async function imageElement(
  file: Blob,
  name: string,
  center: Vec2,
  z: number,
  upload: Uploader = localUploader,
): Promise<ShapeElement> {
  const bitmap = await createImageBitmap(file);
  const naturalWidth = bitmap.width;
  const naturalHeight = bitmap.height;
  bitmap.close();
  const { w, h } = fitMediaSize(naturalWidth, naturalHeight, IMAGE_MAX_SIZE);
  return {
    id: newId('img'),
    type: 'image',
    x: center.x - w / 2,
    y: center.y - h / 2,
    w,
    h,
    rotation: 0,
    z,
    fill: 0,
    stroke: 0,
    strokeWidth: 0,
    radius: IMAGE_RADIUS,
    media: { src: await upload(file), mime: file.type, name, naturalWidth, naturalHeight },
  };
}

/**
 * Puts another file into an image element, as Figma's "Replace image": the box stays,
 * the new picture fills it (a crop of the old one doesn't apply to the new one).
 * One scene change; returns false if the element isn't an image.
 */
export async function replaceImage(
  scene: Scene,
  id: string,
  file: Blob,
  name: string,
  upload: Uploader = localUploader,
): Promise<boolean> {
  const bitmap = await createImageBitmap(file);
  const naturalWidth = bitmap.width;
  const naturalHeight = bitmap.height;
  bitmap.close();
  const src = await upload(file);
  const el = scene.get(id);
  if (!el || el.type !== 'image') return false;
  const media = { src, mime: file.type, name, naturalWidth, naturalHeight };
  scene.update(
    id,
    el.imageFit === 'fit'
      ? // Fit: the frame refits around the new picture, within the old frame.
        { media, ...fitBox(el, { w: naturalWidth, h: naturalHeight }) }
      : { media, imageFit: 'fill', crop: undefined },
  );
  return true;
}

/** Decodes the audio once to measure it and compute the stored waveform. */
export async function analyzeAudio(file: Blob): Promise<{ peaks?: number[]; duration?: number }> {
  try {
    const ctx = new OfflineAudioContext(1, 1, 44100);
    const audio = await ctx.decodeAudioData(await file.arrayBuffer());
    const channels = Array.from({ length: audio.numberOfChannels }, (_, i) =>
      audio.getChannelData(i),
    );
    return { peaks: computePeaks(channels, WAVE_BARS), duration: audio.duration };
  } catch {
    return {}; // undecodable here: the player still works, with a flat waveform
  }
}

export async function audioElement(
  file: Blob,
  name: string,
  center: Vec2,
  z: number,
  upload: Uploader = localUploader,
): Promise<ShapeElement> {
  const { peaks, duration } = await analyzeAudio(file);
  const { w, h } = AUDIO_SIZE;
  return {
    id: newId('aud'),
    type: 'audio',
    x: center.x - w / 2,
    y: center.y - h / 2,
    w,
    h,
    rotation: 0,
    z,
    fill: 0,
    stroke: 0,
    strokeWidth: 0,
    radius: 0,
    volume: 0.8,
    media: { src: await upload(file), mime: file.type, name, duration, peaks },
  };
}

export const isImageFile = (f: Blob) => f.type.startsWith('image/');
export const isAudioFile = (f: Blob) => f.type.startsWith('audio/');

/**
 * Adds images and audio files to the scene around `center`, stacked so they don't
 * overlap. Other file types are ignored. Returns the new element ids.
 *
 * A file that can't be read (corrupt, unsupported format, too large to decode) doesn't
 * stop the others: it is reported through `onError` and skipped.
 */
export async function importFiles(
  files: File[],
  center: Vec2,
  scene: Scene,
  upload: Uploader = localUploader,
  onError: (file: File, error: unknown) => void = () => undefined,
): Promise<string[]> {
  const ids: string[] = [];
  let y = center.y;
  for (const file of files) {
    const at = { x: center.x, y };
    const z = scene.maxZ() + 1;
    let el: ShapeElement | null = null;
    try {
      if (isImageFile(file)) el = await imageElement(file, file.name, at, z, upload);
      else if (isAudioFile(file)) el = await audioElement(file, file.name, at, z, upload);
    } catch (e) {
      onError(file, e);
      continue;
    }
    if (!el) continue;
    // Keep the first one centred at `center`, stack the rest below.
    el.y = y - (ids.length === 0 ? el.h / 2 : 0);
    y = el.y + el.h + 24;
    scene.add(el);
    ids.push(el.id);
  }
  return ids;
}

/** A short synthetic WAV (PCM16 mono): chords with a varying envelope, for demos and tests. */
export function synthWav(seconds = 4, sampleRate = 22050): Blob {
  const n = Math.floor(seconds * sampleRate);
  const data = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = 0.15 + 0.85 * Math.abs(Math.sin(t * 2.3)) * Math.exp(-((t % 1.1) * 1.5));
    const v =
      Math.sin(2 * Math.PI * 220 * t) * 0.5 +
      Math.sin(2 * Math.PI * 277 * t) * 0.3 +
      Math.sin(2 * Math.PI * 330 * t) * 0.2;
    data[i] = Math.max(-1, Math.min(1, v * env)) * 32767;
  }
  const header = new DataView(new ArrayBuffer(44));
  const text = (o: number, s: string) =>
    [...s].forEach((c, i) => header.setUint8(o + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  header.setUint32(4, 36 + data.byteLength, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true); // PCM
  header.setUint16(22, 1, true); // mono
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  text(36, 'data');
  header.setUint32(40, data.byteLength, true);
  return new Blob([header.buffer, data.buffer], { type: 'audio/wav' });
}
