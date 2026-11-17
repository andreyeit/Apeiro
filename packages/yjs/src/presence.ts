import type { Peer, PresenceSource } from '@apeiro/editor';
import type { Vec2 } from '@apeiro/core';

/**
 * The part of y-protocols' `Awareness` the presence uses (providers such as y-websocket,
 * Hocuspocus and y-webrtc expose one as `provider.awareness`).
 */
export interface AwarenessLike {
  readonly clientID: number;
  getStates(): Map<number, Record<string, unknown>>;
  getLocalState(): Record<string, unknown> | null;
  setLocalStateField(field: string, value: unknown): void;
  on(event: 'change', listener: (...args: unknown[]) => void): void;
  off(event: 'change', listener: (...args: unknown[]) => void): void;
}

export interface PresenceUser {
  name: string;
  /** CSS color of the cursor and selection outline others see. */
  color: string;
}

/** Board part of a participant's awareness state. */
export interface BoardPresenceState {
  /** Pointer in world coordinates; null while it is outside the board. */
  cursor: Vec2 | null;
  /** Ids of the selected elements. */
  selection: string[];
  /** Id of the element whose text the participant is typing in. */
  editing: string | null;
}

/**
 * A participant's Yjs awareness state as apeiro writes and reads it: the JSON each
 * client sends on the awareness channel (cursor moves at most every `throttleMs`). Apps may
 * add fields of their own next to these.
 */
export interface BoardAwarenessState {
  /** How others see this participant (the Yjs convention, shared with other apps). */
  user?: PresenceUser;
  /** Board state, under the `field` option (default `board`); null after `destroy`. */
  board?: BoardPresenceState | null;
  [field: string]: unknown;
}

/** The minimal editor the presence reads from (a `BoardEditor`). */
export interface PresenceEditor {
  readonly pointer: Vec2 | null;
  readonly selection: readonly string[];
  readonly editing: string | null;
  /** A viewer: what they select is not shared, so it locks nothing for the others. */
  readonly readOnly?: boolean;
  on(event: 'pointer' | 'selection' | 'editing' | 'readOnly', listener: () => void): () => void;
}

/** See `PresenceOptions.lock`. */
export type LockMode = 'selection' | 'editing' | false;

export interface PresenceOptions {
  /** This user as shown to others. Stored in the awareness `user` field (the Yjs convention). */
  user?: PresenceUser;
  /** Awareness field with the board state (default `board`). */
  field?: string;
  /** Minimum time between cursor updates sent, ms (default 50). */
  throttleMs?: number;
  /**
   * What another participant holds, so that this user can't select or edit it:
   * `selection` (default): what they selected or are typing in; `editing`: only the text
   * they are typing in; `false`: nothing (everyone edits everything, last writer wins).
   * When two people take the same element at once, the lower client id keeps it.
   */
  lock?: LockMode;
}

const PALETTE = [
  '#e11d48',
  '#2563eb',
  '#16a34a',
  '#d97706',
  '#7c3aed',
  '#0891b2',
  '#db2777',
  '#4d7c0f',
];

/** A color picked from the client id, for users without one. */
export const colorForClient = (id: number): string => PALETTE[Math.abs(id) % PALETTE.length]!;

const isVec = (v: unknown): v is Vec2 =>
  !!v && typeof v === 'object' && Number.isFinite((v as Vec2).x) && Number.isFinite((v as Vec2).y);

/**
 * Shares this user's cursor, selection and edited text through Yjs awareness, and reports
 * everyone else's as `Peer`s (drawn on the board by `BoardEditor` once it is set as the
 * editor's presence source).
 */
export class YjsPresence implements PresenceSource {
  private peers: readonly Peer[] = [];
  private locks: ReadonlyMap<string, Peer> = new Map();
  private readonly lockMode: LockMode;
  private listeners = new Set<() => void>();
  private readonly field: string;
  private readonly throttleMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSent = 0;
  private disposers: Array<() => void> = [];

