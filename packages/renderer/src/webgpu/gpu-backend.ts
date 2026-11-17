import type {
  BackendContext,
  BackendFactory,
  FrameParams,
  MediaSource,
  MediaTextures,
  RenderBackend,
  TextureHandle,
} from '../backend';
import { byteRuns, type BufferUpload } from '../layers/buffer-upload';
import type { GlyphAtlas } from '../text/glyph-atlas';
import { INSTANCE_STRIDE } from '../layers/instance-store';
import { LINE_STRIDE } from '../layers/line-layer';
import { GLYPH_STRIDE } from '../layers/text-layer';
import { GRID_WGSL, LINE_WGSL, MEDIA_WGSL, MIPMAP_WGSL, SHAPE_WGSL, TEXT_WGSL } from './shaders';

// The usage flags of the WebGPU spec (TypeScript's DOM types don't declare the globals).
const BUFFER_COPY_DST = 0x8;
const BUFFER_VERTEX = 0x20;
const BUFFER_UNIFORM = 0x40;
const TEXTURE_COPY_DST = 0x2;
const TEXTURE_BINDING = 0x4;
const TEXTURE_RENDER_ATTACHMENT = 0x10;
const STAGE_VERTEX = 0x1;
const STAGE_FRAGMENT = 0x2;

const DEPTH_FORMAT: GPUTextureFormat = 'depth24plus';
const MEDIA_FORMAT: GPUTextureFormat = 'rgba8unorm';
/** Per-draw uniforms (grid levels, media quads) live at offsets of this alignment. */
const DRAW_UNIFORM_ALIGN = 256;
const FRAME_UNIFORM_BYTES = 32;

/** Premultiplied alpha, like the WebGL backend's blendFunc(ONE, ONE_MINUS_SRC_ALPHA). */
const PREMULTIPLIED: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
};

/**
 * Asks for a WebGPU device and prepares everything that doesn't depend on the scene
 * (pipelines are compiled and validated here). Resolves to null when WebGPU isn't
 * available or anything fails: the caller then falls back to WebGL. The canvas is
 * only claimed for WebGPU once the device and pipelines are known to work.
 */
export async function requestWebGpuBackend(
  canvas: HTMLCanvasElement,
): Promise<BackendFactory | null> {
  try {
    const core = await createCore();
    if (!core) return null;
    const context = canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!context) {
      core.device.destroy();
      return null;
    }
    return (ctx) => new WebGpuBackend(ctx, context, core);
  } catch (e) {
    console.warn('apeiro: WebGPU is unavailable, falling back to WebGL', e);
    return null;
  }
}

/** Device-level objects: they live as long as the device. */
interface Core {
  device: GPUDevice;
  format: GPUTextureFormat;
  frameLayout: GPUBindGroupLayout;
  drawLayout: GPUBindGroupLayout;
  textureLayout: GPUBindGroupLayout;
  textLayout: GPUBindGroupLayout;
  grid: GPURenderPipeline;
  shape: GPURenderPipeline;
  shapeDepth: GPURenderPipeline;
  media: GPURenderPipeline;
  line: GPURenderPipeline;
  text: GPURenderPipeline;
  mipmap: GPURenderPipeline;
  linearSampler: GPUSampler;
  mipSampler: GPUSampler;
}

