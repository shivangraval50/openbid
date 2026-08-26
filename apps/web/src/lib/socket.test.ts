import { describe, it, expect } from "vitest";
import { backoffMs } from "./socket";

describe("backoffMs", () => {
  it("starts at half a second", () => {
    expect(backoffMs(0)).toBe(500);
  });

  it("doubles per attempt", () => {
    expect(backoffMs(1)).toBe(1_000);
    expect(backoffMs(2)).toBe(2_000);
  });

  it("caps at thirty seconds", () => {
    expect(backoffMs(20)).toBe(30_000);
  });

  // Pins the exact crossover point rather than only a value far past the
  // cap. Catches an off-by-one in the cap threshold (e.g. capping starting
  // one attempt too early or late) that a single far-away assertion like
  // `backoffMs(20)` would not distinguish from the correct formula.
  it("pins the exact attempt where doubling would exceed the cap", () => {
    expect(backoffMs(5)).toBe(16_000); // 500 * 2**5, still under the cap
    expect(backoffMs(6)).toBe(30_000); // 500 * 2**6 = 32_000, clamped
  });
});
