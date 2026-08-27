import { describe, it, expect, vi } from "vitest";
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

describe("seedFromSnapshot", () => {
  // Catches: an implementation that reuses the `snapshot` case verbatim and
  // sets `youAre` from some default/derived value instead of leaving it
  // `null` -- the HTTP `/snapshot` envelope carries no participant
  // identity, so a non-null result here would be fabricated.
  it("adopts server state and seq, but leaves youAre null", () => {
    const store = createAuctionStore();
    store.getState().seedFromSnapshot(4, 1_000, seededState());

    expect(store.getState().server?.config.itemName).toBe("store");
    expect(store.getState().lastSeenSeq).toBe(4);
    expect(store.getState().youAre).toBeNull();
  });

  // Catches: an implementation that leaves stale pending bids in place
  // (e.g. only sets `server`/`lastSeenSeq` and forgets to clear `pending`),
  // which would show a phantom optimistic price on first paint.
  it("clears any pending bids, since seeded server state is authoritative", () => {
    const store = createAuctionStore();
    store.getState().seedFromSnapshot(4, 1_000, seededState());
    store.getState().placeOptimisticBid(200);
    expect(selectPendingCount(store.getState())).toBe(1);

    store.getState().seedFromSnapshot(9, 2_000, seededState());
    expect(selectPendingCount(store.getState())).toBe(0);
  });

  // Catches: a `youAre` that gets stuck at null forever, or a real snapshot
  // handler that is somehow gated on having been seeded first. Identity
  // must become known the moment the socket's own snapshot arrives, on top
  // of an SSR-seeded store.
  it("a later real snapshot sets youAre once the socket's own snapshot arrives", () => {
    const store = createAuctionStore();
    store.getState().seedFromSnapshot(4, 1_000, seededState());
    expect(store.getState().youAre).toBeNull();

    store.getState().applyServerMessage({
      t: "snapshot",
      seq: 4,
      serverTime: 1_000,
      state: seededState(),
      youAre: "me",
    });
    expect(store.getState().youAre).toBe("me");
  });

  // Catches: an implementation with no monotonicity guard at all. A
  // reachable regression path is an SSR re-seed (e.g. a `router.refresh()`
  // whose refetch was issued before the socket had applied deltas up to
  // seq 50, returning a stale seq 40): without this guard, `server`
  // silently regresses and `lastSeenSeq` drops to 40, and 41-50 are never
  // redelivered since the DO only replays on a fresh `hello`. Also asserts
  // that a blocked call leaves `pending` untouched -- a guard that skips
  // only the `lastSeenSeq`/`server` assignment but still wipes `pending`
  // would silently drop an in-flight optimistic bid with no ack, reject,
  // or feedback, which is just as bad as the seq regression itself.
  it("ignores a seed at or below lastSeenSeq once server state already exists", () => {
    const store = createAuctionStore();
    store.getState().seedFromSnapshot(50, 5_000, seededState());
    const clientSeq = store.getState().placeOptimisticBid(250);
    const serverBefore = store.getState().server;

    store.getState().seedFromSnapshot(40, 4_000, seededState());

    expect(store.getState().lastSeenSeq).toBe(50);
    expect(store.getState().server).toBe(serverBefore);
    expect(store.getState().pending.map((p) => p.clientSeq)).toEqual([clientSeq]);
  });

  // The very first seed must never be blocked by the guard above, even
  // when called with seq 0 against a brand-new store (whose lastSeenSeq
  // also starts at 0) -- the guard's job is to reject *regressions once
  // there is real server state*, not to require a positive seq.
  it("still applies the very first seed even at seq 0", () => {
    const store = createAuctionStore();
    store.getState().seedFromSnapshot(0, 1_000, seededState());
    expect(store.getState().server?.config.itemName).toBe("store");
    expect(store.getState().lastSeenSeq).toBe(0);
  });

  // Catches: reintroducing the old "provisional offset" behaviour (deriving
  // `clockOffsetMs` from `serverTime - Date.now()` at seed time). That
  // computation read the local clock at a different real moment on the
  // server (SSR) than on the client (hydration) -- the difference is
  // exactly the SSR-to-hydration latency, not clock skew, and it hydration
  // -mismatched `Latency` whenever that latency crossed its threshold (see
  // task-17-report.md). `clockOffsetMs` must stay `null` until a real
  // round trip (`observeClock`) measures one -- a pong cannot arrive before
  // mount, so SSR and the first client render now necessarily agree.
  it("leaves clockOffsetMs null -- does not derive a provisional offset from serverTime", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const store = createAuctionStore();
    // The server reports a time 5s ahead of this (fake) local clock; that
    // gap must NOT show up as clockOffsetMs.
    store.getState().seedFromSnapshot(4, 1_005_000, seededState());
    expect(store.getState().clockOffsetMs).toBeNull();
    vi.useRealTimers();
  });

  // The other half of the fix: removing the provisional computation
  // entirely (rather than keeping it under a different name for numeric
  // use only) traded the fixed `Latency` mismatch for an equivalent one in
  // `Countdown`/`PriceChart`, confirmed by actually doing that and
  // rerunning the Playwright suite (see task-17-report.md). It must still
  // land, just under `provisionalOffsetMs`, and only that field, not the
  // real `clockOffsetMs`.
  it("still derives a provisional offset from serverTime, but as provisionalOffsetMs, not clockOffsetMs", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const store = createAuctionStore();
    store.getState().seedFromSnapshot(4, 1_005_000, seededState());
    expect(store.getState().provisionalOffsetMs).toBe(5_000);
    expect(store.getState().clockOffsetMs).toBeNull();
    vi.useRealTimers();
  });

  // Catches: a seed that clobbers an already-measured real offset back to
  // null (or to a fresh provisional guess) on a later re-seed (e.g. an SSR
  // re-fetch via `router.refresh()` after the socket's own pong already
  // corrected the clock). Once real, a measured offset must survive a
  // reseed untouched.
  it("does not clobber an already-measured clockOffsetMs on a later seed", () => {
    const store = createAuctionStore();
    store.getState().seedFromSnapshot(4, 1_000, seededState());
    store.getState().observeClock(1_000, 5_050, 1_100);
    const measured = store.getState().clockOffsetMs;
    expect(measured).not.toBeNull();

    store.getState().seedFromSnapshot(9, 2_000, seededState());
    expect(store.getState().clockOffsetMs).toBe(measured);
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

  it("clears the pending bid on ack, without advancing lastSeenSeq on its own", () => {
    const store = storeWithSnapshot();
    const clientSeq = store.getState().placeOptimisticBid(250);
    store.getState().applyServerMessage({ t: "ack", clientSeq, seq: 5 });
    expect(selectPendingCount(store.getState())).toBe(0);
    // Corrected invariant: `lastSeenSeq` means "the highest seq applied via
    // a delta." An ack's `seq` is informational only -- it must not move
    // this watermark, or a delta for that same seq (in-flight, reordered,
    // or lost to a swallowed per-socket send failure) would later be
    // dropped as a duplicate it was never actually applied. It stays at 4,
    // the seq from the snapshot this store started from.
    expect(store.getState().lastSeenSeq).toBe(4);
  });

  function ownBidEvent() {
    return {
      type: "bidPlaced" as const,
      participantId: "me",
      amount: 250,
      atMs: 1_100,
      newEndsAtMs: 1_000_000,
    };
  }

  it("absorbs its own winning bid when the delta arrives before its ack (the order RoomDO now uses)", () => {
    const store = storeWithSnapshot();
    const clientSeq = store.getState().placeOptimisticBid(250);

    // RoomDO now broadcasts the delta (reaching the bidder's own socket
    // too) before sending that bid's ack, specifically to close the
    // one-frame window where the optimistic price would otherwise have
    // been cleared before the authoritative one arrived.
    store.getState().applyServerMessage({
      t: "delta",
      seq: 5,
      serverTime: 1_100,
      event: ownBidEvent(),
    });
    store.getState().applyServerMessage({ t: "ack", clientSeq, seq: 5 });

    expect(store.getState().server?.highBid?.amount).toBe(250);
    expect(selectPendingCount(store.getState())).toBe(0);
    expect(selectDisplayPrice(store.getState())).toBe(250);
  });

  // This is the test that would have caught the original bug, and it must
  // use the *adversarial* order (ack before its matching delta) to do so:
  // with the delta-first order above, the delta is already reduced into
  // `server` by the time the ack arrives, so that test alone passes
  // whether or not the ack handler wrongly advances `lastSeenSeq` -- it
  // does not actually exercise the fix. This ordering is exactly what the
  // pre-fix RoomDO produced (ack sent, then the matching delta broadcast
  // back to the same socket), and is also the case Half 2 of the fix
  // (lastSeenSeq advances only from a delta) is meant to make harmless
  // regardless of which one lands first.
  it("absorbs its own winning bid even if its ack arrives before the matching delta", () => {
    const store = storeWithSnapshot();
    const clientSeq = store.getState().placeOptimisticBid(250);

    store.getState().applyServerMessage({ t: "ack", clientSeq, seq: 5 });
    store.getState().applyServerMessage({
      t: "delta",
      seq: 5,
      serverTime: 1_100,
      event: ownBidEvent(),
    });

    // The actual bug this test exists to catch: clearing the pending entry
    // on ack is not sufficient on its own. If the ack had advanced
    // lastSeenSeq to 5, this delta (also seq 5) would be dropped as a
    // duplicate and highBid would stay null forever on this client.
    expect(store.getState().server?.highBid?.amount).toBe(250);
    expect(selectPendingCount(store.getState())).toBe(0);
    expect(selectDisplayPrice(store.getState())).toBe(250);
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
    // observeClock always sets a real number; a null here would mean this
    // test's own premise (a measured offset exists) is broken, which is
    // worth failing loudly on rather than silently coercing to 0.
    expect(offset).not.toBeNull();
    const measuredOffset = offset as number;

    const before = Date.now();
    const serverNow = selectServerNow(store.getState());
    const after = Date.now();

    expect(serverNow).toBeGreaterThanOrEqual(before + measuredOffset);
    expect(serverNow).toBeLessThanOrEqual(after + measuredOffset);
  });

  // Catches: falling back to bare Date.now() (offset 0) whenever no real
  // measurement exists yet, ignoring provisionalOffsetMs entirely -- which
  // is exactly the regression that made Countdown/PriceChart start
  // hydration-mismatching once clockOffsetMs stopped being seeded (see the
  // AuctionStoreState.provisionalOffsetMs doc comment).
  it("falls back to the provisional offset before any real one has been measured", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const store = createAuctionStore();
    store.getState().seedFromSnapshot(4, 1_005_000, seededState());
    expect(store.getState().clockOffsetMs).toBeNull();

    const serverNow = selectServerNow(store.getState());
    expect(serverNow).toBe(1_005_000);
    vi.useRealTimers();
  });

  // Catches: continuing to use the provisional (seed-time) offset forever,
  // even after a real round trip has measured a more accurate one -- the
  // whole point of `observeClock` correcting the clock is that it takes
  // over from here.
  it("prefers the real measured offset over the provisional one once both exist", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const store = createAuctionStore();
    // Provisional offset would be +5_000 if used.
    store.getState().seedFromSnapshot(4, 1_005_000, seededState());
    // Real, measured offset: sent at 1_000_000, received at 1_000_100 (RTT
    // 100), server said 1_100_050 -> serverTimeAtReceipt = 1_100_100,
    // offset = 1_100_100 - 1_000_100 = 100_000.
    store.getState().observeClock(1_000_000, 1_100_050, 1_000_100);

    const serverNow = selectServerNow(store.getState());
    expect(serverNow).toBe(1_000_000 + 100_000);
    vi.useRealTimers();
  });
});