async function createCore(): Promise<Core | null> {
  const gpu = typeof navigator !== 'undefined' ? navigator.gpu : undefined;
  if (!gpu) return null;
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  const format = gpu.getPreferredCanvasFormat();

  device.pushErrorScope('validation');
  device.pushErrorScope('internal');
  const modules = [SHAPE_WGSL, GRID_WGSL, TEXT_WGSL, LINE_WGSL, MEDIA_WGSL, MIPMAP_WGSL].map(
    (code) => device.createShaderModule({ code }),
  );
  const [shapeModule, gridModule, textModule, lineModule, mediaModule, mipModule] = modules as [
    GPUShaderModule,
    GPUShaderModule,
    GPUShaderModule,
    GPUShaderModule,
    GPUShaderModule,
    GPUShaderModule,
  ];

  const both = STAGE_VERTEX | STAGE_FRAGMENT;
  const frameLayout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: both, buffer: { type: 'uniform' } }],
  });
  const drawLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: both, buffer: { type: 'uniform', hasDynamicOffset: true } },
    ],
  });
  const textureLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: STAGE_FRAGMENT, sampler: {} },
      { binding: 1, visibility: STAGE_FRAGMENT, texture: {} },
    ],
  });
  const textLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: STAGE_FRAGMENT, sampler: {} },
      { binding: 1, visibility: STAGE_FRAGMENT, texture: {} },
      { binding: 2, visibility: STAGE_FRAGMENT, texture: {} },
    ],
  });
  const layout = (...groups: GPUBindGroupLayout[]) =>
    device.createPipelineLayout({ bindGroupLayouts: groups });

  /** depthCompare/depthWrite as the WebGL backend sets them for that pass. */
  const pipeline = (
    module: GPUShaderModule,
    pipelineLayout: GPUPipelineLayout,
    depth: { compare: GPUCompareFunction; write: boolean },
    options: {
      buffers?: GPUVertexBufferLayout[];
      fragment?: string;
      colorWrites?: boolean;
      topology?: GPUPrimitiveTopology;
    } = {},
  ) =>
    device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module, entryPoint: 'vs', buffers: options.buffers ?? [] },
      fragment: {
        module,
        entryPoint: options.fragment ?? 'fs',
        targets: [
          {
            format,
            blend: PREMULTIPLIED,
            writeMask: options.colorWrites === false ? 0 : 0xf,
          },
        ],
      },
      primitive: { topology: options.topology ?? 'triangle-strip' },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthCompare: depth.compare,
        depthWriteEnabled: depth.write,
      },
    });

  const instanced = (
    arrayStride: number,
    attributes: Array<[GPUVertexFormat, number]>,
  ): GPUVertexBufferLayout[] => [
    {
      arrayStride,
      stepMode: 'instance',
      attributes: attributes.map(([format, offset], shaderLocation) => ({
        format,
        offset,
        shaderLocation,
      })),
    },
  ];
  // Same layouts as the WebGL attribute pointers (see instance-store, line-layer, text-layer).
  const shapeBuffers = instanced(INSTANCE_STRIDE, [
    ['float32x4', 0],
    ['float32x4', 16],
    ['unorm8x4', 32],
    ['unorm8x4', 36],
    ['float32', 40],
  ]);
  const lineBuffers = instanced(LINE_STRIDE, [
    ['float32x4', 0],
    ['float32x4', 16],
    ['float32x4', 32],
    ['unorm8x4', 48],
  ]);
  const textBuffers = instanced(GLYPH_STRIDE, [
    ['float32x4', 0],
    ['float32x4', 16],
    ['float32x4', 32],
    ['float32', 48],
    ['unorm8x4', 52],
  ]);

  const frameOnly = layout(frameLayout);
  const core: Core = {
    device,
    format,
    frameLayout,
    drawLayout,
    textureLayout,
    textLayout,
    grid: pipeline(
      gridModule,
      layout(frameLayout, drawLayout),
      { compare: 'always', write: false },
      { topology: 'triangle-list' },
    ),
    shape: pipeline(
      shapeModule,
      frameOnly,
      { compare: 'always', write: false },
      { buffers: shapeBuffers },
    ),
    shapeDepth: pipeline(
      shapeModule,
      frameOnly,
      { compare: 'always', write: true },
      { buffers: shapeBuffers, fragment: 'fsDepth', colorWrites: false },
    ),
    media: pipeline(mediaModule, layout(frameLayout, drawLayout, textureLayout), {
      compare: 'less-equal',
      write: true,
    }),
    line: pipeline(
      lineModule,
      frameOnly,
      { compare: 'less-equal', write: true },
      { buffers: lineBuffers },
    ),
    text: pipeline(
      textModule,
      layout(frameLayout, textLayout),
      { compare: 'less', write: false },
      { buffers: textBuffers },
    ),
    mipmap: device.createRenderPipeline({
      layout: layout(textureLayout),
      vertex: { module: mipModule, entryPoint: 'vs' },
      fragment: { module: mipModule, entryPoint: 'fs', targets: [{ format: MEDIA_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    }),
    linearSampler: device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    }),
    mipSampler: device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    }),
  };

  const internal = await device.popErrorScope();
  const validation = await device.popErrorScope();
  const error = validation ?? internal;
  if (error) {
    for (const m of modules) {
      const info = await m.getCompilationInfo();
      for (const msg of info.messages)
        if (msg.type === 'error') console.error('WGSL:', msg.message);
    }
    device.destroy();
    throw new Error(`WebGPU pipeline setup failed: ${error.message}`);
  }
  return core;
}

