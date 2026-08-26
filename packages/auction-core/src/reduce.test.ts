import { describe, it, expect } from "vitest";
import { initialState, reduce } from "./index";
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

describe("reduce", () => {
  it("adds a participant with the starting budget on joined", () => {
    const state = reduce(initialState(config), {
      type: "joined",
      participantId: "ada",
      nickname: "ada",
      atMs: 0,
    });
    expect(state.participants["ada"]).toEqual({ id: "ada", nickname: "ada", budget: 500 });
  });

  it("is idempotent for a repeated joined event", () => {
    const join = {
      type: "joined",
      participantId: "ada",
      nickname: "ada",
      atMs: 0,
    } as const;
    const once = reduce(initialState(config), join);
    const twice = reduce(once, join);
    expect(twice).toEqual(once);
  });

  it("records the high bid and the new deadline on bidPlaced", () => {
    let state = reduce(initialState(config), {
      type: "joined",
      participantId: "ada",
      nickname: "ada",
      atMs: 0,
    });
    state = reduce(state, {
      type: "bidPlaced",
      participantId: "ada",
      amount: 150,
      atMs: 10,
      newEndsAtMs: 1_000_000,
    });
    expect(state.highBid).toEqual({ participantId: "ada", amount: 150, atMs: 10 });
    expect(state.endsAtMs).toBe(1_000_000);
  });

  it("does not mutate the input state", () => {
    const before = initialState(config);
    const frozen = JSON.stringify(before);
    reduce(before, { type: "joined", participantId: "ada", nickname: "ada", atMs: 0 });
    expect(JSON.stringify(before)).toBe(frozen);
  });

  it("marks the auction closed and records the winner", () => {
    let state = reduce(initialState(config), {
      type: "joined",
      participantId: "ada",
      nickname: "ada",
      atMs: 0,
    });
    state = reduce(state, {
      type: "bidPlaced",
      participantId: "ada",
      amount: 150,
      atMs: 10,
      newEndsAtMs: 1_000_000,
    });
    state = reduce(state, {
      type: "closed",
      atMs: 1_000_000,
      winner: { participantId: "ada", amount: 150 },
    });
    expect(state.status).toBe("closed");
    expect(state.winner).toEqual({ participantId: "ada", amount: 150 });
  });
});
