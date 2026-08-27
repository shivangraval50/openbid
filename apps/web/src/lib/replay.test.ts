import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  closeAuction,
  initialState,
  reduce,
  validateBid,
  type AuctionConfig,
  type AuctionEvent,
} from "@openbid/auction-core";

const sql = vi.fn();
const neon = vi.fn(() => sql);

vi.mock("@neondatabase/serverless", () => ({ neon }));

const { replayTo, fetchArchivedAuction } = await import("./replay");

const config: AuctionConfig = {
  itemName: "replay",
  startingPrice: 100,
  minIncrement: 10,
  startingBudget: 5_000,
  antiSnipeWindowMs: 10_000,
  antiSnipeExtensionMs: 15_000,
  endsAtMs: 1_000_000,
};

/** Play a scripted auction and capture the log the DO would have archived. */
function recordAuction(): {
  log: AuctionEvent[];
  finalWinner: { participantId: string; amount: number } | null;
} {
  let state = initialState(config);
  const log: AuctionEvent[] = [];

  for (const id of ["ada", "grace"]) {
    const event: AuctionEvent = { type: "joined", participantId: id, nickname: id, atMs: 0 };
    log.push(event);
    state = reduce(state, event);
  }

  for (const [bidder, amount, atMs] of [
    ["ada", 100, 10],
    ["grace", 150, 20],
    ["ada", 400, 30],
  ] as const) {
    const decision = validateBid(state, { participantId: bidder, amount, atMs });
    if (!decision.ok) throw new Error(`scripted bid unexpectedly rejected: ${decision.reason}`);
    log.push(decision.event);
    state = reduce(state, decision.event);
  }

  const close = closeAuction(state, config.endsAtMs);
  if (close === null) throw new Error("expected a close event");
  log.push(close);
  state = reduce(state, close);

  return { log, finalWinner: state.winner };
}

describe("replayTo", () => {
  // The determinism test. `finalWinner` comes from `state` as built by
  // recordAuction's OWN fold loop above -- the real decide-then-apply
  // path (`validateBid` decides, `reduce` applies, `closeAuction` decides
  // the close) -- not from calling `replayTo` a second time. `replayTo`
  // is then called completely independently, starting from a fresh
  // `initialState` and folding only the archived log, never calling
  // `validateBid`. A `replayTo` that folded the wrong slice of events, or
  // started from the wrong initial state, would diverge from that
  // independently-produced settlement and fail here.
  //
  // Asserts the WHOLE winner object, not just `.amount`: comparing only
  // the amount would pass even if replay attached the right price to the
  // wrong participant (e.g. a reduce/replay bug that mixed up bidders),
  // since two different bids in this script never land on the same
  // amount by coincidence but could plausibly share a winning figure in
  // general. `participantId` is part of "the recorded settlement" too.
  it("reproduces the recorded settlement from the archived log", () => {
    const { log, finalWinner } = recordAuction();
    const replayed = replayTo(config, log, log.length);
    expect(replayed.winner).toEqual(finalWinner);
    expect(replayed.status).toBe("closed");
  });

  // Pins that `replayTo` folds only the first `upTo` events, not the
  // whole log regardless of the argument. A version that ignored `upTo`
  // (folding everything) would report `status: "closed"` here instead of
  // "open", and a version that folded too few events (e.g. `upTo - 1`,
  // stopping before the first bid) would report `highBid` as `null`.
  it("reproduces intermediate state at any scrub position", () => {
    const { log } = recordAuction();
    // Two joins, then the first bid of 100.
    const afterFirstBid = replayTo(config, log, 3);
    expect(afterFirstBid.highBid?.amount).toBe(100);
    expect(afterFirstBid.status).toBe("open");
  });

  // Pins the position-zero clamp: folding zero events must be
  // byte-for-byte the same object shape as `initialState`, not "close
  // enough". A version that applied even the first event unconditionally
  // (off-by-one on the lower bound) would fail this.
  it("returns the initial state at position zero", () => {
    const { log } = recordAuction();
    expect(replayTo(config, log, 0)).toEqual(initialState(config));
  });

  // `replayTo` must be a pure fold with no I/O and no clock reads, so two
  // calls with identical arguments must be identical. A version that
  // read `Date.now()` into the result, or mutated and returned a shared
  // accumulator across calls, would fail this even though each call
  // individually "looks" correct.
  it("is idempotent — replaying twice yields identical state", () => {
    const { log } = recordAuction();
    expect(replayTo(config, log, log.length)).toEqual(replayTo(config, log, log.length));
  });

  // Pins the upper clamp: a scrub position past the end of the log must
  // behave exactly like the end, not throw and not silently read past the
  // array (e.g. via `events[i]` returning `undefined` for out-of-range
  // indices in a hand-rolled loop instead of `Array.prototype.slice`'s
  // safe clamping).
  it("clamps a scrub position past the end of the log", () => {
    const { log } = recordAuction();
    expect(replayTo(config, log, log.length + 50)).toEqual(replayTo(config, log, log.length));
  });
});

