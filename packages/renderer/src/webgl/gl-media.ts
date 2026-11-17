import type { MediaQuad, MediaSource, MediaTextures, TextureHandle } from '../backend';
import { compileProgram, uniforms } from './gl-utils';
import { MEDIA_FRAGMENT, MEDIA_VERTEX } from './shaders';

type Uniforms = Record<
  | 'u_camera'
  | 'u_viewport'
  | 'u_rect'
  | 'u_rotation'
  | 'u_depth'
  | 'u_radius'
  | 'u_mode'
  | 'u_uv'
  | 'u_tex',
  WebGLUniformLocation | null
>;

interface Resources {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  quad: WebGLBuffer;
  u: Uniforms;
}

/** WebGL side of images and audio players: their textures and one draw call per quad. */
export class GlMedia implements MediaTextures {
  private res: Resources | null = null;

  constructor(private readonly gl: WebGL2RenderingContext) {}

  get maxTextureSize(): number {
    return this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number;
  }

  init(): void {
    const gl = this.gl;
    const program = compileProgram(gl, MEDIA_VERTEX, MEDIA_FRAGMENT);
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.res = {
      program,
      vao,
      quad,
      u: uniforms(gl, program, [
        'u_camera',
        'u_viewport',
        'u_rect',
        'u_rotation',
        'u_depth',
        'u_radius',
        'u_mode',
        'u_uv',
        'u_tex',
      ] as const),
    };
  }

  lose(): void {
    this.res = null;
  }

  dispose(): void {
    const res = this.res;
    if (!res) return;
    const gl = this.gl;
    gl.deleteProgram(res.program);
    gl.deleteVertexArray(res.vao);
    gl.deleteBuffer(res.quad);
    this.res = null;
  }

  draw(quads: MediaQuad[], x: number, y: number, zoom: number, vw: number, vh: number): void {
    const res = this.res;
    if (!res || quads.length === 0) return;
    const gl = this.gl;
    const u = res.u;
    gl.useProgram(res.program);
    gl.bindVertexArray(res.vao);
    gl.uniform3f(u.u_camera, x, y, zoom);
    gl.uniform2f(u.u_viewport, vw, vh);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(u.u_tex, 0);
    for (const q of quads) {
      gl.uniform4f(u.u_rect, ...q.rect);
      gl.uniform4f(u.u_uv, ...q.uv);
      gl.uniform1f(u.u_rotation, q.rotation);
      gl.uniform1f(u.u_depth, q.depth);
      gl.uniform1f(u.u_radius, q.radius);
      if (q.texture) gl.bindTexture(gl.TEXTURE_2D, q.texture as WebGLTexture);
      gl.uniform1f(u.u_mode, q.texture ? 0 : 1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  upload(source: MediaSource, mipmaps: boolean, previous?: TextureHandle): TextureHandle {
    const gl = this.gl;
    let texture = previous as WebGLTexture | undefined;
    if (!texture) {
      texture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MIN_FILTER,
        mipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR,
      );
    } else {
      gl.bindTexture(gl.TEXTURE_2D, texture);
    }
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (mipmaps) gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return texture;
  }

  release(texture: TextureHandle): void {
    this.gl.deleteTexture(texture as WebGLTexture);
  }
}
