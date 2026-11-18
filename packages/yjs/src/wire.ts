// Checking what arrives from the socket (internal).
import type { BoardRole } from '@apeiro/editor';
import type { Bytes } from './protocol';

export const isBytes = (data: unknown): data is Bytes =>
  data instanceof Uint8Array || data instanceof ArrayBuffer;

export const toBytes = (data: Bytes): Uint8Array =>
  data instanceof Uint8Array ? data : new Uint8Array(data);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** The error of a reply (`{ error }`), or null. */
export const replyError = (reply: unknown): string | null =>
  isRecord(reply) && 'error' in reply ? String(reply.error) : null;

/** A well-formed accepting join reply, or null. */
export function joinAccepted(
  reply: unknown,
): { update: Uint8Array; stateVector: Uint8Array | null; role: BoardRole } | null {
  if (!isRecord(reply) || !isBytes(reply.update)) return null;
  const sv = reply.stateVector;
  if (sv !== undefined && sv !== null && !isBytes(sv)) return null;
  return {
    update: toBytes(reply.update),
    stateVector: sv ? toBytes(sv) : null,
    role: reply.role === 'view' ? 'view' : 'edit',
  };
}
