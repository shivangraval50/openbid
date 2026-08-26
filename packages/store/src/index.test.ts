import { describe, it, expect } from "vitest";
import { initialState, type AuctionConfig, type AuctionState } from "@openbid/auction-core";
import {
  createAuctionStore,
  selectDisplayPrice,
  selectPendingCount,
  selectServerNow,
} from "./index.js";

const config: AuctionConfig = {
  itemName: "store",
  startingPrice: 100,
  minIncrement: 10,
  startingBudget: 500,
  antiSnipeWindowMs: 10_000,
  antiSnipeExtensionMs: 15_000,
  endsAtMs: 1_000_000,
};

function seededState(): AuctionState {
  return {
    ...initialState(config),
    participants: { me: { id: "me", nickname: "me", budget: 500 } },
  };
}

function storeWithSnapshot() {
  const store = createAuctionStore();
  store.getState().applyServerMessage({
    t: "snapshot",
    seq: 4,
    serverTime: 1_000,
    state: seededState(),
    youAre: "me",
  });
  return store;
}

describe("snapshot handling", () => {
  it("adopts server state and the sequence number", () => {
    const store = storeWithSnapshot();
    expect(store.getState().server?.config.itemName).toBe("store");
    expect(store.getState().lastSeenSeq).toBe(4);
    expect(store.getState().youAre).toBe("me");
  });

  it("discards pending bids on snapshot, since the server state is authoritative", () => {
    const store = storeWithSnapshot();
    store.getState().placeOptimisticBid(200);
    expect(selectPendingCount(store.getState())).toBe(1);

    store.getState().applyServerMessage({
      t: "snapshot",
      seq: 9,
      serverTime: 2_000,
      state: seededState(),
      youAre: "me",
    });
    expect(selectPendingCount(store.getState())).toBe(0);
  });
});

describe("optimistic bids", () => {
  it("shows the optimistic price immediately", () => {
    const store = storeWithSnapshot();
    store.getState().placeOptimisticBid(250);
    expect(selectDisplayPrice(store.getState())).toBe(250);
  });

  it("allocates strictly increasing clientSeq values", () => {
    const store = storeWithSnapshot();
    const a = store.getState().placeOptimisticBid(150);
    const b = store.getState().placeOptimisticBid(250);
    expect(b).toBeGreaterThan(a);
  });

  it("clears the pending bid on ack", () => {
    const store = storeWithSnapshot();
    const clientSeq = store.getState().placeOptimisticBid(250);
    store.getState().applyServerMessage({ t: "ack", clientSeq, seq: 5 });
    expect(selectPendingCount(store.getState())).toBe(0);
    expect(store.getState().lastSeenSeq).toBe(5);
  });

  it("rolls the price back on reject and records the reason", () => {
    const store = storeWithSnapshot();
    const clientSeq = store.getState().placeOptimisticBid(250);
    store.getState().applyServerMessage({ t: "reject", clientSeq, reason: "TOO_LOW" });

    expect(selectPendingCount(store.getState())).toBe(0);
    expect(selectDisplayPrice(store.getState())).toBe(100); // back to the starting price
    expect(store.getState().lastReject).toEqual({ clientSeq, reason: "TOO_LOW" });
  });

  it("rolls back only the rejected bid, leaving other pending bids intact", () => {
    const store = storeWithSnapshot();
    const first = store.getState().placeOptimisticBid(150);
    store.getState().placeOptimisticBid(400);
    store.getState().applyServerMessage({ t: "reject", clientSeq: first, reason: "TOO_LOW" });

    expect(selectPendingCount(store.getState())).toBe(1);
    expect(selectDisplayPrice(store.getState())).toBe(400);
  });

  // Strengthened beyond the brief: the original assertion was only
  // `not.toThrow()`, which passes just as happily against an implementation
  // that silently corrupts `pending` (e.g. clears every pending bid on any
  // ack, regardless of clientSeq) or clobbers `lastSeenSeq` (e.g. assigns
  // `msg.seq` outright instead of `max(current, msg.seq)`, letting a stray
  // ack move the watermark backwards). Using an ack `seq` (2) *below* the
  // current `lastSeenSeq` (4) means a naive unconditional assignment would
  // visibly regress it, and asserting every other field is untouched closes
  // off "cleared something else instead" as an escape hatch.
  it("ignores an ack for an unknown clientSeq without throwing, and leaves state genuinely unchanged", () => {
    const store = storeWithSnapshot();
    const real = store.getState().placeOptimisticBid(150);
    const before = store.getState();

    expect(() =>
      store.getState().applyServerMessage({ t: "ack", clientSeq: 999, seq: 2 })
    ).not.toThrow();

    const after = store.getState();
    expect(after.pending).toEqual(before.pending);
    expect(after.pending.map((p) => p.clientSeq)).toEqual([real]);
    expect(after.lastSeenSeq).toBe(before.lastSeenSeq);
    expect(after.lastSeenSeq).toBe(4); // not clobbered down to the stray ack's seq
    expect(after.lastReject).toBe(before.lastReject);
    expect(after.server).toBe(before.server);
  });
});

