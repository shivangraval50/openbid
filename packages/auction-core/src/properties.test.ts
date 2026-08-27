import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { initialState, minimumBid, reduce, validateBid, closeAuction } from "./index";
import type { AuctionConfig, AuctionState } from "./types";

// startingBudget lowered from the brief's 10_000 to 1_200 against the amount
// range [1, 2_000]: ~40% of generated amounts (1_200..2_000) exceed the
// budget, so INSUFFICIENT_BUDGET is genuinely reachable inside run().
const config: AuctionConfig = {
  itemName: "prop",
  startingPrice: 100,
  minIncrement: 10,
  startingBudget: 1_200,
  antiSnipeWindowMs: 10_000,
  antiSnipeExtensionMs: 15_000,
  endsAtMs: 1_000_000,
};

const bidderIds = ["ada", "grace", "alan"] as const;

function seeded(): AuctionState {
  return bidderIds.reduce(
    (s, id) =>
      reduce(s, { type: "joined", participantId: id, nickname: id, persistent: false, atMs: 0 }),
    initialState(config)
  );
}

// atMs widened from the brief's [1, 900_000] to [1, 999_999]: the anti-snipe
// window opens at endsAtMs - antiSnipeWindowMs = 990_000, so this range lets
// generated bids land both inside and outside the window. atMs values >=
// endsAtMs (1_000_000) are correctly rejected as AUCTION_CLOSED and are not
// needed to exercise the extension branch, so the range stops just below it.
const attemptArb = fc.record({
  participantId: fc.constantFrom(...bidderIds),
  amount: fc.integer({ min: 1, max: 2_000 }),
  atMs: fc.integer({ min: 1, max: 999_999 }),
});

/** Apply attempts in time order, keeping only those the rules accept. */
function run(attempts: readonly { participantId: string; amount: number; atMs: number }[]) {
  const ordered = [...attempts].sort((a, b) => a.atMs - b.atMs);
  const accepted: number[] = [];
  let state = seeded();
  for (const attempt of ordered) {
    const decision = validateBid(state, attempt);
    if (decision.ok) {
      accepted.push(attempt.amount);
      state = reduce(state, decision.event);
    }
  }
  return { state, accepted };
}

describe("auction invariants", () => {
  it("the high bid always equals the maximum accepted bid", () => {
    fc.assert(
      fc.property(fc.array(attemptArb, { maxLength: 40 }), (attempts) => {
        const { state, accepted } = run(attempts);
        if (accepted.length === 0) {
          expect(state.highBid).toBeNull();
        } else {
          expect(state.highBid?.amount).toBe(Math.max(...accepted));
        }
      })
    );
  });

  it("accepted bids are strictly increasing", () => {
    fc.assert(
      fc.property(fc.array(attemptArb, { maxLength: 40 }), (attempts) => {
        const { accepted } = run(attempts);
        for (let i = 1; i < accepted.length; i += 1) {
          expect(accepted[i]!).toBeGreaterThan(accepted[i - 1]!);
        }
      })
    );
  });

  it("no accepted bid ever exceeds the bidder budget", () => {
    fc.assert(
      fc.property(fc.array(attemptArb, { maxLength: 40 }), (attempts) => {
        const { state, accepted } = run(attempts);
        for (const amount of accepted) {
          expect(amount).toBeLessThanOrEqual(state.config.startingBudget);
        }
      })
    );
  });

  it("the deadline never moves earlier", () => {
    fc.assert(
      fc.property(fc.array(attemptArb, { maxLength: 40 }), (attempts) => {
        const { state } = run(attempts);
        expect(state.endsAtMs).toBeGreaterThanOrEqual(config.endsAtMs);
      })
    );
  });

  it("a bid inside the anti-snipe window always extends the deadline past that bid", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 9_999 }), (msRemaining) => {
        const state = seeded();
        const atMs = state.endsAtMs - msRemaining;
        const decision = validateBid(state, { participantId: "ada", amount: 100, atMs });
        if (!decision.ok) throw new Error("expected ok");
        const next = reduce(state, decision.event);
        expect(next.endsAtMs).toBeGreaterThan(atMs);
        expect(next.endsAtMs).toBeGreaterThan(state.endsAtMs);
      })
    );
  });

  it("a closed auction accepts no further bids", () => {
    fc.assert(
      fc.property(attemptArb, (attempt) => {
        let state = seeded();
        const close = closeAuction(state, 500_000);
        if (close === null) throw new Error("expected a close event");
        state = reduce(state, close);
        expect(validateBid(state, attempt)).toEqual({ ok: false, reason: "AUCTION_CLOSED" });
      })
    );
  });

  it("the winner is the final high bidder", () => {
    fc.assert(
      fc.property(fc.array(attemptArb, { maxLength: 40 }), (attempts) => {
        const { state } = run(attempts);
        const close = closeAuction(state, state.endsAtMs);
        if (close === null || close.type !== "closed") throw new Error("expected a close event");
        expect(close.winner?.amount ?? null).toBe(state.highBid?.amount ?? null);
      })
    );
  });

  it("minimumBid is always strictly above the current high bid", () => {
    fc.assert(
      fc.property(fc.array(attemptArb, { maxLength: 40 }), (attempts) => {
        const { state } = run(attempts);
        if (state.highBid !== null) {
          expect(minimumBid(state)).toBeGreaterThan(state.highBid.amount);
        }
      })
    );
  });
});
