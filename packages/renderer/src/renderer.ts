import { CanvasSize, MAX_PIXEL_RATIO } from './canvas-size';
import {
  FONT_FAMILIES,
  GRID_MIN_PX,
  gridStep,
  boxIntersects,
  isConnector,
  isMedia,
  type BoardElement,
  type Camera,
  type FontMeasurer,
  type Scene,
  type SceneChanges,
  type ShapeElement,
  type TextLayout,
} from '@apeiro/core';
import type { BackendFactory, BackendKind, GridLevel, RenderBackend } from './backend';
import {
  CanvasFontMeasurer,
  createColorRasterizer,
  createSdfRasterizer,
  cssFont,
  DEFAULT_FONT_FAMILY,
  SDF_CUTOFF,
} from './text/font';
import { createWebGlBackend } from './webgl/gl-backend';
import { unpackColor } from './webgl/gl-utils';
import { GlyphAtlas } from './text/glyph-atlas';
import { requestWebGpuBackend } from './webgpu/gpu-backend';
import { InstanceStore } from './layers/instance-store';
import type { AudioVisualState, AudioWidgetStyle } from './media/audio-widget';
import { shapeDepth } from './depth';
import { ColorTheme } from './color-theme';
import { LineLayer } from './layers/line-layer';
import { MediaPass, type MediaDrawItem, type MediaPassOptions } from './media/media-pass';
import { TextLayer, type TextLayerOptions } from './layers/text-layer';

/** Text whose glyphs make the browser load both the Latin and the Cyrillic subset of a face. */
const FACE_SAMPLE = 'AaЯя';

export type GridStyle = 'dots' | 'lines';

/** Elements drawn by the line pass: connectors and pen strokes. */
const drawnAsLine = (el: BoardElement) => isConnector(el) || el.type === 'ink';

export interface RendererOptions {
  canvas: HTMLCanvasElement;
  scene: Scene;
  camera: Camera;
  /** Packed 0xRRGGBBAA. */
  background?: number;
  /** Packed 0xRRGGBBAA, alpha controls the grid's opacity. 0 disables the grid. */
  gridColor?: number;
  /** Dots at the grid's crossings (default) or thin lines, like Miro's. */
  gridStyle?: GridStyle;
  /** Cap for devicePixelRatio (default 3: the screen's own on every common device). */
  maxPixelRatio?: number;
  /** Fixed pixels per CSS pixel instead of the screen's (e.g. 1 when rendering an image). */
  pixelRatio?: number;
  /**
   * See-through canvas: `background`'s alpha is kept (0: nothing but the elements), so the
   * page or another canvas shows under it.
   */
  transparent?: boolean;
  /**
   * Keep the frame after compositing (needed for screenshots/readback outside the render
   * call). Only WebGL has this, so `createRenderer` picks WebGL for it unless told otherwise.
   */
  preserveDrawingBuffer?: boolean;
  /** CSS font-family for board text. Must match the DOM text editor. */
  fontFamily?: string;
  text?: TextLayerOptions;
  /** Which media URLs may be loaded (by default: blob:, data:, the page's own origin). */
  media?: MediaPassOptions;
}

export interface CreateRendererOptions extends RendererOptions {
  /** `auto` (default): WebGPU when the browser has it, otherwise WebGL2. */
  backend?: 'auto' | BackendKind;
}

export interface RenderStats {
  instances: number;
  holes: number;
  /** CPU time of the last frame (GPU work is asynchronous and not included). */
  cpuMs: number;
  uploadedBytes: number;
  frames: number;
  glyphs: number;
  /** Connector segment + cap instances. */
  lineInstances: number;
  /** Time of the last text rebuild (only happens when the view leaves the built region or content changes). */
  textBuildMs: number;
  atlasSize: number;
}

/**
 * Creates a renderer on the best GPU API available: WebGPU if the browser offers a working
 * device, WebGL2 otherwise. Asynchronous because a WebGPU device is.
 */
export async function createRenderer(options: CreateRendererOptions): Promise<BoardRenderer> {
  const want = options.backend ?? 'auto';
  const tryGpu = want === 'webgpu' || (want === 'auto' && !options.preserveDrawingBuffer);
  if (tryGpu) {
    const gpu = await requestWebGpuBackend(options.canvas);
    if (gpu) return new BoardRenderer(options, gpu);
    if (want === 'webgpu') console.warn('apeiro: WebGPU is not available, using WebGL');
  }
  return new BoardRenderer(options, createWebGlBackend);
}

