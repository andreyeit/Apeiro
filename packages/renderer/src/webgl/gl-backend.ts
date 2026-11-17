import type { BackendContext, FrameParams, RenderBackend } from '../backend';
import { byteRuns } from '../layers/buffer-upload';
import { GlMedia } from './gl-media';
import { compileProgram, uniforms } from './gl-utils';
import { INSTANCE_STRIDE } from '../layers/instance-store';
import { LinePass } from './line-pass';
import { GRID_FRAGMENT, GRID_VERTEX, SHAPE_FRAGMENT, SHAPE_VERTEX } from './shaders';
import { TextPass } from './text-pass';

interface Resources {
  shapeProgram: WebGLProgram;
  shapeVao: WebGLVertexArrayObject;
  quadBuffer: WebGLBuffer;
  instanceBuffer: WebGLBuffer;
  instanceCapacity: number;
  shapeU: Record<'u_camera' | 'u_viewport' | 'u_depthOnly', WebGLUniformLocation | null>;
  gridProgram: WebGLProgram;
  gridVao: WebGLVertexArrayObject;
  gridU: Record<
    'u_camera' | 'u_dpr' | 'u_heightPx' | 'u_spacing' | 'u_fade' | 'u_dotColor' | 'u_lines',
    WebGLUniformLocation | null
  >;
}

/** The WebGL2 backend. Throws when WebGL2 is not available. */
export function createWebGlBackend(ctx: BackendContext): RenderBackend {
  return new WebGlBackend(ctx);
}

class WebGlBackend implements RenderBackend {
  readonly kind = 'webgl';
  private readonly gl: WebGL2RenderingContext;
  private res: Resources | null = null;
  private readonly textPass: TextPass;
  private readonly linePass: LinePass;
  private readonly media: GlMedia;
  private uploadedBytes = 0;
  private disposers: Array<() => void> = [];

  constructor(private readonly ctx: BackendContext) {
    const gl = ctx.canvas.getContext('webgl2', {
      antialias: false, // shapes are antialiased analytically in the shader
      alpha: ctx.transparent,
      depth: true, // keeps text behind shapes that are above its element
      premultipliedAlpha: true,
      preserveDrawingBuffer: ctx.preserveDrawingBuffer,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not supported');
    this.gl = gl;
    this.textPass = new TextPass(gl, ctx.sdfAtlas, ctx.colorAtlas, ctx.textLayer, ctx.sdfEdge);
    this.linePass = new LinePass(gl, ctx.lineLayer);
    this.media = new GlMedia(gl);
    this.init();

    const lost = (e: Event) => {
      e.preventDefault(); // allows the browser to restore the context
      this.res = null;
      this.textPass.lose();
      this.linePass.lose();
      this.media.lose();
      ctx.onLost();
    };
    const restored = () => {
      this.init();
      ctx.onRestored();
    };
    ctx.canvas.addEventListener('webglcontextlost', lost);
    ctx.canvas.addEventListener('webglcontextrestored', restored);
    this.disposers.push(
      () => ctx.canvas.removeEventListener('webglcontextlost', lost),
      () => ctx.canvas.removeEventListener('webglcontextrestored', restored),
    );
  }

  get ready(): boolean {
    return this.res !== null;
  }

  get textures(): GlMedia {
    return this.media;
  }

  takeUploadedBytes(): number {
    const n = this.uploadedBytes + this.linePass.uploadedBytes + this.textPass.uploadedBytes;
    this.uploadedBytes = this.linePass.uploadedBytes = this.textPass.uploadedBytes = 0;
    return n;
  }

  render(f: FrameParams): void {
    const res = this.res;
    if (!res) return;
    const gl = this.gl;
    const store = this.ctx.store;
    this.uploadShapes(res);

    gl.viewport(0, 0, this.ctx.canvas.width, this.ctx.canvas.height);
    const [r, g, b, a] = f.background;
    // Premultiplied, like everything drawn over it.
    if (this.ctx.transparent) gl.clearColor(r * a, g * a, b * a, a);
    else gl.clearColor(r, g, b, 1);
    gl.clearDepth(1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.disable(gl.DEPTH_TEST);
    if (f.grid) this.drawGrid(res, f, f.grid);

    // Shapes: painter's order from the buffer, in two passes. Color first, without
    // touching depth; then depth only, for mostly-opaque pixels. A translucent pixel of
    // a higher shape thus never erases the depth of an opaque shape below it, which
    // would let lines/text hidden by that shape show through.
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.ALWAYS);
    if (store.count > 0) {
      gl.useProgram(res.shapeProgram);
      gl.uniform3f(res.shapeU.u_camera, f.x, f.y, f.zoom);
      gl.uniform2f(res.shapeU.u_viewport, f.viewportW, f.viewportH);
      gl.bindVertexArray(res.shapeVao);
      gl.depthMask(false);
      gl.uniform1f(res.shapeU.u_depthOnly, 0);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, store.count);
      gl.depthMask(true);
      gl.colorMask(false, false, false, false);
      gl.uniform1f(res.shapeU.u_depthOnly, 1);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, store.count);
      gl.colorMask(true, true, true, true);
      gl.bindVertexArray(null);
    }

    // Images and audio players: same depth rules as shapes, drawn on top of the shape pass.
    gl.depthFunc(gl.LEQUAL);
    this.media.draw(f.media, f.x, f.y, f.zoom, f.viewportW, f.viewportH);

    // Connectors: hidden under shapes above them, drawn over shapes below. LEQUAL lets
    // segments of the same connector overlap at joints without seams.
    gl.depthFunc(gl.LEQUAL);
    this.linePass.draw(f.x, f.y, f.zoom, f.viewportW, f.viewportH);

    // Text: hidden wherever a shape or connector above its element was drawn.
    if (f.drawText) {
      gl.depthFunc(gl.LESS);
      gl.depthMask(false);
      this.textPass.draw(f.x, f.y, f.zoom, f.viewportW, f.viewportH);
      gl.depthMask(true);
    }
    gl.disable(gl.DEPTH_TEST);
  }

