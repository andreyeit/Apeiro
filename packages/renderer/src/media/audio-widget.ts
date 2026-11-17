import { audioLayout } from '@apeiro/core';

/** Playback state of one audio element, owned by whoever plays the audio. */
export interface AudioVisualState {
  playing: boolean;
  /** 0..1 */
  progress: number;
}

/**
 * Colours of the player controls. Defaults follow the board's light theme (zinc neutrals,
 * like the toolbar and panels); the app passes its dark tokens through `setAudioStyle`.
 */
export interface AudioWidgetStyle {
  /** Play button, played part of the waveform, volume level. */
  primary: string;
  /** Icon on the play button. */
  primaryForeground: string;
  /** Unplayed waveform bars and the empty volume track. */
  track: string;
  /** Speaker icon and time label. */
  ink: string;
  /** Font family of the time label. */
  font: string;
}

export const DEFAULT_AUDIO_STYLE: AudioWidgetStyle = {
  primary: '#18181b',
  primaryForeground: '#fafafa',
  track: '#d4d4d8',
  ink: '#71717a',
  font: "'Geist Mono', 'JetBrains Mono', ui-monospace, monospace",
};

/**
 * Optional card behind the controls, from the element's own fill and border. Absent
 * (or transparent / zero width) by default: the player sits right on the board.
 */
