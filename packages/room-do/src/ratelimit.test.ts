import { describe, it, expect } from "vitest";
import { newBucket, takeToken, CAPACITY, WINDOW_MS } from "./ratelimit.js";

describe("token bucket", () => {
  it("allows exactly CAPACITY bids in a burst", () => {
    let bucket = newBucket(0);
    for (let i = 0; i < CAPACITY; i += 1) {
      const result = takeToken(bucket, 0);
      expect(result.allowed).toBe(true);
      bucket = result.bucket;
    }
    expect(takeToken(bucket, 0).allowed).toBe(false);
  });

  it("refills fully after the window elapses", () => {
    let bucket = newBucket(0);
    for (let i = 0; i < CAPACITY; i += 1) bucket = takeToken(bucket, 0).bucket;
    expect(takeToken(bucket, WINDOW_MS).allowed).toBe(true);
  });

  it("refills proportionally partway through the window", () => {
    let bucket = newBucket(0);
    for (let i = 0; i < CAPACITY; i += 1) bucket = takeToken(bucket, 0).bucket;
    const half = takeToken(bucket, WINDOW_MS / 2);
    expect(half.allowed).toBe(true);
    expect(half.bucket.tokens).toBeLessThan(CAPACITY);
  });

  it("never exceeds capacity no matter how long it idles", () => {
    const bucket = newBucket(0);
    const result = takeToken(bucket, WINDOW_MS * 1000);
    expect(result.bucket.tokens).toBeLessThanOrEqual(CAPACITY);
  });
});
