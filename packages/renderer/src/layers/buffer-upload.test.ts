import { describe, expect, it, vi } from 'vitest';
import { coalesceRuns, DirtyRanges, MAX_RUNS, RUN_GAP, uploadInstances } from './buffer-upload';

function setup() {
  const gl = {
    ARRAY_BUFFER: 1,
    DYNAMIC_DRAW: 2,
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    bufferSubData: vi.fn(),
  };
  const target = { instances: {} as WebGLBuffer, instanceBytes: 0 };
  const data = new ArrayBuffer(128 * 1024);
  const upload = (count: number, dirty: Parameters<typeof uploadInstances>[5]) =>
    uploadInstances(gl as unknown as WebGL2RenderingContext, target, data, count, 44, dirty);
  return { gl, target, data, upload };
}

describe('instance buffer uploads', () => {
  it('uploads every used byte on allocation even when only a range was marked', () => {
    const { gl, target, data, upload } = setup();
    expect(upload(10, { kind: 'ranges', runs: [[8, 10]] })).toBe(440);
    expect(target.instanceBytes).toBeGreaterThanOrEqual(440);
    expect(gl.bufferData).toHaveBeenCalledOnce();
    expect(gl.bufferSubData).toHaveBeenCalledWith(gl.ARRAY_BUFFER, 0, new Uint8Array(data, 0, 440));
  });

  it('reuses allocation and uploads just the modified range', () => {
    const { gl, target, data, upload } = setup();
    upload(10, { kind: 'all' });
    const capacity = target.instanceBytes;
    gl.bufferData.mockClear();
    gl.bufferSubData.mockClear();
    expect(upload(10, { kind: 'ranges', runs: [[3, 5]] })).toBe(88);
    expect(target.instanceBytes).toBe(capacity);
    expect(gl.bufferData).not.toHaveBeenCalled();
    expect(gl.bufferSubData).toHaveBeenCalledWith(
      gl.ARRAY_BUFFER,
      132,
      new Uint8Array(data, 132, 88),
    );
    expect(gl.bindBuffer).toHaveBeenLastCalledWith(gl.ARRAY_BUFFER, null);
  });

  it('uploads all live contents again after growth or context restoration', () => {
    const { gl, target, upload } = setup();
    upload(10, { kind: 'all' });
    expect(upload(2000, { kind: 'ranges', runs: [[1999, 2000]] })).toBe(88000);
    expect(gl.bufferData).toHaveBeenCalledTimes(2);
    target.instanceBytes = 0; // a newly created buffer after context loss
    expect(upload(2000, { kind: 'all' })).toBe(88000);
    expect(gl.bufferData).toHaveBeenCalledTimes(3);
  });

  it('does no GL work for an unchanged or empty layer', () => {
    const { gl, upload } = setup();
    expect(upload(10, { kind: 'none' })).toBe(0);
    expect(upload(0, { kind: 'all' })).toBe(0);
    expect(gl.bindBuffer).not.toHaveBeenCalled();
  });

  it('uploads separate runs separately, clipped to the instances in use', () => {
    const { gl, upload } = setup();
    upload(100, { kind: 'all' });
    gl.bufferSubData.mockClear();
    expect(
      upload(100, {
        kind: 'ranges',
        runs: [
          [2, 3],
          [50, 52],
          [99, 120],
        ],
      }),
    ).toBe(4 * 44);
    expect(gl.bufferSubData.mock.calls.map((c) => [c[1], c[2].byteLength])).toEqual([
      [88, 44],
      [2200, 88],
      [4356, 44],
    ]);
  });
});

describe('dirty ranges', () => {
  it('keeps distant edits apart and merges close or overlapping ones', () => {
    const dirty = new DirtyRanges();
    expect(dirty.take()).toEqual({ kind: 'none' });
    dirty.mark(5000, 5002);
    dirty.mark(5, 8);
    dirty.mark(7, 9);
    dirty.mark(9 + RUN_GAP, 9 + RUN_GAP + 1); // just within the gap: merged
    dirty.mark(3, 3); // empty
    expect(dirty.take()).toEqual({
      kind: 'ranges',
      runs: [
        [5, 10 + RUN_GAP],
        [5000, 5002],
      ],
    });
    expect(dirty.take()).toEqual({ kind: 'none' });
  });

  it('turns everything into one full upload after markAll', () => {
    const dirty = new DirtyRanges();
    dirty.mark(1, 2);
    dirty.markAll();
    dirty.mark(4, 5);
    expect(dirty.take()).toEqual({ kind: 'all' });
    expect(dirty.take()).toEqual({ kind: 'none' });
  });

  it('caps the number of uploads by merging the narrowest gaps', () => {
    const runs: Array<[number, number]> = [];
    for (let i = 0; i < 200; i++) runs.push([i * 1000, i * 1000 + 1]);
    runs.push([500, 501]); // the narrowest gaps are around it
    const out = coalesceRuns(runs);
    expect(out.length).toBe(MAX_RUNS);
    // Still covers every marked instance.
    for (const [from, to] of runs) {
      expect(out.some(([a, b]) => a <= from && to <= b)).toBe(true);
    }
    // The narrow gaps around 500 went first; of the equal ones, only as many as needed:
    // 137 gaps of 999 are unavoidable, merging all of them (one run) is not.
    expect(out[0]![0]).toBe(0);
    expect(out[0]![1]).toBeGreaterThanOrEqual(1001);
    const span = out.reduce((s, [a, b]) => s + b - a, 0);
    expect(span).toBeLessThan(140_000);
  });

  it('folds marks made while nothing is uploaded', () => {
    const dirty = new DirtyRanges();
    for (let i = 0; i < 100_000; i++) dirty.mark(i * 100, i * 100 + 1);
    const upload = dirty.take();
    expect(upload.kind).toBe('ranges');
    if (upload.kind === 'ranges') expect(upload.runs.length).toBeLessThanOrEqual(MAX_RUNS);
  });
});