  destroy(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    const res = this.res;
    this.res = null; // not ready: a late requestRender must not draw with deleted objects
    if (res) {
      const gl = this.gl;
      gl.deleteBuffer(res.instanceBuffer);
      gl.deleteBuffer(res.quadBuffer);
      gl.deleteVertexArray(res.shapeVao);
      gl.deleteVertexArray(res.gridVao);
      gl.deleteProgram(res.shapeProgram);
      gl.deleteProgram(res.gridProgram);
    }
    this.textPass.dispose();
    this.linePass.dispose();
    this.media.dispose();
    this.res = null;
  }

  /** (Re)creates every GL object and marks all CPU data for upload. */
  private init(): void {
    this.res = this.createResources();
    this.textPass.init();
    this.linePass.init();
    this.media.init();
    this.ctx.store.markFull();
  }

  private uploadShapes(res: Resources): void {
    const store = this.ctx.store;
    const dirty = store.takeDirty();
    if (dirty.kind === 'none') return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, res.instanceBuffer);
    const data = store.data;

    if (dirty.kind === 'all' || store.capacity !== res.instanceCapacity) {
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      res.instanceCapacity = store.capacity;
      this.uploadedBytes += data.byteLength;
    } else {
      const bytes = new Uint8Array(data);
      for (const [offset, length] of byteRuns(dirty, false, store.count, INSTANCE_STRIDE)) {
        gl.bufferSubData(gl.ARRAY_BUFFER, offset, bytes, offset, length);
        this.uploadedBytes += length;
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  private drawGrid(res: Resources, f: FrameParams, grid: NonNullable<FrameParams['grid']>): void {
    const gl = this.gl;
    gl.useProgram(res.gridProgram);
    gl.bindVertexArray(res.gridVao);
    gl.uniform3f(res.gridU.u_camera, f.x, f.y, f.zoom);
    gl.uniform1f(res.gridU.u_dpr, f.dpr);
    gl.uniform1f(res.gridU.u_heightPx, this.ctx.canvas.height);
    gl.uniform4f(res.gridU.u_dotColor, ...grid.color);
    gl.uniform1f(res.gridU.u_lines, grid.lines ? 1 : 0);
    for (const { spacing, fade } of grid.levels) {
      gl.uniform1f(res.gridU.u_spacing, spacing);
      gl.uniform1f(res.gridU.u_fade, fade);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.bindVertexArray(null);
  }

  private createResources(): Resources {
    const gl = this.gl;
    const shapeProgram = compileProgram(gl, SHAPE_VERTEX, SHAPE_FRAGMENT);
    const gridProgram = compileProgram(gl, GRID_VERTEX, GRID_FRAGMENT);

    const shapeVao = gl.createVertexArray()!;
    gl.bindVertexArray(shapeVao);

    const quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const instanceBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    const attr = (loc: number, size: number, type: number, normalized: boolean, offset: number) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, type, normalized, INSTANCE_STRIDE, offset);
      gl.vertexAttribDivisor(loc, 1);
    };
    attr(1, 4, gl.FLOAT, false, 0);
    attr(2, 4, gl.FLOAT, false, 16);
    attr(3, 4, gl.UNSIGNED_BYTE, true, 32);
    attr(4, 4, gl.UNSIGNED_BYTE, true, 36);
    attr(5, 1, gl.FLOAT, false, 40);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    const gridVao = gl.createVertexArray()!;

    return {
      shapeProgram,
      shapeVao,
      quadBuffer: quad,
      instanceBuffer,
      instanceCapacity: -1, // forces the first upload to allocate
      shapeU: uniforms(gl, shapeProgram, ['u_camera', 'u_viewport', 'u_depthOnly'] as const),
      gridProgram,
      gridVao,
      gridU: uniforms(gl, gridProgram, [
        'u_camera',
        'u_dpr',
        'u_heightPx',
        'u_spacing',
        'u_fade',
        'u_dotColor',
        'u_lines',
      ] as const),
    };
  }
}
