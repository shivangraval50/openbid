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
// many CAPACITY happens to be" — so the bypass test below (which needs an
// exact count to exhaust the bucket) hardcodes 10, not derived from the
// `CAPACITY` import. Deriving that count from the same constant the
// production code exports would make the test pass unchanged if CAPACITY
// were quietly edited to 9 or 11. This sanity check fails loudly, separately
// from that test's own assertions, if CAPACITY and the hardcoded 10 ever
// drift apart, rather than silently reinterpreting the exhaustion count.
if (CAPACITY !== 10) {
  throw new Error(`expected CAPACITY to be 10, got ${CAPACITY}; update the hardcoded count below`);
}
const EXPECTED_CAPACITY = 10;

// startingPrice=100, minIncrement=10: bid i (1-indexed) needs amount >=
// 100 + (i-1)*10, which is exactly what `bidAmounts` below produces, so
// every bid it generates clears `minimumBid` by construction — none of
// them is a coincidental pass, regardless of how many of the earlier ones
// actually landed (a rejected bid never advances `highBid`, so the
// required minimum can only be *lower* than what a fully-successful run
// would demand — these amounts stay valid either way). startingBudget is
// set comfortably above the highest amount either test ever sends, so
// INSUFFICIENT_BUDGET never fires either; validateBid never deducts from
// budget on a successful bid (see reduce.ts), so a single generous
// ceiling covers the whole burst. antiSnipeWindowMs is tiny and endsAtMs
// an hour out, so AUCTION_CLOSED never fires. That leaves rate limiting as
// the only thing that can reject any bid either test sends.
const config: AuctionConfig = {
  itemName: "flood",
  startingPrice: 100,
  minIncrement: 10,
  startingBudget: 1_000_000,
  antiSnipeWindowMs: 1_000,
  antiSnipeExtensionMs: 1_000,
  endsAtMs: Date.now() + 3_600_000,
};

/** Bid `i` (0-indexed) is exactly `minimumBid` at the point where every
 * earlier bid in the burst has succeeded: startingPrice for the first
 * bid, then the previous bid's amount plus minIncrement. See the comment
 * on `config` above for why this stays valid even when earlier bids in
 * the burst get rate limited instead of accepted. */
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

async function openSocket(id: string, nickname: string, persistent = false) {
  const res = await SELF.fetch(`https://x/rooms/${id}/ws`, {
    headers: { Upgrade: "websocket" },
  });
  const ws = res.webSocket!;
  ws.accept();
  const inbox: ReturnType<typeof parseServerMessage>[] = [];
  ws.addEventListener("message", (e) => {
    inbox.push(parseServerMessage(String(e.data)));
  });
  ws.send(encode({ t: "hello", lastSeenSeq: 0, nickname, persistent }));
  return { ws, inbox };
}

async function waitFor<T extends { t: string }>(
  inbox: T[],
  predicate: (m: T) => boolean,
  label: string,
  attempts = 200
): Promise<T> {
  for (let i = 0; i < attempts; i += 1) {
    const found = inbox.find(predicate);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${label}; saw: ${inbox.map((m) => m.t).join(",")}`);
}

describe("rate limiting", () => {
  // NOTE ON TIMING: the bucket refills 1 token per 1000ms (10 per 10s), so
  // any assertion whose correctness depends on *less* than some amount of
  // wall-clock time passing is a potential CI flake — the DO's own
  // sequential message processing (Zod parse, takeToken, a synchronous
  // SQLite INSERT + SELECT MAX, a send, a broadcast) is not free, and nothing
  // here controls or mocks that clock. The exact boundary (capacity allowed,
  // the next one denied; proportional and full refill; never exceeding
  // capacity) is covered without any wall-clock risk at all in
  // `../src/ratelimit.test.ts`, where the bucket's pure functions take a
  // timestamp as a parameter instead of reading a clock. The two tests below
  // are deliberately *not* trying to re-prove that exact boundary against
  // real time; they only prove that the limiter is wired into the bid path
  // at all, and that a repeat `hello` doesn't refresh it — with margins wide
  // enough that only many seconds of drift could produce a false failure.
  it("rejects at least one bid in a burst well past capacity, while still accepting the first", async () => {
    const id = roomId("flood");
    await initRoom(id);
    const { ws, inbox } = await openSocket(id, "ada");
    await waitFor(inbox, (m) => m.t === "snapshot", "snapshot");

    // 3x capacity: to make this burst pass with no RATE_LIMITED reject at
    // all, the bucket would need to have refilled roughly 2x its own
    // capacity's worth of tokens *during* this test — about 20 seconds of
    // drift at 1 token/second. That is the margin being traded for the
    // exactness the unit tests already cover.
    const burstSize = CAPACITY * 3;
    const amounts = bidAmounts(burstSize);
    for (let i = 0; i < burstSize; i += 1) {
      ws.send(encode({ t: "bid", clientSeq: i + 1, amount: amounts[i]! }));
    }

    // The limiter must not be rejecting everything (a broken "always deny"
    // implementation would still satisfy a bare "some RATE_LIMITED arrived"
    // check, which is exactly the vacuous assertion this test replaces from
    // the original brief — asserting the first bid succeeded rules that
    // implementation out).
    await waitFor(
      inbox,
      (m) => m.t === "ack" && (m as { clientSeq: number }).clientSeq === 1,
      "ack of the first bid"
    );

    // And the limiter must not be allowing everything through either. With
    // burstSize = 3x capacity and every one of those bids valid on the
    // auction's own rules (see the comment on `config` above), the only
    // thing that can produce a RATE_LIMITED reject here is the limiter
    // actually limiting.
    const limited = await waitFor(
      inbox,
      (m) => m.t === "reject" && (m as { reason: string }).reason === "RATE_LIMITED",
      "at least one RATE_LIMITED reject",
      500
    );
    expect(limited).toMatchObject({ t: "reject", reason: "RATE_LIMITED" });
  });

  it("does not refill the bucket when a client re-sends hello on the same socket", async () => {
    const id = roomId("rehello-flood");
    await initRoom(id);
    const { ws, inbox } = await openSocket(id, "ada");
    await waitFor(inbox, (m) => m.t === "snapshot", "first snapshot");

    // Everything from here to the final assertion is sent back-to-back on
    // the same WebSocket with no intermediate `await` — no round trip, no
    // polling wait — so the only elapsed time inside the window that must
    // stay under budget is the DO's own sequential processing of these 12
    // messages, not any client-observable delay. Per-connection WebSocket
    // message ordering guarantees the DO processes them in the order sent:
    // the 10 bids that exhaust the bucket, then the repeat `hello` (which
    // must not touch the bucket), then the probe bid.
    const amounts = bidAmounts(EXPECTED_CAPACITY);
    for (let i = 0; i < EXPECTED_CAPACITY; i += 1) {
      ws.send(encode({ t: "bid", clientSeq: i + 1, amount: amounts[i]! }));
    }
    // The bypass under test: re-sending hello on the same socket must not
    // hand the bucket a fresh set of tokens. If it did, the bid right after
    // this would be accepted instead of rate limited.
    ws.send(encode({ t: "hello", lastSeenSeq: 0, nickname: "ada-again", persistent: false }));
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