/** A media texture of this backend. */
interface GpuTexture {
  texture: GPUTexture;
  bindGroup: GPUBindGroup;
  width: number;
  height: number;
  mipmaps: boolean;
}

interface GrowableBuffer {
  buffer: GPUBuffer | null;
  bytes: number;
}

interface AtlasTexture {
  texture: GPUTexture;
  size: number;
}

/** Objects that belong to the current device; recreated after a device loss. */
interface State {
  core: Core;
  frameBuffer: GPUBuffer;
  frameGroup: GPUBindGroup;
  draw: GrowableBuffer;
  drawGroup: GPUBindGroup | null;
  shapes: GrowableBuffer;
  shapeCapacity: number;
  lines: GrowableBuffer;
  glyphs: GrowableBuffer;
  sdf: AtlasTexture;
  color: AtlasTexture;
  textGroup: GPUBindGroup | null;
  /** Bound for the loading placeholder, which samples nothing it uses. */
  emptyTexture: GpuTexture;
  depth: GPUTexture | null;
}

class WebGpuBackend implements RenderBackend, MediaTextures {
  readonly kind = 'webgpu';
  private state: State | null;
  private uploadedBytes = 0;
  private destroyed = false;
  private errorLogged = false;
  /** Reused every frame for the per-draw uniforms. */
  private drawStaging = new ArrayBuffer(DRAW_UNIFORM_ALIGN * 16);

  constructor(
    private readonly ctx: BackendContext,
    private readonly context: GPUCanvasContext,
    core: Core,
  ) {
    this.state = this.init(core);
  }

  get ready(): boolean {
    return this.state !== null;
  }

  get textures(): MediaTextures {
    return this;
  }

  get maxTextureSize(): number {
    return this.state?.core.device.limits.maxTextureDimension2D ?? 8192;
  }

  takeUploadedBytes(): number {
    const n = this.uploadedBytes;
    this.uploadedBytes = 0;
    return n;
  }

