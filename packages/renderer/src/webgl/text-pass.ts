import { uploadInstances } from '../layers/buffer-upload';
import { compileProgram, uniforms } from './gl-utils';
import type { GlyphAtlas } from '../text/glyph-atlas';
import { TEXT_FRAGMENT, TEXT_VERTEX } from './shaders';
import { GLYPH_STRIDE, type TextLayer } from '../layers/text-layer';

interface AtlasTexture {
  texture: WebGLTexture;
  size: number;
}

interface Resources {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  quad: WebGLBuffer;
  instances: WebGLBuffer;
  instanceBytes: number;
  sdf: AtlasTexture;
  color: AtlasTexture;
  u: Record<
    'u_camera' | 'u_viewport' | 'u_sdf' | 'u_colorAtlas' | 'u_edge',
    WebGLUniformLocation | null
  >;
}

/** GL side of text: owns the atlas textures and the quad instance buffer. */
export class TextPass {
  private res: Resources | null = null;
  uploadedBytes = 0;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly sdfAtlas: GlyphAtlas,
    private readonly colorAtlas: GlyphAtlas,
    private readonly layer: TextLayer,
    /** SDF value at the outline: 1 - cutoff of the rasterizer. */
    private readonly edge: number,
  ) {}

  /** (Re)creates GL objects; safe to call after a context restore. */
  init(): void {
    const gl = this.gl;
    const program = compileProgram(gl, TEXT_VERTEX, TEXT_FRAGMENT);
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);

    const quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const instances = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, instances);
    const attr = (loc: number, size: number, type: number, normalized: boolean, offset: number) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, type, normalized, GLYPH_STRIDE, offset);
      gl.vertexAttribDivisor(loc, 1);
    };
    attr(1, 4, gl.FLOAT, false, 0);
    attr(2, 4, gl.FLOAT, false, 16);
    attr(3, 4, gl.FLOAT, false, 32);
    attr(4, 1, gl.FLOAT, false, 48);
    attr(5, 4, gl.UNSIGNED_BYTE, true, 52);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    this.res = {
      program,
      vao,
      quad,
      instances,
      instanceBytes: 0,
      sdf: { texture: this.createTexture(), size: 0 },
      color: { texture: this.createTexture(), size: 0 },
      u: uniforms(gl, program, [
        'u_camera',
        'u_viewport',
        'u_sdf',
        'u_colorAtlas',
        'u_edge',
      ] as const),
    };
    // Everything must go to the new GL objects.
    this.sdfAtlas.markFullUpload();
    this.colorAtlas.markFullUpload();
    this.layer.markUploadAll();
  }

  /** Forget GL objects without deleting them (they died with a lost context). */
  lose(): void {
    this.res = null;
  }

  draw(x: number, y: number, zoom: number, viewportW: number, viewportH: number): void {
    const res = this.res;
    if (!res) return;
    const gl = this.gl;
    this.uploadAtlas(this.sdfAtlas, res.sdf);
    this.uploadAtlas(this.colorAtlas, res.color);
    this.uploadInstances(res);
    if (this.layer.count === 0) return;

    gl.useProgram(res.program);
    gl.uniform3f(res.u.u_camera, x, y, zoom);
    gl.uniform2f(res.u.u_viewport, viewportW, viewportH);
    gl.uniform1f(res.u.u_edge, this.edge);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, res.sdf.texture);
    gl.uniform1i(res.u.u_sdf, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, res.color.texture);
    gl.uniform1i(res.u.u_colorAtlas, 1);
    gl.bindVertexArray(res.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.layer.count);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
  }

  dispose(): void {
    const res = this.res;
    if (!res) return;
    const gl = this.gl;
    gl.deleteProgram(res.program);
    gl.deleteVertexArray(res.vao);
    gl.deleteBuffer(res.quad);
    gl.deleteBuffer(res.instances);
    gl.deleteTexture(res.sdf.texture);
    gl.deleteTexture(res.color.texture);
    this.res = null;
  }

  private createTexture(): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // 1x1 placeholder so sampling an unused atlas is valid.
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array(4),
    );
    gl.bindTexture(gl.TEXTURE_2D, null);
    return texture;
  }

  private uploadAtlas(atlas: GlyphAtlas, tex: AtlasTexture): void {
    const gl = this.gl;
    const uploads = atlas.takeUploads();
    const full = uploads.full || tex.size !== atlas.size;
    if (!full && uploads.rects.length === 0) return;
    const rgba = atlas.channels === 4;
    const internal = rgba ? gl.RGBA8 : gl.R8;
    const format = rgba ? gl.RGBA : gl.RED;
    gl.bindTexture(gl.TEXTURE_2D, tex.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (full) {
      const size = atlas.size;
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        internal,
        size,
        size,
        0,
        format,
        gl.UNSIGNED_BYTE,
        atlas.data,
      );
      tex.size = size;
      this.uploadedBytes += atlas.data.byteLength;
    } else {
      for (const r of uploads.rects) {
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          r.x,
          r.y,
          r.width,
          r.height,
          format,
          gl.UNSIGNED_BYTE,
          r.data,
        );
        this.uploadedBytes += r.data.byteLength;
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  private uploadInstances(res: Resources): void {
    this.uploadedBytes += uploadInstances(
      this.gl,
      res,
      this.layer.data,
      this.layer.count,
      GLYPH_STRIDE,
      this.layer.takeUpload(),
    );
  }
}
