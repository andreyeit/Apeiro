import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoardEditor, type Peer, type PresenceSource } from './board-editor';

/** A canvas context that remembers where each cursor arrow starts (its first `moveTo`). */
function fakeContext() {
  const starts: Array<{ x: number; y: number }> = [];
  let first = false;
  const ctx = new Proxy(
    {
      beginPath: () => (first = true),
      moveTo: (x: number, y: number) => {
        if (first) starts.push({ x, y });
        first = false;
      },
      measureText: () => ({ width: 10 }),
    } as Record<string, unknown>,
    { get: (t, k) => (k in t ? t[k as string] : () => undefined), set: () => true },
  );
  return { ctx: ctx as unknown as CanvasRenderingContext2D, starts };
}

const peer = (x: number, y: number): Peer => ({
  id: 7,
  name: '',
  color: '#e11d48',
  cursor: { x, y },
  selection: [],
  editing: null,
});

afterEach(() => vi.restoreAllMocks());

describe('other participants’ cursors', () => {
  it('glide to a newly received point instead of jumping', () => {
    let peers = [peer(0, 0)];
    const source: PresenceSource = { getPeers: () => peers, subscribe: () => () => undefined };
    const editor = new BoardEditor();
    editor.setPresence(source);
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const draw = (
      editor as unknown as { drawPeers: (c: CanvasRenderingContext2D, z: number) => void }
    ).drawPeers;
    const at = () => {
      const { ctx, starts } = fakeContext();
      draw(ctx, 1);
      return starts[0]!;
    };

    expect(at()).toEqual({ x: 0, y: 0 }); // first seen: right where it is
    peers = [peer(100, 0)];
    now += 16;
    const step = at().x;
    expect(step).toBeGreaterThan(20);
    expect(step).toBeLessThan(80); // on the way, not there yet
    for (let i = 0; i < 30; i++) {
      now += 16;
      at();
    }
    expect(at()).toEqual({ x: 100, y: 0 }); // arrived

    // After a long pause the first step is still a glide, not a jump.
    now += 5000;
    peers = [peer(200, 0)];
    expect(at().x).toBeLessThan(180);

    // A jump across the screen is shown at once.
    peers = [peer(5000, 0)];
    now += 16;
    expect(at()).toEqual({ x: 5000, y: 0 });
    editor.destroy();
  });
});
