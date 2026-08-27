import { describe, it, expect } from "vitest";
import { resolveBidPhase, type BidObservation } from "./bidPhase";

const idle: BidObservation = { pendingCount: 0, lastRejectSeq: null };

describe("resolveBidPhase", () => {
  it("is idle when nothing is pending and nothing was refused", () => {
    expect(resolveBidPhase(idle, idle)).toBe("idle");
  });

  it("is pending while a bid is locally queued", () => {
    expect(resolveBidPhase(idle, { pendingCount: 1, lastRejectSeq: null })).toBe("pending");
  });

  it("is confirmed when the last pending bid clears without a rejection", () => {
    expect(resolveBidPhase({ pendingCount: 1, lastRejectSeq: null }, idle)).toBe("confirmed");
  });

  it("stays pending when one of several queued bids clears", () => {
    expect(
      resolveBidPhase({ pendingCount: 2, lastRejectSeq: null }, { pendingCount: 1, lastRejectSeq: null })
    ).toBe("pending");
  });

  // The ordering this pins is the whole point of the function. A rejection
  // ALSO empties `pending` (the store filters the refused clientSeq out), so
  // an implementation that checked `pendingCount` before the rejection would
  // report a refused bid as "confirmed" -- reporting the exact opposite of
  // what happened, on the one transition a bidder most needs to be told
  // about correctly.
  it("reports a rejection, not a confirmation, when the refusal also cleared the queue", () => {
    expect(
      resolveBidPhase({ pendingCount: 1, lastRejectSeq: null }, { pendingCount: 0, lastRejectSeq: 7 })
    ).toBe("rejected");
  });

  // `lastReject` is sticky in the store: it is never cleared. So "there is a
  // rejection on record" is true forever after the first one, and an
  // implementation keying on truthiness rather than on a CHANGE of clientSeq
  // would pin the UI in the rejected state for the rest of the session --
  // including through every subsequent successful bid.
  it("does not re-report an unchanged rejection", () => {
    const settled: BidObservation = { pendingCount: 0, lastRejectSeq: 7 };
    expect(resolveBidPhase(settled, settled)).toBe("idle");
  });

  it("confirms a later successful bid even though an older rejection is still on record", () => {
    expect(
      resolveBidPhase({ pendingCount: 1, lastRejectSeq: 7 }, { pendingCount: 0, lastRejectSeq: 7 })
    ).toBe("confirmed");
  });

  it("reports a second, distinct rejection", () => {
    expect(
      resolveBidPhase({ pendingCount: 1, lastRejectSeq: 7 }, { pendingCount: 0, lastRejectSeq: 8 })
    ).toBe("rejected");
  });

  // A clientSeq of 0 is a real sequence number, and `0` is falsy. An
  // implementation using `next.lastRejectSeq &&` rather than an explicit
  // `!== null` check would silently swallow the very first rejection of a
  // session.
  it("treats clientSeq 0 as a real rejection", () => {
    expect(
      resolveBidPhase({ pendingCount: 1, lastRejectSeq: null }, { pendingCount: 0, lastRejectSeq: 0 })
    ).toBe("rejected");
  });
});
