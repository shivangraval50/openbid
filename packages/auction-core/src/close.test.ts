import { describe, it, expect } from "vitest";
import { closeAuction, initialState, reduce, validateBid } from "./index";
import type { AuctionConfig } from "./types";

const config: AuctionConfig = {
  itemName: "A rare compiler",
  startingPrice: 100,
  minIncrement: 10,
  startingBudget: 500,
  antiSnipeWindowMs: 10_000,
  antiSnipeExtensionMs: 15_000,
  endsAtMs: 1_000_000,
};

describe("closeAuction", () => {
  it("closes with no winner when nobody bid", () => {
    const event = closeAuction(initialState(config), 1_000_000);
    expect(event).toEqual({ type: "closed", atMs: 1_000_000, winner: null });
  });

  it("closes with the high bidder as winner", () => {
    let state = reduce(initialState(config), {
      type: "joined",
      participantId: "ada",
      nickname: "ada",
      atMs: 0,
    });
    const decision = validateBid(state, { participantId: "ada", amount: 250, atMs: 5 });
    if (!decision.ok) throw new Error("expected ok");
    state = reduce(state, decision.event);

    expect(closeAuction(state, 1_000_000)).toEqual({
      type: "closed",
      atMs: 1_000_000,
      winner: { participantId: "ada", amount: 250 },
    });
  });

  it("returns null for an already-closed auction", () => {
    let state = initialState(config);
    state = reduce(state, { type: "closed", atMs: 1_000_000, winner: null });
    expect(closeAuction(state, 1_000_001)).toBeNull();
  });
});
