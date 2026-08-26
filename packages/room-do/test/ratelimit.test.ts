import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import { encode, parseServerMessage } from "@openbid/protocol";
import type { AuctionConfig } from "@openbid/auction-core";
import { CAPACITY } from "../src/ratelimit.js";

/**
 * `isolatedStorage: false` means every test file in this package shares the
 * same underlying storage (see vitest.config.ts and test/room.test.ts for
 * the full explanation). This is a separate copy of room.test.ts's helper,
 * not an import of it — importing a sibling *.test.ts file causes vitest to
 * re-execute its top-level `describe` calls as a side effect of evaluating
 * the module, silently duplicating that whole file's test run inside this
 * one. Every id here still gets its own crypto.randomUUID() suffix, so
 * uniqueness across files holds without sharing the module.
 */
function roomId(label: string): string {
  return `${label}-${crypto.randomUUID()}`;
}

// The task's constraint is a literal "10 bids per 10 seconds", not "however
// many CAPACITY happens to be" — so the boundary below is hardcoded to 10,
// not derived from the `CAPACITY` import. Deriving the loop count and the
// expected ack count from the same constant the production code exports
// would make the test pass unchanged if CAPACITY were quietly edited to 9
// or 11 (the whole test would just shift with it), which is exactly the
// off-by-one the task asks this test to be able to catch. This sanity
// check is what stands in for that: it fails loudly, separately from the
// boundary assertions below, if CAPACITY and the hardcoded 10 ever drift
// apart, rather than silently reinterpreting the boundary.
if (CAPACITY !== 10) {
  throw new Error(`expected CAPACITY to be 10, got ${CAPACITY}; update the hardcoded boundary below`);
}
const EXPECTED_CAPACITY = 10;

// startingPrice=100, minIncrement=10: bid i (1-indexed) needs amount >=
// 100 + (i-1)*10, which is exactly what `bidAmounts` below produces, so
// each of the first EXPECTED_CAPACITY bids clears `minimumBid` by
// construction — none of them is a coincidental pass. startingBudget is
// set comfortably above the highest of those amounts so
// INSUFFICIENT_BUDGET never fires either; validateBid never deducts from
// budget on a successful bid (see reduce.ts), so a single generous
// ceiling covers every bid in the burst. antiSnipeWindowMs is tiny and
// endsAtMs an hour out, so AUCTION_CLOSED never fires. That leaves rate
// limiting as the only thing that can reject any of these bids.
const config: AuctionConfig = {
  itemName: "flood",
  startingPrice: 100,
  minIncrement: 10,
  startingBudget: 1_000_000,
  antiSnipeWindowMs: 1_000,
  antiSnipeExtensionMs: 1_000,
  endsAtMs: Date.now() + 3_600_000,
};

/** Bid `i` (0-indexed) is exactly `minimumBid` at that point: startingPrice
 * for the first bid, then the previous bid's amount plus minIncrement. */
function bidAmounts(count: number): number[] {
  return Array.from({ length: count }, (_, i) => config.startingPrice + i * config.minIncrement);
}

async function initRoom(id: string) {
  const res = await SELF.fetch(`https://x/rooms/${id}/init`, {
    method: "POST",
    body: JSON.stringify(config),
  });
  expect(res.status).toBe(201);
}

async function openSocket(id: string, nickname: string) {
  const res = await SELF.fetch(`https://x/rooms/${id}/ws`, {
    headers: { Upgrade: "websocket" },
  });
  const ws = res.webSocket!;
  ws.accept();
  const inbox: ReturnType<typeof parseServerMessage>[] = [];
  ws.addEventListener("message", (e) => {
    inbox.push(parseServerMessage(String(e.data)));
  });
  ws.send(encode({ t: "hello", lastSeenSeq: 0, nickname }));
  return { ws, inbox };
}

