import { uploadInstances } from '../layers/buffer-upload';
import { compileProgram, uniforms } from './gl-utils';
import { LINE_STRIDE, type LineLayer } from '../layers/line-layer';
import { LINE_FRAGMENT, LINE_VERTEX } from './shaders';

interface Resources {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  quad: WebGLBuffer;
  instances: WebGLBuffer;
  instanceBytes: number;
  u: Record<'u_camera' | 'u_viewport', WebGLUniformLocation | null>;
}

/** GL side of connectors: one instanced draw call for all segments and caps. */
export class LinePass {
  private res: Resources | null = null;
  uploadedBytes = 0;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly layer: LineLayer,
  ) {}

  init(): void {
    const gl = this.gl;
    const program = compileProgram(gl, LINE_VERTEX, LINE_FRAGMENT);
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
      gl.vertexAttribPointer(loc, size, type, normalized, LINE_STRIDE, offset);
      gl.vertexAttribDivisor(loc, 1);
    };
    attr(1, 4, gl.FLOAT, false, 0);
    attr(2, 4, gl.FLOAT, false, 16);
    attr(3, 4, gl.FLOAT, false, 32);
    attr(4, 4, gl.UNSIGNED_BYTE, true, 48);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    this.res = {
      program,
      vao,
      quad,
      instances,
      instanceBytes: 0,
      u: uniforms(gl, program, ['u_camera', 'u_viewport'] as const),
    };
    this.layer.markUploadAll();
  }

  lose(): void {
    this.res = null;
  }

  draw(x: number, y: number, zoom: number, viewportW: number, viewportH: number): void {
    const res = this.res;
    if (!res) return;
    this.upload(res);
    if (this.layer.count === 0) return;
    const gl = this.gl;
    gl.useProgram(res.program);
    gl.uniform3f(res.u.u_camera, x, y, zoom);
    gl.uniform2f(res.u.u_viewport, viewportW, viewportH);
    gl.bindVertexArray(res.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.layer.count);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const res = this.res;
    if (!res) return;
    const gl = this.gl;
    gl.deleteProgram(res.program);
    gl.deleteVertexArray(res.vao);
    gl.deleteBuffer(res.quad);
    gl.deleteBuffer(res.instances);
    this.res = null;
  }

  private upload(res: Resources): void {
    this.uploadedBytes += uploadInstances(
      this.gl,
      res,
      this.layer.data,
      this.layer.count,
      LINE_STRIDE,
      this.layer.takeUpload(),
    );
  }
}
