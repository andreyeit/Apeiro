import { isAllowedMediaSrc, isMedia, type Scene } from '@apeiro/core';

export interface AudioStateSink {
  setAudioState(id: string, state: { playing: boolean; progress: number }): void;
}

/** The parts of HTMLAudioElement the controller uses (lets tests pass a fake). */
export interface AudioPlayer {
  src: string;
  volume: number;
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: 'ended', cb: () => void): void;
}

/**
 * Plays audio elements. Playback is local to this viewer (not synced); the volume
 * lives on the element, so changing it is a normal scene update. Only one element
 * plays at a time. Pushes play state/progress to the renderer every frame while playing.
 */
export class AudioController {
  private players = new Map<string, AudioPlayer>();
  /** The src each player was created for. */
  private srcs = new Map<string, string>();
  private frame = 0;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly scene: Scene,
    private readonly sink: AudioStateSink,
    private readonly create: (src: string) => AudioPlayer = (src) => new Audio(src),
    /** Origins audio may be loaded from besides blob:, data: and the page's own. */
    private readonly allowedOrigins: readonly string[] = [],
  ) {
    this.unsubscribe = scene.subscribe((c) => {
      for (const el of c.updated) {
        const p = this.players.get(el.id);
        if (!p) continue;
        // A different file (or no longer audio): the old player must not keep playing it.
        if (!isMedia(el) || el.type !== 'audio' || el.media.src !== this.srcs.get(el.id)) {
          this.stop(el.id);
          this.sink.setAudioState(el.id, { playing: false, progress: 0 });
          continue;
        }
        p.volume = el.volume ?? 1;
      }
      for (const id of c.removed) this.stop(id);
    });
  }

  isPlaying(id: string): boolean {
    const p = this.players.get(id);
    return !!p && !p.paused;
  }

  toggle(id: string): void {
    if (this.isPlaying(id)) {
      this.players.get(id)!.pause();
      this.push(id);
      return;
    }
    for (const [other, p] of this.players) {
      if (other !== id && !p.paused) {
        p.pause();
        this.push(other);
      }
    }
    const p = this.player(id);
    if (!p) return;
    void p.play().catch(() => this.push(id));
    this.push(id);
    this.loop();
  }

  /** Jumps to a position (0..1); works while paused too. */
  seek(id: string, fraction: number): void {
    const p = this.player(id);
    if (!p) return;
    const duration = this.duration(id, p);
    if (duration > 0) p.currentTime = fraction * duration;
    this.push(id, fraction);
  }

  /** Stops every player and the scene subscription. */
  dispose(): void {
    this.unsubscribe();
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    for (const id of [...this.players.keys()]) this.stop(id);
  }

  stop(id: string): void {
    const p = this.players.get(id);
    if (!p) return;
    p.pause();
    this.players.delete(id);
    this.srcs.delete(id);
  }

  private player(id: string): AudioPlayer | null {
    let p = this.players.get(id);
    if (p) return p;
    const el = this.scene.get(id);
    if (!el || !isMedia(el) || el.type !== 'audio') return null;
    // The src comes from element data: don't let it point the player at arbitrary hosts.
    if (!isAllowedMediaSrc(el.media.src, this.allowedOrigins)) return null;
    p = this.create(el.media.src);
    p.volume = el.volume ?? 1;
    p.addEventListener('ended', () => {
      p!.currentTime = 0;
      this.push(id, 0);
    });
    this.players.set(id, p);
    this.srcs.set(id, el.media.src);
    return p;
  }

  private duration(id: string, p: AudioPlayer): number {
    if (Number.isFinite(p.duration) && p.duration > 0) return p.duration;
    const el = this.scene.get(id);
    return el && isMedia(el) ? (el.media.duration ?? 0) : 0;
  }

  private push(id: string, progress?: number): void {
    const p = this.players.get(id);
    if (!p) return;
    const d = this.duration(id, p);
    this.sink.setAudioState(id, {
      playing: !p.paused,
      progress: progress ?? (d > 0 ? Math.min(1, p.currentTime / d) : 0),
    });
  }

  private loop(): void {
    if (this.frame) return;
    const tick = () => {
      this.frame = 0;
      let any = false;
      for (const [id, p] of this.players) {
        if (p.paused) continue;
        any = true;
        this.push(id);
      }
      if (any) this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }
}
