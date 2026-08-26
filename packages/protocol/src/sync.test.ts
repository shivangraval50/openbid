import { describe, it, expect } from "vitest";
import { rejectReasonSchema } from "./index.js";

// auction-core owns the reasons semantically; protocol owns them on the wire.
// They are declared independently so the rules layer stays dependency-free.
// This test is the seam that keeps them identical.
const EXPECTED_REASONS = [
  "TOO_LOW",
  "AUCTION_CLOSED",
  "RATE_LIMITED",
  "INSUFFICIENT_BUDGET",
] as const;

describe("reject reason sync", () => {
  it("matches the reasons auction-core can produce", () => {
    expect([...rejectReasonSchema.options].sort()).toEqual([...EXPECTED_REASONS].sort());
  });
});