/**
 * Draws a Scene through a Camera. Renders on demand: a frame is scheduled only
 * when the scene or camera changes, so an idle board costs nothing.
 *
 * Everything that decides what to draw lives here and is the same for every GPU API;
 * the backend (WebGPU or WebGL2) uploads the CPU layers and issues the draw calls.
 */
export class BoardRenderer {
  readonly stats: RenderStats = {
    instances: 0,
    holes: 0,
    cpuMs: 0,
    uploadedBytes: 0,
    frames: 0,
    glyphs: 0,
    lineInstances: 0,
    textBuildMs: 0,
    atlasSize: 0,
  };
  /** Shared with UI code (e.g. a text editor overlay) so wrapping matches exactly. */
  readonly measurer: CanvasFontMeasurer;

  private readonly canvas: HTMLCanvasElement;
  private readonly scene: Scene;
  private readonly camera: Camera;
  private readonly gpu: RenderBackend;
  private readonly store = new InstanceStore();
  private background: [number, number, number, number];
  private gridColor: [number, number, number, number];
  private gridStyle: GridStyle;
  private readonly maxPixelRatio: number;
  private readonly fontFamily: string;
  private dpr = 1;
  private readonly size: CanvasSize;
  private readonly fixedPixelRatio: number | null;
  private frame = 0;
  private needsRebuild = true;
  private disposers: Array<() => void> = [];
  private afterRender = new Set<() => void>();
  private readonly sdfAtlas = new GlyphAtlas({ channels: 1, maxSize: 4096 });
  private readonly colorAtlas = new GlyphAtlas({ channels: 4, initialSize: 512, maxSize: 2048 });
  private readonly textLayer: TextLayer;
  private readonly lineLayer = new LineLayer();
  private colorTheme = new ColorTheme();
  private readonly mediaPass: MediaPass;
  /** Image and audio elements (few, tracked directly instead of querying the viewport) → their src. */
  private mediaSrc = new Map<string, string>();
  /** How many elements use each src: a texture is freed when the last one goes away. */
  private srcRefs = new Map<string, number>();
  /** Connectors added/changed since the last frame. */
  private pendingLines = new Set<string>();
  /** Which board font faces were loaded when glyphs were last reset. */
  private fontSignature = '';
  /** A font finished loading since the last frame: maybe one of the board's faces. */
  private fontsChanged = false;
  private textErrorLogged = false;

  /** Without a backend factory it draws with WebGL2; `createRenderer` picks one for you. */
  constructor(options: RendererOptions, backend: BackendFactory = createWebGlBackend) {
    this.canvas = options.canvas;
    this.scene = options.scene;
    this.camera = options.camera;
    this.background = unpackColor(options.background ?? 0xf5f5f7ff);
    this.gridColor = unpackColor(options.gridColor ?? 0x9ca3af80);
    this.gridStyle = options.gridStyle ?? 'dots';
    this.maxPixelRatio = options.maxPixelRatio ?? MAX_PIXEL_RATIO;
    this.fixedPixelRatio = options.pixelRatio ?? null;
    const family = options.fontFamily ?? DEFAULT_FONT_FAMILY;
    this.fontFamily = family;
    this.measurer = new CanvasFontMeasurer(family);
    this.textLayer = new TextLayer(
      this.sdfAtlas,
      this.colorAtlas,
      this.measurer,
      { sdf: createSdfRasterizer(family), color: createColorRasterizer(family) },
      options.text,
    );

    this.gpu = backend({
      canvas: this.canvas,
      store: this.store,
      lineLayer: this.lineLayer,
      textLayer: this.textLayer,
      sdfAtlas: this.sdfAtlas,
      colorAtlas: this.colorAtlas,
      sdfEdge: 1 - SDF_CUTOFF,
      preserveDrawingBuffer: options.preserveDrawingBuffer ?? false,
      transparent: options.transparent ?? false,
      onLost: () => {
        this.mediaPass.lose();
        cancelAnimationFrame(this.frame);
        this.frame = 0;
      },
      onRestored: () => {
        this.mediaPass.init();
        this.requestRender();
      },
    });
    this.mediaPass = new MediaPass(this.gpu.textures, () => this.requestRender(), options.media);
    this.mediaPass.colorOf = (type, color) => this.colorTheme.of(type, color);
    if (this.gpu.ready) this.mediaPass.init();

    this.disposers.push(
      this.scene.subscribe((c) => this.onSceneChanges(c)),
      this.camera.subscribe(() => this.requestRender()),
    );
    // Web fonts load asynchronously: glyphs and metrics cached before that belong to the
    // fallback. Each face loads separately and other fonts on the page fire the same
    // event, so glyphs are only dropped when one of the board's faces became available.
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    if (fonts) {
      this.fontSignature = this.loadedFaces();
      // Faces finish one by one (and the event fires for every font on the page): the
      // check and the reset happen once, in the next frame, however many arrived meanwhile.
      const onFonts = () => {
        this.fontsChanged = true;
        this.requestRender();
      };
      fonts.addEventListener('loadingdone', onFonts);
      // Canvas measuring doesn't make the browser fetch a web font: ask for every face.
      for (const face of this.faces()) fonts.load(face, FACE_SAMPLE).then(onFonts, () => undefined);
      this.disposers.push(() => fonts.removeEventListener('loadingdone', onFonts));
    }
    this.size = new CanvasSize(this.canvas, () => this.resize());
    this.disposers.push(() => this.size.dispose());
    this.resize();
  }