describe("fetchArchivedAuction", () => {
  const originalUrl = process.env.DATABASE_URL;
  const validRow = {
    itemName: "replay",
    startingPrice: 100,
    winningPrice: 400,
    winnerNickname: "ada",
    bidLog: [
      { type: "joined", participantId: "ada", nickname: "ada", atMs: 0 },
      { type: "bidPlaced", participantId: "ada", amount: 100, atMs: 10, newEndsAtMs: 20_000 },
      { type: "closed", atMs: 30, winner: { participantId: "ada", amount: 100 } },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    neon.mockImplementation(() => sql);
  });

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  });

  // DATABASE_URL is deliberately unset in tests (and may be unset in a
  // deployment); the replay page treats a missing archive the same as a
  // 404 (`notFound()`), never a 500.
  it("returns null when DATABASE_URL is not configured", async () => {
    delete process.env.DATABASE_URL;

    await expect(fetchArchivedAuction("room-1")).resolves.toBeNull();
    expect(neon).not.toHaveBeenCalled();
  });

  it("returns null when the query rejects, rather than throwing", async () => {
    process.env.DATABASE_URL = "postgres://example/db";
    sql.mockRejectedValue(new Error("connection refused"));

    await expect(fetchArchivedAuction("room-1")).resolves.toBeNull();
  });

  it("returns null when no row matches the room id", async () => {
    process.env.DATABASE_URL = "postgres://example/db";
    sql.mockResolvedValue([]);

    await expect(fetchArchivedAuction("room-1")).resolves.toBeNull();
  });

  it("returns the archived auction when the row is well-formed", async () => {
    process.env.DATABASE_URL = "postgres://example/db";
    sql.mockResolvedValue([validRow]);

    await expect(fetchArchivedAuction("room-1")).resolves.toEqual(validRow);
  });

  // The Critical from review: `starting_price`/`winning_price` are
  // NUMERIC columns (schema.sql), and Neon's serverless driver returns
  // NUMERIC/DECIMAL as JS strings by default -- so a genuine row looks
  // like THIS, not like `validRow` above (whose number literals only
  // happen to look right because they're hand-written). Every prior test
  // in this file mocked `sql` with JS number literals, so all 32 tests
  // from the first pass could go green while every real replay 404'd.
  // This is the test that actually simulates the driver's real
  // coercion, and it must resolve to the *numeric* archived auction, not
  // null and not the raw strings.
  it("accepts and numerically coerces starting/winning price when Neon returns them as strings", async () => {
    process.env.DATABASE_URL = "postgres://example/db";
    sql.mockResolvedValue([{ ...validRow, startingPrice: "100", winningPrice: "400" }]);

    const result = await fetchArchivedAuction("room-1");

    expect(result).toEqual(validRow);
    expect(result?.startingPrice).toBe(100);
    expect(typeof result?.startingPrice).toBe("number");
    expect(result?.winningPrice).toBe(400);
    expect(typeof result?.winningPrice).toBe("number");
  });

  // Same shape, the "never sold" case: a null winning_price must survive
  // alongside a string-valued starting_price.
  it("accepts a null winningPrice alongside a string-valued startingPrice", async () => {
    process.env.DATABASE_URL = "postgres://example/db";
    sql.mockResolvedValue([
      { ...validRow, startingPrice: "100", winningPrice: null, winnerNickname: null },
    ]);

    const result = await fetchArchivedAuction("room-1");

    expect(result?.startingPrice).toBe(100);
    expect(result?.winningPrice).toBeNull();
  });

  // The requirement beyond the brief: the one input capable of making
  // the determinism test lie is the archived bid log itself. A row whose
  // `bidLog` is not even an array must be rejected before it ever
  // reaches `replayTo`/`reduce`, and rejected the same way "not found"
  // is -- `null` -- not by throwing out of a page render. A version that
  // cast the row straight to `ArchivedAuction` (the brief's literal
  // code) would resolve this to the malformed value instead of `null`.
  it("returns null when the archived row's bidLog is not an array", async () => {
    process.env.DATABASE_URL = "postgres://example/db";
    sql.mockResolvedValue([{ ...validRow, bidLog: "not-an-array" }]);

    await expect(fetchArchivedAuction("room-1")).resolves.toBeNull();
  });

  // Same requirement, the case a shallow `Array.isArray(bidLog)` check
  // would miss: the log IS an array, but one entry has a `type` `reduce`
  // does not recognise (its switch has no default case). This is
  // precisely the scenario the task brief calls out: replaying an
  // unvalidated malformed log would fold garbage through `reduce` and a
  // comparison against it would pass without proving anything.
  it("returns null when the archived row's bidLog contains an entry with an unrecognised type", async () => {
    process.env.DATABASE_URL = "postgres://example/db";
    sql.mockResolvedValue([
      { ...validRow, bidLog: [...validRow.bidLog, { type: "bidRetracted", atMs: 40 }] },
    ]);

    await expect(fetchArchivedAuction("room-1")).resolves.toBeNull();
  });

  // Same requirement, a numeric-field variant: an entry that has a
  // recognised `type` but a stringified amount (e.g. a jsonb round-trip
  // quirk) must also be rejected, not silently coerced or passed through
  // to poison `reduce`'s `highBid.amount` comparisons.
  it("returns null when a bidPlaced entry's amount is not a number", async () => {
    process.env.DATABASE_URL = "postgres://example/db";
    const malformedBid = { type: "bidPlaced", participantId: "ada", amount: "100", atMs: 10, newEndsAtMs: 20_000 };
    sql.mockResolvedValue([{ ...validRow, bidLog: [malformedBid] }]);

    await expect(fetchArchivedAuction("room-1")).resolves.toBeNull();
  });

  it("returns null when constructing the client throws synchronously", async () => {
    process.env.DATABASE_URL = "not-a-valid-url";
    neon.mockImplementation(() => {
      throw new Error("invalid connection string");
    });

    await expect(fetchArchivedAuction("room-1")).resolves.toBeNull();
  });
});
