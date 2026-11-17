import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Camera, Scene, type ShapeElement } from '@apeiro/core';
import { MediaPass } from './media/media-pass';
import { BoardRenderer, createRenderer, type CreateRendererOptions } from './renderer';
import { TextLayer } from './layers/text-layer';

type Call = { name: string; args: unknown[] };

/** WebGL2 stand-in that records every call; enums are their own names. */
function fakeGl(calls: Call[]): WebGL2RenderingContext {
  return new Proxy(
    {},
    {
      get(_, prop: string) {
        if (/^[A-Z0-9_]+$/.test(prop)) return prop;
        return (...args: unknown[]) => {
          calls.push({ name: prop, args });
          if (prop === 'getUniformLocation') return { uniform: args[1] };
          if (prop.startsWith('get') && prop.endsWith('Parameter')) return true;
          if (prop.startsWith('create')) return {};
          return undefined;
        };
      },
    },
  ) as WebGL2RenderingContext;
}

function fakeCanvas(gl: WebGL2RenderingContext): HTMLCanvasElement {
  return {
    width: 0,
    height: 0,
    clientWidth: 800,
    clientHeight: 600,
    getContext: () => gl,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as HTMLCanvasElement;
}

const rect = (id: string, patch: Partial<ShapeElement> = {}): ShapeElement => ({
  id,
  type: 'rect',
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  rotation: 0,
  z: 0,
  fill: 0xff0000ff,
  stroke: 0,
  strokeWidth: 0,
  radius: 0,
  ...patch,
});

describe('BoardRenderer', () => {
  let calls: Call[];
  let scene: Scene;
  let renderer: BoardRenderer;

  beforeEach(() => {
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext() {
          return {
            font: '',
            measureText: (t: string) => ({ width: t.length * 50 }),
          };
        }
      },
    );
    calls = [];
    scene = new Scene();
    const camera = new Camera();
    renderer = new BoardRenderer({ canvas: fakeCanvas(fakeGl(calls)), scene, camera });
  });

  afterEach(() => {
    renderer.destroy();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const renderCalls = () => {
    calls.length = 0;
    renderer.render();
    return calls;
  };

  it('draws shapes in a color pass without depth writes, then a depth-only pass', () => {
    scene.add(rect('a'));
    scene.add(rect('b', { z: 1, fill: 0x00ff0080 }));
    const log = renderCalls();
    const draws = log
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.name === 'drawArraysInstanced' && c.args[3] === 2);
    expect(draws).toHaveLength(2);
    const before = (i: number, name: string) =>
      log
        .slice(0, i)
        .filter((c) => c.name === name)
        .at(-1)?.args;
    // Color pass: depth untouched, so translucent pixels can't erase what's below.
    expect(before(draws[0]!.i, 'depthMask')).toEqual([false]);
    expect(before(draws[0]!.i, 'uniform1f')).toEqual([{ uniform: 'u_depthOnly' }, 0]);
    // Depth pass: color masked off, depth written (the shader discards translucent pixels).
    expect(before(draws[1]!.i, 'depthMask')).toEqual([true]);
    expect(before(draws[1]!.i, 'colorMask')).toEqual([false, false, false, false]);
    expect(before(draws[1]!.i, 'uniform1f')).toEqual([{ uniform: 'u_depthOnly' }, 1]);
    const after = log.slice(draws[1]!.i).find((c) => c.name === 'colorMask');
    expect(after?.args).toEqual([true, true, true, true]);
  });

  it('keeps drawing shapes when text preparation throws', () => {
    vi.spyOn(TextLayer.prototype, 'update').mockImplementation(() => {
      throw new Error('bad glyph');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    scene.add(rect('a'));
    expect(() => renderer.render()).not.toThrow();
    expect(() => renderCalls()).not.toThrow();
    expect(calls.some((c) => c.name === 'drawArraysInstanced')).toBe(true);
    expect(error).toHaveBeenCalledTimes(1); // logged once, not every frame
  });

  it('frees media resources once no element uses them', () => {
    const releaseImage = vi.spyOn(MediaPass.prototype, 'releaseImage');
    const releaseAudio = vi.spyOn(MediaPass.prototype, 'releaseAudio');
    const image = (id: string): ShapeElement =>
      rect(id, { type: 'image', media: { src: 'blob:x' } });
    scene.add(image('i1'));
    scene.add(image('i2'));
    scene.remove('i1');
    expect(releaseImage).not.toHaveBeenCalled(); // i2 still shows it
    scene.remove('i2');
    expect(releaseImage).toHaveBeenCalledWith('blob:x');
    expect(releaseAudio).toHaveBeenCalledWith('i2');
  });
});

describe('createRenderer', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext() {
          return { font: '', measureText: (t: string) => ({ width: t.length * 50 }) };
        }
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const create = async (navigator: unknown, options: Partial<CreateRendererOptions> = {}) => {
    vi.stubGlobal('navigator', navigator);
    const contexts: string[] = [];
    const canvas = fakeCanvas(fakeGl([]));
    const getContext = canvas.getContext;
    canvas.getContext = ((id: string) => {
      contexts.push(id);
      return getContext.call(canvas, id);
    }) as HTMLCanvasElement['getContext'];
    const renderer = await createRenderer({
      canvas,
      scene: new Scene(),
      camera: new Camera(),
      ...options,
    });
    renderer.destroy();
    return { backend: renderer.backend, contexts };
  };

  it('falls back to WebGL when the browser has no WebGPU', async () => {
    expect(await create({})).toEqual({ backend: 'webgl', contexts: ['webgl2'] });
  });

  it('falls back to WebGL without claiming the canvas when no adapter is available', async () => {
    const requestAdapter = vi.fn(async () => null);
    const result = await create({ gpu: { requestAdapter } });
    expect(requestAdapter).toHaveBeenCalled();
    expect(result).toEqual({ backend: 'webgl', contexts: ['webgl2'] });
  });

  it('does not ask for WebGPU when WebGL is forced or the frame must be preserved', async () => {
    const requestAdapter = vi.fn(async () => null);
    await create({ gpu: { requestAdapter } }, { backend: 'webgl' });
    await create({ gpu: { requestAdapter } }, { preserveDrawingBuffer: true });
    expect(requestAdapter).not.toHaveBeenCalled();
  });
});
