import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import type { AuctionConfig } from "@openbid/auction-core";
import { encode, parseServerMessage } from "@openbid/protocol";

const config: AuctionConfig = {
  itemName: "A rare compiler",
  startingPrice: 100,
  minIncrement: 10,
  startingBudget: 500,
  antiSnipeWindowMs: 10_000,
  antiSnipeExtensionMs: 15_000,
  endsAtMs: Date.now() + 600_000,
};

async function initRoom(id: string, overrides: Partial<AuctionConfig> = {}) {
  const res = await SELF.fetch(`https://x/rooms/${id}/init`, {
    method: "POST",
    body: JSON.stringify({ ...config, ...overrides }),
  });
  expect(res.status).toBe(201);
}

async function openSocket(id: string, nickname: string) {
  const res = await SELF.fetch(`https://x/rooms/${id}/ws`, {
    headers: { Upgrade: "websocket" },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error("expected a webSocket on the response");
  ws.accept();

  const inbox: ReturnType<typeof parseServerMessage>[] = [];
  ws.addEventListener("message", (event) => {
    inbox.push(parseServerMessage(String(event.data)));
  });

  ws.send(encode({ t: "hello", lastSeenSeq: 0, nickname }));
  return { ws, inbox };
}

/** Poll the inbox until `predicate` matches or the budget expires. */
async function waitFor<T extends { t: string }>(
  inbox: T[],
  predicate: (m: T) => boolean,
  label: string
): Promise<T> {
  for (let i = 0; i < 100; i += 1) {
    const found = inbox.find(predicate);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${label}; saw: ${inbox.map((m) => m.t).join(",")}`);
}

describe("RoomDO", () => {
  it("serves an HTTP snapshot after init", async () => {
    await initRoom("snap");
    const res = await SELF.fetch("https://x/rooms/snap/snapshot");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { seq: number; state: { config: AuctionConfig } };
    expect(body.state.config.itemName).toBe("A rare compiler");
  });

  it("404s a snapshot for a room that was never initialised", async () => {
    const res = await SELF.fetch("https://x/rooms/ghost/snapshot");
    expect(res.status).toBe(404);
  });

  it("sends a snapshot on hello", async () => {
    await initRoom("hello");
    const { inbox } = await openSocket("hello", "ada");
    const snapshot = await waitFor(inbox, (m) => m.t === "snapshot", "snapshot");
    expect(snapshot.t).toBe("snapshot");
  });

  it("acks a valid bid and broadcasts a delta", async () => {
    await initRoom("bid");
    const { ws, inbox } = await openSocket("bid", "ada");
    await waitFor(inbox, (m) => m.t === "snapshot", "snapshot");

    ws.send(encode({ t: "bid", clientSeq: 1, amount: 100 }));

    const ack = await waitFor(inbox, (m) => m.t === "ack", "ack");
    expect(ack).toMatchObject({ t: "ack", clientSeq: 1 });
    const delta = await waitFor(inbox, (m) => m.t === "delta", "delta");
    expect(delta).toMatchObject({ t: "delta" });
  });

  it("rejects a bid below the minimum with TOO_LOW", async () => {
    await initRoom("low");
    const { ws, inbox } = await openSocket("low", "ada");
    await waitFor(inbox, (m) => m.t === "snapshot", "snapshot");

    ws.send(encode({ t: "bid", clientSeq: 1, amount: 5 }));

    const reject = await waitFor(inbox, (m) => m.t === "reject", "reject");
    expect(reject).toMatchObject({ t: "reject", clientSeq: 1, reason: "TOO_LOW" });
  });

  it("rejects a bid above the bidder budget with INSUFFICIENT_BUDGET", async () => {
    await initRoom("rich");
    const { ws, inbox } = await openSocket("rich", "ada");
    await waitFor(inbox, (m) => m.t === "snapshot", "snapshot");

    ws.send(encode({ t: "bid", clientSeq: 1, amount: 100_000 }));

    const reject = await waitFor(inbox, (m) => m.t === "reject", "reject");
    expect(reject).toMatchObject({ reason: "INSUFFICIENT_BUDGET" });
  });

  it("assigns strictly increasing sequence numbers", async () => {
    await initRoom("seq");
    const { ws, inbox } = await openSocket("seq", "ada");
    await waitFor(inbox, (m) => m.t === "snapshot", "snapshot");

    ws.send(encode({ t: "bid", clientSeq: 1, amount: 100 }));
    await waitFor(inbox, (m) => m.t === "ack", "first ack");
    ws.send(encode({ t: "bid", clientSeq: 2, amount: 200 }));
    await waitFor(inbox, (m) => m.t === "ack" && m.clientSeq === 2, "second ack");

    const seqs = inbox.filter((m) => m.t === "delta").map((m) => (m as { seq: number }).seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("answers ping with pong carrying server time", async () => {
    await initRoom("ping");
    const { ws, inbox } = await openSocket("ping", "ada");
    ws.send(encode({ t: "ping", clientTime: 12_345 }));
    const pong = await waitFor(inbox, (m) => m.t === "pong", "pong");
    expect(pong).toMatchObject({ t: "pong", clientTime: 12_345 });
    expect(typeof (pong as { serverTime: number }).serverTime).toBe("number");
  });

  it("closes the socket on a malformed message instead of throwing", async () => {
    await initRoom("bad");
    const { ws } = await openSocket("bad", "ada");
    let closed = false;
    ws.addEventListener("close", () => {
      closed = true;
    });
    ws.send("not json at all");
    for (let i = 0; i < 100 && !closed; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(closed).toBe(true);
  });
});
