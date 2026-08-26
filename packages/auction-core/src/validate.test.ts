import { describe, it, expect } from "vitest";
import { initialState, minimumBid, validateBid, reduce } from "./index.js";
import type { AuctionConfig } from "./types.js";

const config: AuctionConfig = {
  itemName: "A rare compiler",
  startingPrice: 100,
  minIncrement: 10,
  startingBudget: 500,
  antiSnipeWindowMs: 10_000,
  antiSnipeExtensionMs: 15_000,
  endsAtMs: 1_000_000,
};

function joined(id: string, nickname = id) {
  return { type: "joined", participantId: id, nickname, atMs: 0 } as const;
}

function withParticipants(...ids: string[]) {
  return ids.reduce((s, id) => reduce(s, joined(id)), initialState(config));
}

describe("minimumBid", () => {
  it("is the starting price with no bids", () => {
    expect(minimumBid(initialState(config))).toBe(100);
  });

  it("is the high bid plus the increment once bidding starts", () => {
    let state = withParticipants("ada");
    const decision = validateBid(state, { participantId: "ada", amount: 100, atMs: 1 });
    if (!decision.ok) throw new Error("expected ok");
    state = reduce(state, decision.event);
    expect(minimumBid(state)).toBe(110);
  });
});

describe("validateBid", () => {
  it("accepts a bid at exactly the minimum", () => {
    const state = withParticipants("ada");
    const decision = validateBid(state, { participantId: "ada", amount: 100, atMs: 1 });
    expect(decision.ok).toBe(true);
  });

  it("rejects a bid below the minimum as TOO_LOW", () => {
    const state = withParticipants("ada");
    const decision = validateBid(state, { participantId: "ada", amount: 99, atMs: 1 });
    expect(decision).toEqual({ ok: false, reason: "TOO_LOW" });
  });

  it("rejects a bid exceeding the participant budget as INSUFFICIENT_BUDGET", () => {
    const state = withParticipants("ada");
    const decision = validateBid(state, { participantId: "ada", amount: 501, atMs: 1 });
    expect(decision).toEqual({ ok: false, reason: "INSUFFICIENT_BUDGET" });
  });

  it("checks TOO_LOW before INSUFFICIENT_BUDGET when both apply", () => {
    // startingBudget (50) is below startingPrice (100), so a bid of 75 is
    // simultaneously below the minimum and above the bidder's budget.
    const poorConfig: AuctionConfig = { ...config, startingBudget: 50 };
    const state = reduce(initialState(poorConfig), joined("ada"));
    const decision = validateBid(state, { participantId: "ada", amount: 75, atMs: 1 });
    expect(decision).toEqual({ ok: false, reason: "TOO_LOW" });
  });

  it("rejects any bid at or after the deadline as AUCTION_CLOSED", () => {
    const state = withParticipants("ada");
    const decision = validateBid(state, {
      participantId: "ada",
      amount: 100,
      atMs: config.endsAtMs,
    });
    expect(decision).toEqual({ ok: false, reason: "AUCTION_CLOSED" });
  });

  it("rejects bids from an unknown participant as AUCTION_CLOSED", () => {
    const decision = validateBid(initialState(config), {
      participantId: "ghost",
      amount: 100,
      atMs: 1,
    });
    expect(decision).toEqual({ ok: false, reason: "AUCTION_CLOSED" });
  });

  it("does not extend the clock for a bid outside the anti-snipe window", () => {
    const state = withParticipants("ada");
    const decision = validateBid(state, { participantId: "ada", amount: 100, atMs: 500_000 });
    if (!decision.ok) throw new Error("expected ok");
    expect(decision.event).toMatchObject({ newEndsAtMs: config.endsAtMs });
  });

  it("extends the clock for a bid inside the anti-snipe window", () => {
    const state = withParticipants("ada");
    const atMs = config.endsAtMs - 5_000;
    const decision = validateBid(state, { participantId: "ada", amount: 100, atMs });
    if (!decision.ok) throw new Error("expected ok");
    expect(decision.event).toMatchObject({ newEndsAtMs: atMs + config.antiSnipeExtensionMs });
  });
});
