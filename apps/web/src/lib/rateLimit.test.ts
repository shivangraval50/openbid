import { describe, it, expect } from "vitest";
import { InMemoryRateLimiter } from "./rateLimit";

describe("InMemoryRateLimiter", () => {
  it("allows up to `capacity` requests for a key within one window", () => {
    const limiter = new InMemoryRateLimiter(3, 60_000);
    expect(limiter.tryTake("ip-a", 0)).toBe(true);
    expect(limiter.tryTake("ip-a", 0)).toBe(true);
    expect(limiter.tryTake("ip-a", 0)).toBe(true);
  });

  it("rejects the request that would exceed capacity within the window", () => {
    const limiter = new InMemoryRateLimiter(3, 60_000);
    limiter.tryTake("ip-a", 0);
    limiter.tryTake("ip-a", 0);
    limiter.tryTake("ip-a", 0);
    expect(limiter.tryTake("ip-a", 0)).toBe(false);
  });

  it("tracks separate buckets per key -- one caller's usage never limits another", () => {
    const limiter = new InMemoryRateLimiter(1, 60_000);
    expect(limiter.tryTake("ip-a", 0)).toBe(true);
    // ip-a is now exhausted, but ip-b has never taken a token.
    expect(limiter.tryTake("ip-b", 0)).toBe(true);
    expect(limiter.tryTake("ip-a", 0)).toBe(false);
  });

  it("refills gradually over the window rather than all-at-once at the boundary", () => {
    const limiter = new InMemoryRateLimiter(2, 60_000);
    limiter.tryTake("ip-a", 0);
    limiter.tryTake("ip-a", 0);
    expect(limiter.tryTake("ip-a", 0)).toBe(false);

    // Half the window has passed: half a token's worth of capacity (1 of
    // 2) has refilled -- enough for exactly one more request.
    expect(limiter.tryTake("ip-a", 30_000)).toBe(true);
    expect(limiter.tryTake("ip-a", 30_000)).toBe(false);
  });

  it("allows a full burst again once a full window has fully elapsed", () => {
    const limiter = new InMemoryRateLimiter(2, 60_000);
    limiter.tryTake("ip-a", 0);
    limiter.tryTake("ip-a", 0);
    expect(limiter.tryTake("ip-a", 0)).toBe(false);

    expect(limiter.tryTake("ip-a", 60_000)).toBe(true);
    expect(limiter.tryTake("ip-a", 60_000)).toBe(true);
    expect(limiter.tryTake("ip-a", 60_000)).toBe(false);
  });
});

describe("InMemoryRateLimiter -- stale bucket eviction", () => {
  it("evicts a stale, fully-refilled bucket rather than letting the map grow unbounded", () => {
    const limiter = new InMemoryRateLimiter(2, 60_000);
    limiter.tryTake("ip-a", 0);
    expect(limiter.size).toBe(1);

    // A full window has elapsed since ip-a was last touched, so its
    // bucket has fully refilled and is indistinguishable from a bucket
    // that was never created. A lookup for a completely different key
    // must sweep it out -- proving eviction is a real deletion from the
    // map (size returns to what it would be had ip-a never been seen),
    // not merely "the limiter still behaves correctly for ip-a" (which
    // passing tryTake alone can't rule out: a leaked-but-full bucket is
    // observably identical to no bucket at all from the outside).
    limiter.tryTake("ip-b", 60_000);
    expect(limiter.size).toBe(1); // only ip-b; ip-a was evicted, not retained
  });

  it("does not evict a bucket that has not yet fully refilled, even when it hasn't been touched recently", () => {
    const limiter = new InMemoryRateLimiter(2, 60_000);
    limiter.tryTake("ip-a", 0);
    limiter.tryTake("ip-a", 0); // fully drained: 0 of 2 tokens
    expect(limiter.size).toBe(1);

    // Only half the window has passed -- ip-a has partially refilled (1
    // of 2 tokens) but is not yet full. Sweeping it here would silently
    // grant a free extra token on ip-a's next lookup (a missing bucket
    // starts at full capacity), which would defeat the very budget this
    // limiter exists to enforce.
    limiter.tryTake("ip-b", 30_000);
    expect(limiter.size).toBe(2);
  });
});