  constructor(
    private readonly editor: PresenceEditor,
    readonly awareness: AwarenessLike,
    options: PresenceOptions = {},
  ) {
    this.field = options.field ?? 'board';
    this.throttleMs = options.throttleMs ?? 50;
    this.lockMode = options.lock ?? 'selection';
    if (options.user) awareness.setLocalStateField('user', options.user);
    awareness.on('change', this.onChange);
    this.disposers.push(
      () => awareness.off('change', this.onChange),
      editor.on('pointer', this.schedule),
      editor.on('selection', this.sendNow),
      editor.on('editing', this.sendNow),
      editor.on('readOnly', this.sendNow),
    );
    this.sendNow();
    this.onChange();
  }

  getPeers(): readonly Peer[] {
    return this.peers;
  }

  getLocks(): ReadonlyMap<string, Peer> {
    return this.locks;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Changes how this user is shown to others. */
  setUser(user: PresenceUser): void {
    this.awareness.setLocalStateField('user', user);
  }

  destroy(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const d of this.disposers) d();
    this.disposers = [];
    this.awareness.setLocalStateField(this.field, null);
    this.listeners.clear();
  }

  private state(): BoardPresenceState {
    return {
      cursor: this.editor.pointer,
      selection: this.editor.readOnly ? [] : [...this.editor.selection],
      editing: this.editor.editing,
    };
  }

  private readonly sendNow = (): void => {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.lastSent = Date.now();
    this.awareness.setLocalStateField(this.field, this.state());
    // This user took or released elements: a tie with someone else may resolve differently.
    if (this.updateLocks()) this.notify();
  };

  private notify(): void {
    for (const l of [...this.listeners]) l();
  }

  /** Recomputes who holds what; true if it changed. */
  private updateLocks(): boolean {
    const next = new Map<string, Peer>();
    if (this.lockMode !== false) {
      const mine = new Set(this.editor.selection);
      if (this.editor.editing) mine.add(this.editor.editing);
      const me = this.awareness.clientID;
      // Peers are sorted by id: the first holder of an element keeps it.
      for (const peer of this.peers) {
        const held = this.lockMode === 'selection' ? [...peer.selection] : [];
        if (peer.editing) held.push(peer.editing);
        for (const id of held) {
          if (next.has(id)) continue;
          if (mine.has(id) && me < Number(peer.id)) continue; // taken at once: ours
          next.set(id, peer);
        }
      }
    }
    const prev = this.locks;
    const same = (a: Peer | undefined, b: Peer) =>
      !!a && a.id === b.id && a.name === b.name && a.color === b.color;
    if (prev.size === next.size && [...next].every(([id, p]) => same(prev.get(id), p)))
      return false;
    this.locks = next;
    return true;
  }

  /** Cursor moves are throttled; the last position is always sent. */
  private readonly schedule = (): void => {
    if (this.timer) return;
    const wait = this.throttleMs - (Date.now() - this.lastSent);
    if (wait <= 0) this.sendNow();
    else this.timer = setTimeout(this.sendNow, wait);
  };

  private readonly onChange = (): void => {
    const peers: Peer[] = [];
    for (const [id, state] of this.awareness.getStates()) {
      if (id === this.awareness.clientID || !state) continue;
      const board = state[this.field] as Partial<BoardPresenceState> | null | undefined;
      if (!board || typeof board !== 'object') continue;
      const user = (state.user ?? {}) as Partial<PresenceUser>;
      peers.push({
        id,
        name: typeof user.name === 'string' ? user.name : '',
        color: typeof user.color === 'string' ? user.color : colorForClient(id),
        cursor: isVec(board.cursor) ? board.cursor : null,
        selection: Array.isArray(board.selection)
          ? board.selection.filter((s): s is string => typeof s === 'string')
          : [],
        editing: typeof board.editing === 'string' ? board.editing : null,
      });
    }
    peers.sort((a, b) => Number(a.id) - Number(b.id));
    const peersChanged = !samePeers(peers, this.peers);
    if (peersChanged) this.peers = peers;
    const locksChanged = this.updateLocks();
    if (peersChanged || locksChanged) this.notify();
  };
}

function samePeers(a: readonly Peer[], b: readonly Peer[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!;
    const q = b[i]!;
    if (
      p.id !== q.id ||
      p.name !== q.name ||
      p.color !== q.color ||
      p.editing !== q.editing ||
      p.cursor?.x !== q.cursor?.x ||
      p.cursor?.y !== q.cursor?.y ||
      p.selection.length !== q.selection.length ||
      p.selection.some((s, j) => s !== q.selection[j])
    )
      return false;
  }
  return true;
}