describe("delta handling", () => {
  it("applies a server delta and advances lastSeenSeq", () => {
    const store = storeWithSnapshot();
    store.getState().applyServerMessage({
      t: "delta",
      seq: 5,
      serverTime: 1_100,
      event: {
        type: "bidPlaced",
        participantId: "other",
        amount: 300,
        atMs: 1_100,
        newEndsAtMs: 1_000_000,
      },
    });
    expect(store.getState().server?.highBid?.amount).toBe(300);
    expect(store.getState().lastSeenSeq).toBe(5);
  });

  it("ignores a delta at or below lastSeenSeq (duplicate replay)", () => {
    const store = storeWithSnapshot();
    const duplicate = {
      t: "delta",
      seq: 4,
      serverTime: 1_100,
      event: {
        type: "bidPlaced",
        participantId: "other",
        amount: 300,
        atMs: 1_100,
        newEndsAtMs: 1_000_000,
      },
    } as const;
    store.getState().applyServerMessage(duplicate);
    expect(store.getState().server?.highBid).toBeNull();
  });

  it("prefers the server price once it exceeds a pending optimistic bid", () => {
    const store = storeWithSnapshot();
    store.getState().placeOptimisticBid(150);
    store.getState().applyServerMessage({
      t: "delta",
      seq: 5,
      serverTime: 1_100,
      event: {
        type: "bidPlaced",
        participantId: "other",
        amount: 900,
        atMs: 1_100,
        newEndsAtMs: 1_000_000,
      },
    });
    expect(selectDisplayPrice(store.getState())).toBe(900);
  });
});

describe("clock offset", () => {
  it("derives a server-time offset from a round trip", () => {
    const store = storeWithSnapshot();
    // Sent at 1000, received at 1100 (RTT 100), server said 5050.
    // Server time at receipt ≈ 5050 + 50, so offset ≈ 4000.
    store.getState().observeClock(1_000, 5_050, 1_100);
    expect(store.getState().clockOffsetMs).toBeCloseTo(4_000, 0);
  });

  // Strengthened beyond the brief: the original case's RTT (100) is even,
  // so "rtt / 2" happens to land on a whole number (50). An implementation
  // that truncates the half-RTT correction to an integer (e.g.
  // `Math.floor(rtt / 2)` or `rtt >> 1`, plausible if someone assumes
  // sub-ms precision never matters) would still pass that case by
  // coincidence. This one uses an odd, asymmetric RTT (333ms, true half =
  // 166.5) and a much larger server time, so a truncating implementation
  // is off by 0.5 against the correct fractional answer, and the tighter
  // `toBeCloseTo(_, 1)` tolerance (0.05) actually catches it.
  it("pins the offset formula with an asymmetric, larger round trip", () => {
    const store = storeWithSnapshot();
    // Sent at 10_000, received at 10_333 (RTT 333), server said 50_000.
    // Server time at receipt = 50_000 + 166.5 = 50_166.5, so
    // offset = 50_166.5 - 10_333 = 39_833.5.
    store.getState().observeClock(10_000, 50_000, 10_333);
    expect(store.getState().clockOffsetMs).toBeCloseTo(39_833.5, 1);
  });
});

describe("selectServerNow", () => {
  // Justified beyond the brief's explicit test list by the task's own
  // constraint: "Client code must never trust Date.now() for auction
  // timing -- the store derives a server-time offset ... and all
  // countdowns render against that offset." This pins that the exported
  // helper actually adds the offset to the local clock (catches: forgetting
  // to add the offset, adding it with the wrong sign, or ignoring it and
  // returning bare Date.now()).
  it("adds the observed clock offset to the local clock", () => {
    const store = createAuctionStore();
    store.getState().observeClock(1_000, 5_050, 1_100);
    const offset = store.getState().clockOffsetMs;

    const before = Date.now();
    const serverNow = selectServerNow(store.getState());
    const after = Date.now();

    expect(serverNow).toBeGreaterThanOrEqual(before + offset);
    expect(serverNow).toBeLessThanOrEqual(after + offset);
  });
});
