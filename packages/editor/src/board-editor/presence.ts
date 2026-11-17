import type { Vec2 } from '@apeiro/core';
import type { Overlay } from '../overlay/overlay';

/** Another participant of a shared board, as a presence source (e.g. Yjs awareness) reports it. */
export interface Peer {
  /** Stable for the connection (Yjs: the client id). */
  id: number | string;
  name: string;
  /** CSS color of the participant's cursor and selection. */
  color: string;
  /** Pointer in world coordinates; null while it is outside the board. */
  cursor: Vec2 | null;
  selection: readonly string[];
  /** Element whose text the participant is typing in. */
  editing: string | null;
}

/** Who else is on the board; set by a collaboration adapter (see `apeiro/yjs`). */
export interface PresenceSource {
  /** Current participants other than this one. Same array until something changes. */
  getPeers(): readonly Peer[];
  /**
   * Elements other participants hold, with who holds each: this user can't select or edit
   * them. Same map until something changes. Without it nothing is locked.
   */
  getLocks?(): ReadonlyMap<string, Peer>;
  subscribe(listener: () => void): () => void;
}

export const NO_PEERS: readonly Peer[] = Object.freeze([]);
export const NO_LOCKS: ReadonlyMap<string, Peer> = new Map();

/**
 * Another participant's cursor covers the gap to a newly received point in about this time
 * (63% of it; exponential). Matched to the presence's send interval (50 ms by default), so it
 * moves continuously with little added delay.
 */
const CURSOR_GLIDE_MS = 30;
/** A jump longer than this (screen px) is shown at once, not glided. */
const CURSOR_SNAP_PX = 600;
/** Names longer than this are cut with an ellipsis. */
const MAX_NAME_LENGTH = 24;

const peerIdSets = new WeakMap<readonly string[], ReadonlySet<string>>();

/** A set of a peer's selection, made once per selection array (they are replaced, not mutated). */
function peerIds(ids: readonly string[]): ReadonlySet<string> {
  let set = peerIdSets.get(ids);
  if (!set) peerIdSets.set(ids, (set = new Set(ids)));
  return set;
}

/**
 * Draws other participants on the overlay: their selections in their color, and their
 * cursors with name tags. Cursors arrive a few times a second (see the presence's
 * throttle); drawn as they come they would jump, so each drawn cursor glides to the last
 * received point instead.
 */
export class PeerCursors {
  /** Where each participant's cursor is drawn now. */
  private readonly shown = new Map<Peer['id'], { x: number; y: number; at: number }>();

  draw(
    ctx: CanvasRenderingContext2D,
    zoom: number,
    peers: readonly Peer[] | undefined,
    overlay: Overlay | undefined,
  ): void {
    if (!peers || peers.length === 0) {
      this.shown.clear();
      return;
    }
    // Their selections look like a selection here (outlines and frame), in their color and
    // without handles: nothing to grab.
    for (const peer of peers) {
      if (peer.selection.length > 0)
        overlay?.drawForeignSelection(peerIds(peer.selection), peer.color);
    }
    ctx.font = `600 ${12 / zoom}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    const now = performance.now();
    let moving = false;
    const present = new Set<Peer['id']>();
    for (const peer of peers) {
      if (!peer.cursor) continue;
      present.add(peer.id);
      const { at, gliding } = this.glide(peer.id, peer.cursor, now, zoom);
      if (gliding) moving = true;
      drawCursor(ctx, at, peer, 1 / zoom);
    }
    // Gone, or off the board: the cursor appears where it comes back, without gliding there.
    for (const id of this.shown.keys()) if (!present.has(id)) this.shown.delete(id);
    // Still gliding: draw again next frame.
    if (moving) overlay?.request();
  }

  /** Moves the drawn cursor of `id` toward `target`; returns where to draw it now. */
  private glide(
    id: Peer['id'],
    target: Vec2,
    now: number,
    zoom: number,
  ): { at: Vec2; gliding: boolean } {
    let c = this.shown.get(id);
    const far = c && Math.hypot(target.x - c.x, target.y - c.y) * zoom > CURSOR_SNAP_PX;
    if (!c || far) {
      c = { x: target.x, y: target.y, at: now };
      this.shown.set(id, c);
      return { at: c, gliding: false };
    }
    // At most two frames' worth: after a pause the first step must not jump.
    const dt = Math.min(now - c.at, 34);
    const k = 1 - Math.exp(-dt / CURSOR_GLIDE_MS);
    c.x += (target.x - c.x) * k;
    c.y += (target.y - c.y) * k;
    c.at = now;
    if (Math.hypot(target.x - c.x, target.y - c.y) * zoom > 0.25) return { at: c, gliding: true };
    c.x = target.x;
    c.y = target.y;
    return { at: c, gliding: false };
  }
}

/** An arrow cursor (18 screen px tall) in the peer's color, with their name tag. `s`: world units per px. */
function drawCursor(ctx: CanvasRenderingContext2D, c: Vec2, peer: Peer, s: number): void {
  ctx.beginPath();
  ctx.moveTo(c.x, c.y);
  ctx.lineTo(c.x, c.y + 17 * s);
  ctx.lineTo(c.x + 4.5 * s, c.y + 13 * s);
  ctx.lineTo(c.x + 7.5 * s, c.y + 19.5 * s);
  ctx.lineTo(c.x + 10 * s, c.y + 18.5 * s);
  ctx.lineTo(c.x + 7 * s, c.y + 12 * s);
  ctx.lineTo(c.x + 12.5 * s, c.y + 12 * s);
  ctx.closePath();
  ctx.fillStyle = peer.color;
  ctx.fill();
  ctx.lineWidth = 1.5 * s;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  if (!peer.name) return;
  const label =
    peer.name.length > MAX_NAME_LENGTH ? `${peer.name.slice(0, MAX_NAME_LENGTH - 1)}…` : peer.name;
  const w = ctx.measureText(label).width + 12 * s;
  const x = c.x + 12 * s;
  const y = c.y + 20 * s;
  ctx.fillStyle = peer.color;
  ctx.beginPath();
  ctx.roundRect(x, y, w, 20 * s, 6 * s);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, x + 6 * s, y + 10 * s);
}