export interface AudioCard {
  /** CSS colour, or null for no fill. */
  fill: string | null;
  /** CSS colour, or null for no border. */
  stroke: string | null;
  /** Border width, world units. */
  strokeWidth: number;
  /** Corner radius, world units. */
  radius: number;
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const BAR_PITCH = 3.6; // world units per waveform bar (bar + gap)
const BAR_WIDTH = 1.6;

/** `m:ss` (or `h:mm:ss`) for a time in seconds. */
export function formatAudioTime(seconds: number): string {
  const t = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const s = String(t % 60).padStart(2, '0');
  const m = Math.floor(t / 60);
  if (m < 60) return `${m}:${s}`;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${s}`;
}

/**
 * Draws the audio player: a small round play/pause button, a fine waveform (played part
 * in the primary colour), a time label, a line speaker icon and a hairline volume slider.
 * Transparent by default; `card` adds a fill and/or border behind it. `scale` maps world
 * units to canvas pixels; `duration` (seconds, 0 if unknown) feeds the time label.
 */
export function drawAudioWidget(
  ctx: Ctx2D,
  w: number,
  h: number,
  scale: number,
  peaks: readonly number[] | undefined,
  volume: number,
  state: AudioVisualState,
  style: AudioWidgetStyle = DEFAULT_AUDIO_STYLE,
  duration = 0,
  card?: AudioCard,
): void {
  const L = audioLayout(w, h);
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Card: only what the element asks for. The border stays inside the box.
  if (card && (card.fill || (card.stroke && card.strokeWidth > 0))) {
    const sw = card.stroke ? Math.min(card.strokeWidth, h / 4) : 0;
    ctx.beginPath();
    roundRect(ctx, sw / 2, sw / 2, w - sw, h - sw, Math.max(0, card.radius - sw / 2));
    if (card.fill) {
      ctx.fillStyle = card.fill;
      ctx.fill();
    }
    if (card.stroke && sw > 0) {
      ctx.lineWidth = sw;
      ctx.strokeStyle = card.stroke;
      ctx.stroke();
    }
  }

  // Play / pause: small filled disc with a light glyph.
  const { cx, cy, r } = L.play;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = style.primary;
  ctx.fill();
  ctx.fillStyle = style.primaryForeground;
  ctx.strokeStyle = style.primaryForeground;
  if (state.playing) {
    const bw = r * 0.16;
    const bh = r * 0.72;
    ctx.beginPath();
    roundRect(ctx, cx - r * 0.2 - bw / 2, cy - bh / 2, bw, bh, bw / 2);
    roundRect(ctx, cx + r * 0.2 - bw / 2, cy - bh / 2, bw, bh, bw / 2);
    ctx.fill();
  } else {
    // Slightly rounded triangle, nudged right so it looks optically centred.
    const s = r * 0.36;
    ctx.beginPath();
    ctx.moveTo(cx - s * 0.6, cy - s);
    ctx.lineTo(cx + s * 1.0, cy);
    ctx.lineTo(cx - s * 0.6, cy + s);
    ctx.closePath();
    ctx.lineWidth = r * 0.08;
    ctx.stroke();
    ctx.fill();
  }

  // Waveform: fine bars resampled from the stored peaks to fit the width.
  const wv = L.wave;
  const bars = Math.max(1, Math.floor(wv.w / BAR_PITCH));
  const offset = (wv.w - bars * BAR_PITCH) / 2;
  const played = state.progress * bars;
  for (const pass of [false, true]) {
    ctx.fillStyle = pass ? style.primary : style.track;
    ctx.beginPath();
    for (let i = 0; i < bars; i++) {
      if (i < played !== pass) continue;
      const v = peaks && peaks.length > 0 ? sample(peaks, (i + 0.5) / bars) : 0.15;
      const bh = Math.max(BAR_WIDTH, v * wv.h);
      const x = wv.x + offset + i * BAR_PITCH + (BAR_PITCH - BAR_WIDTH) / 2;
      roundRect(ctx, x, wv.y + (wv.h - bh) / 2, BAR_WIDTH, bh, BAR_WIDTH / 2);
    }
    ctx.fill();
  }

  // Time: elapsed while playing or paused mid-track, otherwise the length.
  const tm = L.time;
  const started = state.playing || state.progress > 0;
  const label =
    duration > 0 ? formatAudioTime(started ? state.progress * duration : duration) : '--:--';
  ctx.font = `400 ${tm.size}px ${style.font}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = style.ink;
  ctx.fillText(label, tm.x + tm.w, tm.y, tm.w);

  // Speaker: line icon, like the toolbar icons.
  const sp = L.speaker;
  const k = sp.size / 2;
  ctx.strokeStyle = style.ink;
  ctx.lineWidth = Math.max(0.9, k * 0.14);
  ctx.beginPath();
  ctx.moveTo(sp.cx - k, sp.cy - k * 0.32);
  ctx.lineTo(sp.cx - k * 0.5, sp.cy - k * 0.32);
  ctx.lineTo(sp.cx + k * 0.1, sp.cy - k * 0.82);
  ctx.lineTo(sp.cx + k * 0.1, sp.cy + k * 0.82);
  ctx.lineTo(sp.cx - k * 0.5, sp.cy + k * 0.32);
  ctx.lineTo(sp.cx - k, sp.cy + k * 0.32);
  ctx.closePath();
  ctx.stroke();
  const waves = volume <= 0 ? 0 : volume < 0.5 ? 1 : 2;
  for (let i = 1; i <= waves; i++) {
    ctx.beginPath();
    ctx.arc(sp.cx + k * 0.15, sp.cy, k * 0.38 * i + k * 0.12, -Math.PI / 4, Math.PI / 4);
    ctx.stroke();
  }
  if (volume <= 0) {
    ctx.beginPath();
    ctx.moveTo(sp.cx + k * 0.45, sp.cy - k * 0.32);
    ctx.lineTo(sp.cx + k * 1.05, sp.cy + k * 0.32);
    ctx.moveTo(sp.cx + k * 1.05, sp.cy - k * 0.32);
    ctx.lineTo(sp.cx + k * 0.45, sp.cy + k * 0.32);
    ctx.stroke();
  }

  // Volume: hairline track, filled part and a small knob.
  const vo = L.volume;
  const trackH = Math.max(1, vo.knob * 0.32);
  ctx.fillStyle = style.track;
  ctx.beginPath();
  roundRect(ctx, vo.x, vo.y - trackH / 2, vo.w, trackH, trackH / 2);
  ctx.fill();
  ctx.fillStyle = style.primary;
  ctx.beginPath();
  roundRect(ctx, vo.x, vo.y - trackH / 2, Math.max(trackH, vo.w * volume), trackH, trackH / 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(vo.x + vo.w * volume, vo.y, vo.knob, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

/** Linear sample of `values` at position t in 0..1. */
function sample(values: readonly number[], t: number): number {
  const f = t * (values.length - 1);
  const i = Math.floor(f);
  const a = values[i] ?? 0;
  const b = values[Math.min(values.length - 1, i + 1)] ?? a;
  return a + (b - a) * (f - i);
}

function roundRect(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  // A player squeezed narrower than its border gives negative sizes; a negative radius
  // makes `arcTo` throw (IndexSizeError).
  w = Math.max(0, w);
  h = Math.max(0, h);
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