  /** The GPU API this renderer draws with. */
  get backend(): BackendKind {
    return this.gpu.kind;
  }

  /** Drops cached glyphs and text layouts, e.g. after a font finished loading. */
  refreshFonts(): void {
    this.fontSignature = this.loadedFaces();
    this.measurer.clear();
    this.sdfAtlas.reset();
    this.colorAtlas.reset();
    this.textLayer.resetLayouts();
    this.requestRender();
  }

  /** Layout the renderer uses for an element's text (cached). For editors and hit testing text. */
  textLayout(el: ShapeElement): TextLayout | undefined {
    return this.textLayer.layoutOf(el);
  }

  /** Hides an element's text, e.g. while a DOM editor shows it instead. */
  setTextHidden(id: string, hidden: boolean): void {
    this.textLayer.setHidden(id, hidden);
    this.requestRender();
  }

  get fontMeasurer(): FontMeasurer {
    return this.measurer;
  }

  /**
   * Syncs the drawing buffer with the canvas's size on screen, pixel for pixel (see
   * `CanvasSize`). The renderer watches its canvas itself; call it after a layout change
   * it can't see (e.g. a canvas that was hidden).
   */
  resize(): void {
    const m = this.size.measure(this.maxPixelRatio, this.fixedPixelRatio);
    this.size.apply(m);
    this.dpr = m.ratio;
    this.camera.setViewport(m.cssWidth, m.cssHeight);
    this.requestRender();
  }

  /**
   * Colors to draw in place of stored ones, e.g. for a dark theme: [stored, drawn] pairs
   * of 0xRRGGBB. Elements of the `keep` types are drawn as stored. Redraws everything.
   */
  setColorTheme(
    pairs: ReadonlyArray<readonly [number, number]>,
    keep: Iterable<string> = [],
  ): void {
    const theme = new ColorTheme();
    theme.set(pairs, keep);
    this.colorTheme = theme;
    this.store.theme = theme;
    this.lineLayer.theme = theme;
    this.textLayer.theme = theme;
    this.needsRebuild = true; // rewrites every shape and line with the new colors
    this.textLayer.markDirty();
    this.requestRender();
  }

  /** The color drawn for an element's stored color (DOM editors show text the same way). */
  drawnColor(type: string, color: number): number {
    return this.colorTheme.of(type, color);
  }

  /** Changes the board's background and grid (e.g. when the UI switches to a dark theme). */
  setBackdrop(backdrop: { background?: number; gridColor?: number; gridStyle?: GridStyle }): void {
    if (backdrop.background !== undefined) this.background = unpackColor(backdrop.background);
    if (backdrop.gridColor !== undefined) this.gridColor = unpackColor(backdrop.gridColor);
    if (backdrop.gridStyle !== undefined) this.gridStyle = backdrop.gridStyle;
    this.requestRender();
  }

