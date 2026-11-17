/** Dirty instances (not byte offsets): nothing, everything, or sorted disjoint half-open runs. */
export type BufferUpload =
  | { kind: 'none' }
  | { kind: 'all' }
  | { kind: 'ranges'; runs: ReadonlyArray<readonly [number, number]> };

/** Runs closer than this many instances go up as one: an upload call costs more than a few bytes. */
export const RUN_GAP = 32;
/** At most this many uploads per buffer and frame; the narrowest gaps are merged first. */
export const MAX_RUNS = 64;
/** Unsorted marks kept before they are folded together (e.g. edits while nothing is drawn). */
const MAX_PENDING = 4096;

/**
 * Sorts runs and merges overlapping ones and those separated by at most `gap` instances.
 * If more than `max` runs remain, the narrowest gaps are merged until at most `max` are left.
 */
export function coalesceRuns(
  runs: Array<[number, number]>,
  gap = RUN_GAP,
  max = MAX_RUNS,
): Array<[number, number]> {
  runs.sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [from, to] of runs) {
    const last = out[out.length - 1];
    if (last && from <= last[1] + gap) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  if (out.length <= max) return out;
  // Merge exactly the (n - max) narrowest gaps: gap i lies between runs i - 1 and i.
  const order = Array.from({ length: out.length - 1 }, (_, i) => i + 1);
  order.sort((a, b) => out[a]![0] - out[a - 1]![1] - (out[b]![0] - out[b - 1]![1]));
  const join = new Set(order.slice(0, out.length - max));
  const capped: Array<[number, number]> = [out[0]!];
  for (let i = 1; i < out.length; i++) {
    if (join.has(i)) capped[capped.length - 1]![1] = out[i]![1];
    else capped.push(out[i]!);
  }
  return capped;
}

/**
 * Collects the instances changed since the last upload. Separate edits stay separate uploads
 * (a few scattered changes don't upload the whole span between them), close ones are merged.
 */
export class DirtyRanges {
  private all = false;
  private pending: Array<[number, number]> = [];

  /** Marks instances `from` (inclusive) to `to` (exclusive). */
  mark(from: number, to: number): void {
    if (from >= to || this.all) return;
    this.pending.push([from, to]);
    if (this.pending.length > MAX_PENDING) this.pending = coalesceRuns(this.pending);
  }

  markAll(): void {
    this.all = true;
    this.pending = [];
  }

  /** What changed since the last call; resets. */
  take(): BufferUpload {
    if (this.all) {
      this.all = false;
      return { kind: 'all' };
    }
    if (this.pending.length === 0) return { kind: 'none' };
    const runs = coalesceRuns(this.pending);
    this.pending = [];
    return { kind: 'ranges', runs };
  }
}

export interface InstanceBuffer {
  instances: WebGLBuffer;
  instanceBytes: number;
}

/**
 * Uploads a CPU layer to its GPU buffer and returns bytes transferred (not allocated).
 * Growth invalidates the old contents, so even a partial update must upload all instances.
 * Spare capacity avoids reallocating when the visible text or a connector grows slightly.
 */
export function uploadInstances(
  gl: WebGL2RenderingContext,
  target: InstanceBuffer,
  data: ArrayBuffer,
  count: number,
  stride: number,
  upload: BufferUpload,
): number {
  if (upload.kind === 'none' || count === 0) return 0;
  const bytes = count * stride;
  const grow = bytes > target.instanceBytes;
  gl.bindBuffer(gl.ARRAY_BUFFER, target.instances);
  if (grow) {
    target.instanceBytes = Math.ceil(Math.max(bytes * 1.5, 64 * 1024));
    gl.bufferData(gl.ARRAY_BUFFER, target.instanceBytes, gl.DYNAMIC_DRAW);
  }
  let uploaded = 0;
  for (const [offset, length] of byteRuns(upload, grow, count, stride)) {
    gl.bufferSubData(gl.ARRAY_BUFFER, offset, new Uint8Array(data, offset, length));
    uploaded += length;
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  return uploaded;
}

/**
 * Byte [offset, length] pairs to upload: every used byte for `all` or a fresh buffer,
 * otherwise each dirty run clipped to the instances in use.
 */
export function byteRuns(
  upload: BufferUpload,
  fresh: boolean,
  count: number,
  stride: number,
): Array<[number, number]> {
  if (upload.kind === 'none' || count === 0) return [];
  if (fresh || upload.kind === 'all') return [[0, count * stride]];
  const out: Array<[number, number]> = [];
  for (const [from, to] of upload.runs) {
    const end = Math.min(to, count);
    if (from < end) out.push([from * stride, (end - from) * stride]);
  }
  return out;
}
