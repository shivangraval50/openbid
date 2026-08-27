/**
 * Per-connection token bucket. Pure transport bookkeeping: takes a
 * timestamp as a parameter and reads no clock itself, so it stays testable
 * without fake timers, and knows nothing about auction rules — that's what
 * keeps `RoomDO` the only place those rules live.
 *
 * Lives in the socket's serialized attachment so a bucket survives
 * hibernation (the attachment is the only thing Cloudflare guarantees to
 * hand back when a hibernated socket wakes up).
 */

export const CAPACITY = 10;
export const WINDOW_MS = 10_000;

export interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export function newBucket(nowMs: number): Bucket {
  return { tokens: CAPACITY, lastRefillMs: nowMs };
}

export function takeToken(bucket: Bucket, nowMs: number): { allowed: boolean; bucket: Bucket } {
  const elapsedMs = Math.max(0, nowMs - bucket.lastRefillMs);
  const refilled = Math.min(CAPACITY, bucket.tokens + (elapsedMs / WINDOW_MS) * CAPACITY);

  if (refilled < 1) {
    return { allowed: false, bucket: { tokens: refilled, lastRefillMs: nowMs } };
  }
  return { allowed: true, bucket: { tokens: refilled - 1, lastRefillMs: nowMs } };
}
