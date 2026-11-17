/**
 * The board sync protocol over Socket.IO: what `SocketSync` sends and expects. The server
 * side is yours (any framework); this file is its contract. All binary payloads are Yjs
 * bytes (`Uint8Array`; socket.io delivers them as `Buffer` on Node, `ArrayBuffer` in browsers,
 * both are accepted back). The board id goes first in every message, so one socket can
 * carry several boards.
 *
 * | Event (default name) | Direction        | Payload                     | Ack (reply)          |
 * | -------------------- | ---------------- | --------------------------- | -------------------- |
 * | `board:join`         | client → server  | `boardId, stateVector`      | `BoardJoinReply`     |
 * | `board:update`       | client → server  | `boardId, update`           | `BoardUpdateReply`   |
 * | `board:update`       | server → clients | `boardId, update`           | none                 |
 * | `board:awareness`    | both ways        | `boardId, awarenessUpdate`  | none                 |
 * | `board:leave`        | client → server  | `boardId`                   | none                 |
 *
 * What the server does:
 *
 * - **join**: check the user's right to the board; put the socket in the board's room;
 *   answer with what the client lacks (`Y.encodeStateAsUpdate(serverDoc, stateVector)`,
 *   or `Y.diffUpdate(Y.mergeUpdates(saved), stateVector)` from stored updates), the server's
 *   own state vector and the user's role. Deny with `{ error }`.
 * - **update**: check the right (viewers may send none), the size and the content (apply
 *   to a copy of the document); save it, then send it to the others in the room, and
 *   answer `{ ok: true }`. Refuse with `{ error }`: the client then drops its copy of the
 *   board and joins again. Updates may arrive twice or in any order; applying them again
 *   changes nothing.
 * - **awareness**: forward to the others in the room, never store. Cursor-only changes are
 *   sent volatile (`socket.volatile.emit`): losing one is fine. When a socket disconnects
 *   or leaves, forwarding `removeAwarenessStates` for its clients is optional: others drop
 *   a silent participant by themselves after about 30 s.
 * - **leave**: take the socket out of the room.
 */
export const BOARD_EVENTS = {
  join: 'board:join',
  update: 'board:update',
  awareness: 'board:awareness',
  leave: 'board:leave',
} as const;

/** Names of the events, to match your contracts (`SocketSyncOptions.events`). */
export type BoardEvents = { [K in keyof typeof BOARD_EVENTS]: string };

/** Yjs bytes as socket.io delivers them. */
export type Bytes = Uint8Array | ArrayBuffer;

/** What the user may do on the board: edit it, or only look. */
export type BoardRole = 'edit' | 'view';

/** The answer to `board:join`. */
export type BoardJoinReply =
  | {
      /** What the client lacks, for the state vector it sent. */
      update: Bytes;
      /**
       * The server's state vector, so the client sends only what the server lacks. Without
       * it the client sends its whole document (correct, only bigger).
       */
      stateVector?: Bytes;
      /** Default `edit`. A viewer's board is read-only and sends no changes. */
      role?: BoardRole;
    }
  | {
      /** Joining was refused (no access, no such board…): the sync stops (`denied`). */
      error: string;
    };

/** The answer to a client's `board:update`. No answer at all is fine too (nothing is retried). */
export type BoardUpdateReply = { ok: true } | { error: string };

/** The part of a socket.io client socket the sync uses: a socket.io `Socket` fits as is. */
export interface BoardSocket {
  readonly connected: boolean;
  on(event: string, listener: (...args: never[]) => void): unknown;
  off(event: string, listener: (...args: never[]) => void): unknown;
  emit(event: string, ...args: unknown[]): unknown;
  timeout(ms: number): { emitWithAck(event: string, ...args: unknown[]): Promise<unknown> };
  /** socket.io's volatile flag: cursor updates go this way when there is one. */
  readonly volatile?: { emit(event: string, ...args: unknown[]): unknown };
}
