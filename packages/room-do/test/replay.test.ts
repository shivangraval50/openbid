import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import { encode, parseServerMessage } from "@openbid/protocol";
import type { AuctionConfig } from "@openbid/auction-core";
import { shouldReplay, SNAPSHOT_THRESHOLD } from "../src/RoomDO.js";

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

const config: AuctionConfig = {
  itemName: "replay",
  startingPrice: 100,
  minIncrement: 10,
  startingBudget: 100_000,
  antiSnipeWindowMs: 1_000,
  antiSnipeExtensionMs: 1_000,
  endsAtMs: Date.now() + 3_600_000,
};

async function init(id: string) {
  const res = await SELF.fetch(`https://x/rooms/${id}/init`, {
    method: "POST",
    body: JSON.stringify(config),
  });
  expect(res.status).toBe(201);
}

async function connect(id: string, nickname: string, lastSeenSeq = 0) {
  const res = await SELF.fetch(`https://x/rooms/${id}/ws`, {
    headers: { Upgrade: "websocket" },
  });
  const ws = res.webSocket!;
  ws.accept();
  const inbox: ReturnType<typeof parseServerMessage>[] = [];
  ws.addEventListener("message", (e) => {
    inbox.push(parseServerMessage(String(e.data)));
  });
  ws.send(encode({ t: "hello", lastSeenSeq, nickname }));
  return { ws, inbox };
}

async function waitFor<T extends { t: string }>(inbox: T[], p: (m: T) => boolean, label: string) {
  for (let i = 0; i < 200; i += 1) {
    const hit = inbox.find(p);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("reconnect and replay", () => {
  it("replays only the events after lastSeenSeq", async () => {
    const id = roomId("resume");
    await init(id);
    const first = await connect(id, "ada");
    const snapshot = await waitFor(first.inbox, (m) => m.t === "snapshot", "snapshot");
    const seenSeq = (snapshot as { seq: number }).seq;

    first.ws.send(encode({ t: "bid", clientSeq: 1, amount: 100 }));
    const ack = await waitFor(first.inbox, (m) => m.t === "ack", "ack");
    const bidSeq = (ack as { seq: number }).seq;

    // A second connection resuming from seenSeq should be told about that
    // bid specifically (not merely *some* delta with a higher seq — the
    // newcomer's own join is broadcast to itself regardless of replay, at a
    // higher seq than seenSeq, which would make a looser assertion here
    // pass even with no replay logic at all).
    const second = await connect(id, "grace", seenSeq);
    const replayedBid = await waitFor(
      second.inbox,
      (m) =>
        m.t === "delta" && (m as { event?: { type?: string } }).event?.type === "bidPlaced",
      "replayed bid delta"
    );
    expect((replayedBid as { seq: number }).seq).toBe(bidSeq);
  });

  it("does not replay events at or before lastSeenSeq", async () => {
    const id = roomId("nodupe");
    await init(id);
    const first = await connect(id, "ada");
    await waitFor(first.inbox, (m) => m.t === "snapshot", "snapshot");
    first.ws.send(encode({ t: "bid", clientSeq: 1, amount: 100 }));
    const ack = await waitFor(first.inbox, (m) => m.t === "ack", "ack");
    const upToDate = (ack as { seq: number }).seq;

    const second = await connect(id, "grace", upToDate);
    await waitFor(second.inbox, (m) => m.t === "snapshot", "join snapshot");

    const staleDeltas = second.inbox.filter(
      (m) => m.t === "delta" && (m as { seq: number }).seq <= upToDate
    );
    expect(staleDeltas).toEqual([]);
  });

  it("delivers each seq to a resuming client at most once", async () => {
    const id = roomId("noduplicate");
    await init(id);
    const first = await connect(id, "ada");
    const snapshot = await waitFor(first.inbox, (m) => m.t === "snapshot", "snapshot");
    const seenSeq = (snapshot as { seq: number }).seq;

    first.ws.send(encode({ t: "bid", clientSeq: 1, amount: 100 }));
    await waitFor(first.inbox, (m) => m.t === "ack", "ack");

    // grace resumes at seenSeq, which triggers a replay (the gap is 1
    // event: ada's bid). The regression this guards: the hello branch used
    // to append grace's own `joined` event *before* deciding what to
    // replay, so that event's seq was always > lastSeenSeq and always
    // landed in the replay set — and then got sent *again* by the
    // broadcast a few lines later, which reaches every socket in the room
    // including the one that just joined. Wait for that broadcast (sent
    // after the snapshot) so every message this hello produces has had a
    // chance to land before asserting.
    const second = await connect(id, "grace", seenSeq);
    await waitFor(
      second.inbox,
      (m) =>
        m.t === "delta" &&
        (m as { event?: { type?: string; nickname?: string } }).event?.type === "joined" &&
        (m as { event?: { type?: string; nickname?: string } }).event?.nickname === "grace",
      "grace's own join broadcast"
    );

    const deltaSeqs = second.inbox
      .filter((m) => m.t === "delta")
      .map((m) => (m as { seq: number }).seq);
    expect(deltaSeqs).toEqual([...new Set(deltaSeqs)]);
  });
});

// The brief's original third test only asserted "a snapshot message
// arrives" on a far-behind `hello` — but a snapshot arrives on *every*
// `hello` path (see the replay tests above: both also wait for a
// "snapshot"). That assertion is true regardless of whether the 500-event
// threshold logic does anything at all, so it verifies nothing about the
// threshold. Driving 501 real events through WebSocket round trips to
// exercise the threshold for real would also be too slow for a unit test.
//
// Instead, `shouldReplay` — the pure decision the `hello` branch delegates
// to — is tested directly at its boundary. Each case below is chosen so a
// plausible wrong implementation (`<` instead of `<=`, or forgetting the
// `lastSeenSeq === 0` special case) fails it.
describe("shouldReplay", () => {
  it("replays when the gap is exactly the threshold (inclusive boundary)", () => {
    // A wrong `<` comparison here (gap < threshold) would reject this case:
    // 500 < 500 is false, so `<` would return false where the correct
    // answer is true.
    expect(shouldReplay(1, 1 + SNAPSHOT_THRESHOLD, SNAPSHOT_THRESHOLD)).toBe(true);
  });

  it("does not replay when the gap is one past the threshold", () => {
    expect(shouldReplay(1, 1 + SNAPSHOT_THRESHOLD + 1, SNAPSHOT_THRESHOLD)).toBe(false);
  });

  it("replays a small in-range gap", () => {
    expect(shouldReplay(10, 12, SNAPSHOT_THRESHOLD)).toBe(true);
  });

  it("never replays when lastSeenSeq is 0, no matter how small the gap is", () => {
    // A wrong implementation that only checks the gap (e.g.
    // `currentSeq - lastSeenSeq <= threshold`, dropping the `lastSeenSeq
    // <= 0` guard) would return true here, since the gap (1) is tiny.
    expect(shouldReplay(0, 1, SNAPSHOT_THRESHOLD)).toBe(false);
  });

  it("never replays when both lastSeenSeq and currentSeq are 0", () => {
    expect(shouldReplay(0, 0, SNAPSHOT_THRESHOLD)).toBe(false);
  });
});
