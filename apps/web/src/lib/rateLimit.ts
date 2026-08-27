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
 *
 * The key passed to `tryTake` is trusted as-is -- this class has no way
 * to know whether it's forgeable (a client-suppliable header vs. a
 * platform-set one), so whoever calls it is responsible for choosing a
 * key an attacker can't rotate at will. See apps/web/src/app/api/bot/
 * route.ts's `clientKey` for that judgment call.
 *
 * `buckets` never shrinks on its own otherwise -- every distinct key ever
 * seen would stay in the map forever on a long-lived instance. `tryTake`
 * opportunistically sweeps out stale entries on every call (see
 * `evictStale` below) rather than running a background timer, so there is
 * no standing interval to leak or clean up.
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
  const refilled = refillAmount(bucket, capacity, windowMs, nowMs);

  if (refilled < 1) {
    return { allowed: false, bucket: { tokens: refilled, lastRefillMs: nowMs } };
  }
  return { allowed: true, bucket: { tokens: refilled - 1, lastRefillMs: nowMs } };
}

function refillAmount(bucket: Bucket, capacity: number, windowMs: number, nowMs: number): number {
  const elapsedMs = Math.max(0, nowMs - bucket.lastRefillMs);
  return Math.min(capacity, bucket.tokens + (elapsedMs / windowMs) * capacity);
}

export class InMemoryRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly capacity: number,
    private readonly windowMs: number
  ) {}

  /** Number of distinct keys currently held. Exists so tests can prove
   * `evictStale` actually deletes entries, not just that `tryTake` keeps
   * behaving correctly for a key whose stale bucket was left behind --
   * the latter can't distinguish "evicted" from "leaked but harmless." */
  get size(): number {
    return this.buckets.size;
  }

  /** Returns whether `key` may proceed, consuming a token if so. */
  tryTake(key: string, nowMs: number): boolean {
    this.evictStale(nowMs);

    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, lastRefillMs: nowMs };
    const { allowed, bucket: next } = takeToken(bucket, this.capacity, this.windowMs, nowMs);
    this.buckets.set(key, next);
    return allowed;
  }

  /**
   * Drops any bucket that has fully refilled -- recomputed via the same
   * refill formula `tryTake` uses, not inferred from elapsed time alone,
   * so this stays correct even if that formula ever changes. A fully
   * refilled bucket is behaviourally identical to no bucket at all
   * (`tryTake`'s own fallback starts a missing key at full capacity), so
   * deleting it changes nothing observable -- it only reclaims memory
   * from keys nobody has hit recently. A partially-drained bucket is
   * left alone: evicting it early would silently grant a free extra
   * token on that key's next lookup.
   *
   * Runs a full pass over `buckets` on every `tryTake` call rather than
   * on a schedule. That's O(distinct live keys) per call, which is fine
   * at this route's expected traffic (a handful of concurrent callers,
   * not a high-QPS public API) -- a busier deployment would want a
   * cheaper amortized sweep (e.g. only on every Nth call), not this.
   */
  private evictStale(nowMs: number): void {
    for (const [key, bucket] of this.buckets) {
      if (refillAmount(bucket, this.capacity, this.windowMs, nowMs) >= this.capacity) {
        this.buckets.delete(key);
      }
    }
  }
}
