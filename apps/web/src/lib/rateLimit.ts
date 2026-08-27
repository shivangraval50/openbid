/**
 * A per-key, in-process token bucket, used to blunt a single caller
 * hammering `/api/bot` (which spends real Anthropic/Gemini tokens per
 * request, unlike a bid submission).
 *
 * Modeled on `packages/room-do/src/ratelimit.ts`'s algorithm, but not
 * reused directly: that file hardcodes `CAPACITY`/`WINDOW_MS` as module
 * constants tuned for free bid-submission rate limiting (10 requests /
 * 10s), not parameters -- importing it as-is would silently apply that
 * bid-submission rate to a cost-bearing LLM route, a number nobody chose
 * for this purpose. This is the same refill algorithm with capacity and
 * window taken as constructor arguments instead.
 *
 * Deliberately NOT backed by an external store (Upstash or similar) --
 * this is a best-effort, per-instance limiter, not a durable one. On
 * serverless, each warm instance holds its own `Map`, so a client whose
 * requests land on different instances -- or that arrives right after a
 * cold start, which starts every bucket fresh -- can exceed the nominal
 * rate across the fleet. It stops one hot client from hammering one
 * instance; it does not guarantee a global cap.
 */
interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

function takeToken(
  bucket: Bucket,
  capacity: number,
  windowMs: number,
  nowMs: number
): { allowed: boolean; bucket: Bucket } {
  const elapsedMs = Math.max(0, nowMs - bucket.lastRefillMs);
  const refilled = Math.min(capacity, bucket.tokens + (elapsedMs / windowMs) * capacity);

  if (refilled < 1) {
    return { allowed: false, bucket: { tokens: refilled, lastRefillMs: nowMs } };
  }
  return { allowed: true, bucket: { tokens: refilled - 1, lastRefillMs: nowMs } };
}

export class InMemoryRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly capacity: number,
    private readonly windowMs: number
  ) {}

  /** Returns whether `key` may proceed, consuming a token if so. */
  tryTake(key: string, nowMs: number): boolean {
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, lastRefillMs: nowMs };
    const { allowed, bucket: next } = takeToken(bucket, this.capacity, this.windowMs, nowMs);
    this.buckets.set(key, next);
    return allowed;
  }
}