  requestRender(): void {
    if (this.frame || !this.gpu.ready) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  /** Called after each frame; overlays (selection, cursors) can sync to it. */
  onAfterRender(cb: () => void): () => void {
    this.afterRender.add(cb);
    return () => this.afterRender.delete(cb);
  }

  /** Renders synchronously. Normally you want `requestRender`. */
  render(): void {
    if (!this.gpu.ready) return;
    const t0 = performance.now();

    if (this.fontsChanged) {
      this.fontsChanged = false;
      // Glyphs and metrics cached so far belong to the fallback font.
      if (this.loadedFaces() !== this.fontSignature) this.refreshFonts();
    }
    if (this.needsRebuild) {
      this.store.rebuild(this.scene.sortedByZ());
      this.needsRebuild = false;
      this.textLayer.markDirty(); // slots (and therefore text depths) changed
      this.lineLayer.rebuild(this.scene, (id) => this.store.slot(id));
      this.pendingLines.clear();
    }
    this.updateLines();
    const { x, y, zoom } = this.camera.getState();
    // Text comes from element data (other participants, eventually): whatever it contains,
    // a failure there must not stop shapes, lines and media from being drawn.
    let textOk = true;
    try {
      this.textLayer.update(this.scene, this.camera.viewportBounds(), zoom, this.dpr, (id) =>
        this.store.slot(id),
      );
    } catch (e) {
      textOk = false;
      if (!this.textErrorLogged) {
        this.textErrorLogged = true;
        console.error('apeiro: text layout failed, text is not drawn this frame', e);
      }
    }

    this.gpu.render({
      x,
      y,
      zoom,
      viewportW: this.camera.viewportWidth,
      viewportH: this.camera.viewportHeight,
      dpr: this.dpr,
      background: this.background,
      grid: this.gridColor[3] > 0 ? this.grid(zoom) : null,
      media: this.mediaPass.prepare(this.visibleMedia(), x, y, zoom, this.dpr),
      drawText: textOk,
    });

    this.stats.glyphs = this.textLayer.count;
    this.stats.lineInstances = this.lineLayer.count;
    this.stats.uploadedBytes += this.gpu.takeUploadedBytes();
    this.stats.textBuildMs = this.textLayer.lastBuildMs;
    this.stats.atlasSize = this.sdfAtlas.size;
    this.stats.instances = this.store.count - this.store.holeCount;
    this.stats.holes = this.store.holeCount;
    this.stats.cpuMs = performance.now() - t0;
    this.stats.frames++;
    // One failing overlay must not keep the others (or the next frames) from running.
    for (const cb of this.afterRender) {
      try {
        cb();
      } catch (e) {
        console.error('apeiro: an after-render callback failed', e);
      }
    }
    // Glyphs/layouts that didn't fit this frame's budget arrive in the next ones.
    if (textOk && this.textLayer.needsMoreFrames) this.requestRender();
  }

  /** Playback state of an audio element (owned by the app's audio player); redraws it. */
  setAudioState(id: string, state: AudioVisualState): void {
    this.mediaPass.setAudioState(id, state);
    this.requestRender();
  }

  /** Colours of the audio players, e.g. the app's theme tokens; unset fields keep theirs. */
  setAudioStyle(style: Partial<AudioWidgetStyle>): void {
    this.mediaPass.setAudioStyle(style);
    this.requestRender();
  }

  /** True while images are still loading. */
  get mediaPending(): boolean {
    return this.mediaPass.pending;
  }

  /** True while text is still being rasterized/laid out over several frames. */
  get textPending(): boolean {
    return this.textLayer.needsMoreFrames;
  }

  destroy(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    for (const d of this.disposers) d();
    this.disposers = [];
    this.afterRender.clear();
    this.mediaPass.dispose();
    this.gpu.destroy();
  }

  /** The grid's levels this frame; null when the zoom makes no sense. */
  private grid(zoom: number) {
    if (!(zoom > 0) || !Number.isFinite(zoom)) return null;
    const spacing = gridStep(zoom); // the same steps moves snap to
    // Fine level fades in as it grows; the coarse level (4x) is always visible,
    // so switching levels never pops.
    const fade = Math.min(1, Math.max(0, (spacing * zoom - GRID_MIN_PX) / GRID_MIN_PX));
    const lines = this.gridStyle === 'lines';
    // Coarse lines are a subset of the fine ones: once the fine level is fully in, drawing
    // both would make every 4th line darker. Dots stay layered (the coarse ones read as a frame).
    const levels: GridLevel[] = [
      { spacing: spacing * 4, fade: lines ? 1 - fade : 1 },
      { spacing, fade },
    ].filter((l) => l.fade > 0);
    return { color: this.gridColor, lines, levels };
  }

  private visibleMedia(): MediaDrawItem[] {
    const view = this.camera.viewportBounds();
    const items: MediaDrawItem[] = [];
    for (const id of this.mediaSrc.keys()) {
      const el = this.scene.get(id);
      const b = this.scene.getBounds(id);
      const slot = this.store.slot(id);
      if (!el || !b || slot === undefined || !boxIntersects(b, view) || el.type === 'connector')
        continue;
      if (Math.max(el.w, el.h) * this.camera.zoom < 1) continue; // sub-pixel
      items.push({ el, depth: shapeDepth(slot) });
    }
    // Paint order: overlapping images with transparent pixels blend bottom to top, as
    // `bringToFront`/`sendToBack` say, not in the order they were added. Depth decreases upwards.
    return items.sort((a, b) => b.depth - a.depth);
  }

  /** Every face text can use: each family of `FONT_FAMILIES` in regular/bold/italic. */
  private faces(): string[] {
    const out: string[] = [];
    for (let v = 0; v < FONT_FAMILIES.length * 4; v++) out.push(cssFont(v, 16, this.fontFamily));
    return out;
  }

  /** Load state of the board's font faces (Latin and Cyrillic subsets). */
  private loadedFaces(): string {
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    if (!fonts) return '';
    return this.faces()
      .map((f) => (fonts.check(f, FACE_SAMPLE) ? '1' : '0'))
      .join('');
  }

  private onSceneChanges(c: SceneChanges): void {
    this.textLayer.applyChanges(c);
    for (const id of c.removed) {
      this.lineLayer.remove(id);
      this.pendingLines.delete(id);
      this.trackMedia(id, undefined);
    }
    for (const el of c.added) if (drawnAsLine(el)) this.pendingLines.add(el.id);
    for (const el of [...c.added, ...c.updated])
      this.trackMedia(el.id, isMedia(el) ? el.media.src : undefined);
    for (const el of c.updated) if (drawnAsLine(el)) this.pendingLines.add(el.id);
    if (!this.needsRebuild) {
      if (c.orderChanged) this.needsRebuild = true;
      else {
        for (const id of c.removed) this.store.remove(id);
        for (const el of c.updated) if (!this.store.update(el)) this.needsRebuild = true;
        if (!this.store.tryAppend(c.added)) this.needsRebuild = true;
        if (this.store.needsCompaction()) this.needsRebuild = true;
      }
    }
    this.requestRender();
  }

  /** Keeps `mediaSrc`/`srcRefs` in sync and frees GPU resources nobody uses any more. */
  private trackMedia(id: string, src: string | undefined): void {
    const old = this.mediaSrc.get(id);
    if (old === src) return;
    if (old !== undefined) {
      const n = (this.srcRefs.get(old) ?? 1) - 1;
      if (n > 0) this.srcRefs.set(old, n);
      else {
        this.srcRefs.delete(old);
        this.mediaPass.releaseImage(old);
      }
      this.mediaPass.releaseAudio(id);
    }
    if (src === undefined) {
      this.mediaSrc.delete(id);
      return;
    }
    this.mediaSrc.set(id, src);
    this.srcRefs.set(src, (this.srcRefs.get(src) ?? 0) + 1);
  }

  /** Rewrites connectors changed since the last frame (after slots are up to date). */
  private updateLines(): void {
    if (this.lineLayer.needsCompaction()) {
      this.lineLayer.rebuild(this.scene, (id) => this.store.slot(id));
      this.pendingLines.clear();
      return;
    }
    for (const id of this.pendingLines) {
      const el = this.scene.get(id);
      if (el && isConnector(el)) {
        this.lineLayer.set(el, this.scene.connectorGeometry(id), this.store.slot(id));
      } else if (el && el.type === 'ink') {
        this.lineLayer.setInk(el, this.store.slot(id));
      }
    }
    this.pendingLines.clear();
  }
}