async function waitFor<T extends { t: string }>(
  inbox: T[],
  predicate: (m: T) => boolean,
  label: string
): Promise<T> {
  for (let i = 0; i < 200; i += 1) {
    const found = inbox.find(predicate);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${label}; saw: ${inbox.map((m) => m.t).join(",")}`);
}

/** Wait until the inbox has stopped growing for a little while, so we can
 * assert about "nothing else arrived" without a fixed, possibly-too-short
 * sleep. */
async function waitForQuiet<T>(inbox: T[], quietMs = 150): Promise<void> {
  let lastLength = -1;
  let stableSince = Date.now();
  while (Date.now() - stableSince < quietMs) {
    if (inbox.length !== lastLength) {
      lastLength = inbox.length;
      stableSince = Date.now();
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("rate limiting", () => {
  it("accepts exactly the first 10 bids and rejects the 11th with RATE_LIMITED", async () => {
    const id = roomId("flood");
    await initRoom(id);
    const { ws, inbox } = await openSocket(id, "ada");
    await waitFor(inbox, (m) => m.t === "snapshot", "snapshot");

    const amounts = bidAmounts(EXPECTED_CAPACITY);
    for (let i = 0; i < EXPECTED_CAPACITY; i += 1) {
      ws.send(encode({ t: "bid", clientSeq: i + 1, amount: amounts[i]! }));
    }
    // The 11th bid: still well-formed (its amount clears the by-then
    // current minimumBid), so if this gets through it is rate limiting
    // that failed, not the auction rules doing us a favour.
    const overflowClientSeq = EXPECTED_CAPACITY + 1;
    ws.send(
      encode({
        t: "bid",
        clientSeq: overflowClientSeq,
        amount: config.startingPrice + EXPECTED_CAPACITY * config.minIncrement,
      })
    );

    await waitFor(
      inbox,
      (m) => m.t === "ack" && (m as { clientSeq: number }).clientSeq === EXPECTED_CAPACITY,
      "ack of the 10th bid"
    );
    const overflow = await waitFor(
      inbox,
      (m) =>
        (m.t === "ack" || m.t === "reject") &&
        (m as { clientSeq: number }).clientSeq === overflowClientSeq,
      "resolution of the overflow bid"
    );
    await waitForQuiet(inbox);

    // Every one of the first 10 bids must have been accepted — a limiter
    // with capacity 9 would reject the 10th of these (which is exactly
    // `minimumBid` and well within budget) with RATE_LIMITED, not TOO_LOW
    // or INSUFFICIENT_BUDGET, so this line distinguishes "rejected for the
    // wrong reason" from "rejected because the cap is off by one." Because
    // the loop bound and this expectation are both the hardcoded literal
    // 10 (not `CAPACITY`), a capacity-9 limiter fails right here: only 9
    // clientSeqs would have acked.
    const acks = inbox
      .filter((m) => m.t === "ack")
      .map((m) => (m as { clientSeq: number }).clientSeq);
    expect(acks).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const rejects = inbox.filter((m) => m.t === "reject");
    expect(rejects).toHaveLength(1);

    // And the 11th bid must be the one rejected, specifically with
    // RATE_LIMITED. A limiter with capacity 11 would ack this one too
    // (acks would then be length 11, already caught above by the strict
    // [1..10] equality), and a limiter that rejected for a different
    // reason would fail this exact assertion even though `rejects` has
    // length 1.
    expect(overflow).toMatchObject({
      t: "reject",
      clientSeq: overflowClientSeq,
      reason: "RATE_LIMITED",
    });
  });

  it("does not refill the bucket when a client re-sends hello on the same socket", async () => {
    const id = roomId("rehello-flood");
    await initRoom(id);
    const { ws, inbox } = await openSocket(id, "ada");
    await waitFor(inbox, (m) => m.t === "snapshot", "first snapshot");

    // Exhaust the bucket completely.
    const amounts = bidAmounts(EXPECTED_CAPACITY);
    for (let i = 0; i < EXPECTED_CAPACITY; i += 1) {
      ws.send(encode({ t: "bid", clientSeq: i + 1, amount: amounts[i]! }));
    }
    await waitFor(
      inbox,
      (m) => m.t === "ack" && (m as { clientSeq: number }).clientSeq === EXPECTED_CAPACITY,
      "ack of the 10th bid"
    );

    // The bypass under test: re-sending hello on the same socket must not
    // hand the bucket a fresh set of tokens. If it did, the bid right
    // after this would be accepted instead of rate limited.
    ws.send(encode({ t: "hello", lastSeenSeq: 0, nickname: "ada-again" }));
    await waitFor(
      inbox,
      () => inbox.filter((m) => m.t === "snapshot").length >= 2,
      "second snapshot"
    );

    const nextClientSeq = EXPECTED_CAPACITY + 1;
    ws.send(
      encode({
        t: "bid",
        clientSeq: nextClientSeq,
        amount: config.startingPrice + EXPECTED_CAPACITY * config.minIncrement,
      })
    );

    const reject = await waitFor(
      inbox,
      (m) =>
        (m.t === "ack" || m.t === "reject") &&
        (m as { clientSeq: number }).clientSeq === nextClientSeq,
      "resolution of the post-rehello bid"
    );
    expect(reject).toMatchObject({
      t: "reject",
      clientSeq: nextClientSeq,
      reason: "RATE_LIMITED",
    });
  });
});
