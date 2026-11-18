// The public API: one way to share a board (`createSync`), and the protocol your
// socket.io server implements. The rest (scene binding, history, presence) is internal.
export * from './create-sync';
export type { AwarenessLike, LockMode, PresenceUser } from './presence';
export type { YjsHistoryOptions } from './history';
export {
  BOARD_EVENTS,
  type BoardEvents,
  type BoardJoinReply,
  type BoardSocket,
  type BoardUpdateReply,
  type Bytes,
} from './protocol';
export type { SocketSyncOptions } from './socket-sync';