  render(f: FrameParams): void {
    const s = this.state;
    if (!s) return;
    const { device } = s.core;
    const { store, lineLayer, textLayer } = this.ctx;

    this.uploadShapes(s);
    this.uploadedBytes += uploadInstances(
      device,
      s.lines,
      lineLayer.data,
      lineLayer.count,
      LINE_STRIDE,
      lineLayer.takeUpload(),
    );
    if (f.drawText) {
      if (this.uploadAtlas(s, this.ctx.sdfAtlas, s.sdf, 'r8unorm')) s.textGroup = null;
      if (this.uploadAtlas(s, this.ctx.colorAtlas, s.color, 'rgba8unorm')) s.textGroup = null;
      this.uploadedBytes += uploadInstances(
        device,
        s.glyphs,
        textLayer.data,
        textLayer.count,
        GLYPH_STRIDE,
        textLayer.takeUpload(),
      );
    }

    const width = this.ctx.canvas.width;
    const height = this.ctx.canvas.height;
    if (!s.depth || s.depth.width !== width || s.depth.height !== height) {
      s.depth?.destroy();
      s.depth = device.createTexture({
        size: [width, height],
        format: DEPTH_FORMAT,
        usage: TEXTURE_RENDER_ATTACHMENT,
      });
    }

    device.queue.writeBuffer(
      s.frameBuffer,
      0,
      new Float32Array([f.x, f.y, f.zoom, f.dpr, f.viewportW, f.viewportH, this.ctx.sdfEdge, 0]),
    );
    const offsets = this.writeDrawUniforms(s, f);

    const encoder = device.createCommandEncoder();
    const [r, g, b, a] = f.background;
    // Premultiplied, like everything drawn over it.
    const clearValue = this.ctx.transparent
      ? { r: r * a, g: g * a, b: b * a, a }
      : { r, g, b, a: 1 };
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue,
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: s.depth.createView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
      },
    });
    pass.setBindGroup(0, s.frameGroup);
    let next = 0;

    if (f.grid && s.drawGroup) {
      pass.setPipeline(s.core.grid);
      for (let i = 0; i < f.grid.levels.length; i++) {
        pass.setBindGroup(1, s.drawGroup, [offsets[next++]!]);
        pass.draw(3);
      }
    }

    // Shapes: color without depth writes, then depth only for mostly-opaque pixels (see
    // the WebGL backend for why).
    if (store.count > 0 && s.shapes.buffer) {
      pass.setVertexBuffer(0, s.shapes.buffer);
      pass.setPipeline(s.core.shape);
      pass.draw(4, store.count);
      pass.setPipeline(s.core.shapeDepth);
      pass.draw(4, store.count);
    }

    if (f.media.length > 0 && s.drawGroup) {
      pass.setPipeline(s.core.media);
      for (const q of f.media) {
        pass.setBindGroup(1, s.drawGroup, [offsets[next++]!]);
        const texture = (q.texture as GpuTexture | null) ?? s.emptyTexture;
        pass.setBindGroup(2, texture.bindGroup);
        pass.draw(4);
      }
    }

    if (lineLayer.count > 0 && s.lines.buffer) {
      pass.setPipeline(s.core.line);
      pass.setVertexBuffer(0, s.lines.buffer);
      pass.draw(4, lineLayer.count);
    }

    if (f.drawText && textLayer.count > 0 && s.glyphs.buffer) {
      s.textGroup ??= device.createBindGroup({
        layout: s.core.textLayout,
        entries: [
          { binding: 0, resource: s.core.linearSampler },
          { binding: 1, resource: s.sdf.texture.createView() },
          { binding: 2, resource: s.color.texture.createView() },
        ],
      });
      pass.setPipeline(s.core.text);
      pass.setBindGroup(1, s.textGroup);
      pass.setVertexBuffer(0, s.glyphs.buffer);
      pass.draw(4, textLayer.count);
    }

    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    this.destroyed = true;
    const s = this.state;
    this.state = null;
    if (!s) return;
    this.context.unconfigure();
    s.core.device.destroy(); // frees every buffer and texture of the device
  }

  // --- Media textures -------------------------------------------------------------

  upload(source: MediaSource, mipmaps: boolean, previous?: TextureHandle): TextureHandle {
    const s = this.state!;
    const { device } = s.core;
    const width = Math.max(1, source.width);
    const height = Math.max(1, source.height);
    let tex = previous as GpuTexture | undefined;
    if (tex && (tex.width !== width || tex.height !== height || tex.mipmaps !== mipmaps)) {
      this.release(tex);
      tex = undefined;
    }
    tex ??= this.createMediaTexture(s, width, height, mipmaps);
    device.queue.copyExternalImageToTexture(
      { source },
      { texture: tex.texture, premultipliedAlpha: true },
      [width, height],
    );
    if (mipmaps) this.generateMipmaps(s, tex.texture);
    return tex;
  }

  release(texture: TextureHandle): void {
    (texture as GpuTexture).texture.destroy();
  }

  private createMediaTexture(
    s: State,
    width: number,
    height: number,
    mipmaps: boolean,
  ): GpuTexture {
    const texture = s.core.device.createTexture({
      size: [width, height],
      format: MEDIA_FORMAT,
      mipLevelCount: mipmaps ? Math.floor(Math.log2(Math.max(width, height))) + 1 : 1,
      usage: TEXTURE_BINDING | TEXTURE_COPY_DST | TEXTURE_RENDER_ATTACHMENT,
    });
    const bindGroup = s.core.device.createBindGroup({
      layout: s.core.textureLayout,
      entries: [
        { binding: 0, resource: mipmaps ? s.core.mipSampler : s.core.linearSampler },
        { binding: 1, resource: texture.createView() },
      ],
    });
    return { texture, bindGroup, width, height, mipmaps };
  }

  /** Each level is the previous one downsampled with linear filtering (a 2x2 box). */
  private generateMipmaps(s: State, texture: GPUTexture): void {
    const { device } = s.core;
    const encoder = device.createCommandEncoder();
    for (let level = 1; level < texture.mipLevelCount; level++) {
      const group = device.createBindGroup({
        layout: s.core.textureLayout,
        entries: [
          { binding: 0, resource: s.core.linearSampler },
          {
            binding: 1,
            resource: texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }),
          },
        ],
      });
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: texture.createView({ baseMipLevel: level, mipLevelCount: 1 }),
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      pass.setPipeline(s.core.mipmap);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
    }
    device.queue.submit([encoder.finish()]);
  }

  // --- Setup and loss ---------------------------------------------------------------

  private init(core: Core): State {
    const { device } = core;
    this.context.configure({
      device,
      format: core.format,
      alphaMode: this.ctx.transparent ? 'premultiplied' : 'opaque',
    });
    device.addEventListener('uncapturederror', (e) => {
      if (this.errorLogged) return;
      this.errorLogged = true;
      console.error('apeiro: WebGPU error', (e as GPUUncapturedErrorEvent).error.message);
    });
    void device.lost.then((info) => this.onDeviceLost(device, info));

    const frameBuffer = device.createBuffer({
      size: FRAME_UNIFORM_BYTES,
      usage: BUFFER_UNIFORM | BUFFER_COPY_DST,
    });
    const atlas = (format: GPUTextureFormat): AtlasTexture => ({
      texture: device.createTexture({
        size: [1, 1],
        format,
        usage: TEXTURE_BINDING | TEXTURE_COPY_DST,
      }),
      size: 0,
    });
    const state: State = {
      core,
      frameBuffer,
      frameGroup: device.createBindGroup({
        layout: core.frameLayout,
        entries: [{ binding: 0, resource: { buffer: frameBuffer } }],
      }),
      draw: { buffer: null, bytes: 0 },
      drawGroup: null,
      shapes: { buffer: null, bytes: 0 },
      shapeCapacity: -1,
      lines: { buffer: null, bytes: 0 },
      glyphs: { buffer: null, bytes: 0 },
      sdf: atlas('r8unorm'),
      color: atlas('rgba8unorm'),
      textGroup: null,
      emptyTexture: null as unknown as GpuTexture,
      depth: null,
    };
    state.emptyTexture = this.createMediaTexture(state, 1, 1, false);
    // Everything must go to the new GPU objects.
    this.ctx.store.markFull();
    this.ctx.lineLayer.markUploadAll();
    this.ctx.textLayer.markUploadAll();
    this.ctx.sdfAtlas.markFullUpload();
    this.ctx.colorAtlas.markFullUpload();
    return state;
  }

  private onDeviceLost(device: GPUDevice, info: GPUDeviceLostInfo): void {
    if (this.destroyed || this.state?.core.device !== device) return;
    console.warn('apeiro: WebGPU device lost, recreating it', info.message);
    this.state = null;
    this.ctx.onLost();
    void this.recover();
  }

  private async recover(): Promise<void> {
    for (let attempt = 0; attempt < 3 && !this.destroyed; attempt++) {
      try {
        const core = await createCore();
        if (!core) break;
        if (this.destroyed) {
          core.device.destroy();
          return;
        }
        this.state = this.init(core);
        this.ctx.onRestored();
        return;
      } catch (e) {
        console.error('apeiro: WebGPU device could not be recreated', e);
      }
    }
  }

  // --- Uploads ----------------------------------------------------------------------

  private uploadShapes(s: State): void {
    const store = this.ctx.store;
    const dirty = store.takeDirty();
    if (dirty.kind === 'none') return;
    const { device } = s.core;
    const data = store.data;
    if (dirty.kind === 'all' || store.capacity !== s.shapeCapacity || !s.shapes.buffer) {
      const size = Math.max(4, data.byteLength);
      if (!s.shapes.buffer || s.shapes.bytes < size) {
        s.shapes.buffer?.destroy();
        s.shapes.buffer = device.createBuffer({ size, usage: BUFFER_VERTEX | BUFFER_COPY_DST });
        s.shapes.bytes = size;
      }
      if (data.byteLength > 0) device.queue.writeBuffer(s.shapes.buffer, 0, data);
      s.shapeCapacity = store.capacity;
      this.uploadedBytes += data.byteLength;
      return;
    }
    for (const [offset, length] of byteRuns(dirty, false, store.count, INSTANCE_STRIDE)) {
      device.queue.writeBuffer(s.shapes.buffer, offset, data, offset, length);
      this.uploadedBytes += length;
    }
  }

  /** Returns true when the texture was replaced (its bind group must be recreated). */
  private uploadAtlas(
    s: State,
    atlas: GlyphAtlas,
    tex: AtlasTexture,
    format: GPUTextureFormat,
  ): boolean {
    const uploads = atlas.takeUploads();
    const size = atlas.size;
    const resized = tex.size !== size;
    if (!resized && !uploads.full && uploads.rects.length === 0) return false;
    const { device } = s.core;
    if (resized) {
      tex.texture.destroy();
      tex.texture = device.createTexture({
        size: [size, size],
        format,
        usage: TEXTURE_BINDING | TEXTURE_COPY_DST,
      });
      tex.size = size;
    }
    const c = atlas.channels;
    if (resized || uploads.full) {
      device.queue.writeTexture({ texture: tex.texture }, atlas.data, { bytesPerRow: size * c }, [
        size,
        size,
      ]);
      this.uploadedBytes += atlas.data.byteLength;
    } else {
      for (const r of uploads.rects) {
        device.queue.writeTexture(
          { texture: tex.texture, origin: [r.x, r.y] },
          r.data,
          { bytesPerRow: r.width * c },
          [r.width, r.height],
        );
        this.uploadedBytes += r.data.byteLength;
      }
    }
    return resized;
  }

  /**
   * Grid levels and media quads each get a slot of per-draw uniforms (one buffer, dynamic
   * offsets): writes to a buffer all land before the frame's commands run, so one shared
   * uniform would leave every draw with the last value.
   */
  private writeDrawUniforms(s: State, f: FrameParams): number[] {
    const levels = f.grid?.levels ?? [];
    const count = levels.length + f.media.length;
    if (count === 0) return [];
    const bytes = count * DRAW_UNIFORM_ALIGN;
    if (this.drawStaging.byteLength < bytes) this.drawStaging = new ArrayBuffer(bytes * 2);
    const floats = new Float32Array(this.drawStaging);
    const offsets: number[] = [];
    let at = 0;
    const put = (values: number[]) => {
      floats.set(values, at / 4);
      offsets.push(at);
      at += DRAW_UNIFORM_ALIGN;
    };
    for (const { spacing, fade } of levels) {
      put([...f.grid!.color, spacing, fade, f.grid!.lines ? 1 : 0, 0]);
    }
    for (const q of f.media) {
      put([...q.rect, ...q.uv, q.rotation, q.depth, q.radius, q.texture ? 0 : 1]);
    }

    const { device } = s.core;
    if (!s.draw.buffer || s.draw.bytes < bytes) {
      s.draw.buffer?.destroy();
      s.draw.bytes = Math.max(bytes * 2, DRAW_UNIFORM_ALIGN * 16);
      s.draw.buffer = device.createBuffer({
        size: s.draw.bytes,
        usage: BUFFER_UNIFORM | BUFFER_COPY_DST,
      });
      s.drawGroup = device.createBindGroup({
        layout: s.core.drawLayout,
        // Each draw sees one slot of the buffer.
        entries: [{ binding: 0, resource: { buffer: s.draw.buffer, size: DRAW_UNIFORM_ALIGN } }],
      });
    }
    device.queue.writeBuffer(s.draw.buffer, 0, this.drawStaging, 0, bytes);
    return offsets;
  }
}

/**
 * Like the WebGL `uploadInstances`: grows the buffer with spare room (growth needs a new
 * buffer, so it gets everything), otherwise writes only the dirty runs.
 */
function uploadInstances(
  device: GPUDevice,
  target: GrowableBuffer,
  data: ArrayBuffer,
  count: number,
  stride: number,
  upload: BufferUpload,
): number {
  if (upload.kind === 'none' || count === 0) return 0;
  const bytes = count * stride;
  const grow = !target.buffer || bytes > target.bytes;
  if (grow) {
    target.buffer?.destroy();
    target.bytes = Math.ceil(Math.max(bytes * 1.5, 64 * 1024) / 4) * 4;
    target.buffer = device.createBuffer({
      size: target.bytes,
      usage: BUFFER_VERTEX | BUFFER_COPY_DST,
    });
  }
  let uploaded = 0;
  for (const [offset, length] of byteRuns(upload, grow, count, stride)) {
    device.queue.writeBuffer(target.buffer!, offset, data, offset, length);
    uploaded += length;
  }
  return uploaded;
}
