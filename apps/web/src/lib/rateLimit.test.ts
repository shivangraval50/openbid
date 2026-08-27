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
