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

/**
 * `isolatedStorage: false` (required for WebSockets-over-Durable-Objects,
 * see vitest.config.ts) means every test file in this package shares the
 * same underlying storage. Suffix every room id so no two tests — in this
 * file or a future one — can ever collide on the same room.
 */
function roomId(label: string): string {
  return `${label}-${crypto.randomUUID()}`;
}

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
    const id = roomId("snap");
    await initRoom(id);
    const res = await SELF.fetch(`https://x/rooms/${id}/snapshot`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { seq: number; state: { config: AuctionConfig } };
    expect(body.state.config.itemName).toBe("A rare compiler");
  });

  it("404s a snapshot for a room that was never initialised", async () => {
    const res = await SELF.fetch(`https://x/rooms/${roomId("ghost")}/snapshot`);
    expect(res.status).toBe(404);
  });

  it("sends a snapshot on hello", async () => {
    const id = roomId("hello");
    await initRoom(id);
    const { inbox } = await openSocket(id, "ada");
    const snapshot = await waitFor(inbox, (m) => m.t === "snapshot", "snapshot");
    expect(snapshot.t).toBe("snapshot");
  });

  it("acks a valid bid and broadcasts a delta", async () => {
    const id = roomId("bid");
    await initRoom(id);
    const { ws, inbox } = await openSocket(id, "ada");
    await waitFor(inbox, (m) => m.t === "snapshot", "snapshot");

    ws.send(encode({ t: "bid", clientSeq: 1, amount: 100 }));

    const ack = await waitFor(inbox, (m) => m.t === "ack", "ack");
    expect(ack).toMatchObject({ t: "ack", clientSeq: 1 });
    const delta = await waitFor(
      inbox,
      (m) => m.t === "delta" && (m as { event?: { type?: string } }).event?.type === "bidPlaced",
      "bid delta"
    );
    expect(delta).toMatchObject({ t: "delta" });
  });

  it("rejects a bid below the minimum with TOO_LOW", async () => {
    const id = roomId("low");
    await initRoom(id);
    const { ws, inbox } = await openSocket(id, "ada");
    await waitFor(inbox, (m) => m.t === "snapshot", "snapshot");

    ws.send(encode({ t: "bid", clientSeq: 1, amount: 5 }));

    const reject = await waitFor(inbox, (m) => m.t === "reject", "reject");
    expect(reject).toMatchObject({ t: "reject", clientSeq: 1, reason: "TOO_LOW" });
  });

  it("rejects a bid above the bidder budget with INSUFFICIENT_BUDGET", async () => {
    const id = roomId("rich");
    await initRoom(id);
    const { ws, inbox } = await openSocket(id, "ada");
    await waitFor(inbox, (m) => m.t === "snapshot", "snapshot");

    ws.send(encode({ t: "bid", clientSeq: 1, amount: 100_000 }));

    const reject = await waitFor(inbox, (m) => m.t === "reject", "reject");
    expect(reject).toMatchObject({ reason: "INSUFFICIENT_BUDGET" });
  });

  it("assigns strictly increasing sequence numbers", async () => {
    const id = roomId("seq");
    await initRoom(id);
    const { ws, inbox } = await openSocket(id, "ada");
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
    const id = roomId("ping");
    await initRoom(id);
    const { ws, inbox } = await openSocket(id, "ada");
    ws.send(encode({ t: "ping", clientTime: 12_345 }));
    const pong = await waitFor(inbox, (m) => m.t === "pong", "pong");
    expect(pong).toMatchObject({ t: "pong", clientTime: 12_345 });
    expect(typeof (pong as { serverTime: number }).serverTime).toBe("number");
  });

  it("closes only the offending socket on a malformed message, and the room stays alive", async () => {
    const id = roomId("bad");
    await initRoom(id);
    const { ws: badWs } = await openSocket(id, "ada");
    const { ws: goodWs, inbox: goodInbox } = await openSocket(id, "bob");
    await waitFor(goodInbox, (m) => m.t === "snapshot", "bob's snapshot");

    let closed = false;
    badWs.addEventListener("close", () => {
      closed = true;
    });
    badWs.send("not json at all");
    for (let i = 0; i < 100 && !closed; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(closed).toBe(true);

    // The room-wide blast radius the parse guard exists to prevent: if
    // `webSocketMessage` had thrown instead of closing just the offending
    // socket, the whole DO would reset and every socket — including this
    // one, which never sent anything bad — would be disconnected too.
    goodWs.send(encode({ t: "ping", clientTime: 99 }));
    const pong = await waitFor(goodInbox, (m) => m.t === "pong", "pong after neighbor's garbage");
    expect(pong).toMatchObject({ t: "pong", clientTime: 99 });

    // A ping alone never calls `broadcast`, so it can't tell us whether
    // `broadcast` itself is still safe to call now that `badWs` is closed
    // but still enumerable by `getWebSockets()` (the exact failure mode
    // Important 5 named: A sends garbage and is closed, B bids, broadcast
    // reaches the closed A, an unguarded `ws.send` there throws mid-loop and
    // takes the whole room down). Force that path for real.
    goodWs.send(encode({ t: "bid", clientSeq: 1, amount: 100 }));
    const ack = await waitFor(goodInbox, (m) => m.t === "ack", "ack after neighbor's garbage");
    expect(ack).toMatchObject({ t: "ack", clientSeq: 1 });
    const delta = await waitFor(
      goodInbox,
      (m) => m.t === "delta" && (m as { event?: { type?: string } }).event?.type === "bidPlaced",
      "bid delta after neighbor's garbage"
    );
    expect(delta.t).toBe("delta");
  });

  it("allows re-initialising a room that has no events yet", async () => {
    const id = roomId("reinit-empty");
    await initRoom(id);
    // No socket ever connected, no bid ever placed: still safe to retry.
    const res = await SELF.fetch(`https://x/rooms/${id}/init`, {
      method: "POST",
      body: JSON.stringify({ ...config, itemName: "A different item" }),
    });
    expect(res.status).toBe(201);

    const snap = await SELF.fetch(`https://x/rooms/${id}/snapshot`);
    const body = (await snap.json()) as { state: { config: AuctionConfig } };
    expect(body.state.config.itemName).toBe("A different item");
  });

  it("409s re-initialising a room that already has events", async () => {
    const id = roomId("reinit-live");
    await initRoom(id);
    const { ws, inbox } = await openSocket(id, "ada");
    await waitFor(inbox, (m) => m.t === "snapshot", "snapshot");
    ws.send(encode({ t: "bid", clientSeq: 1, amount: 100 }));
    await waitFor(inbox, (m) => m.t === "ack", "ack");

    const res = await SELF.fetch(`https://x/rooms/${id}/init`, {
      method: "POST",
      body: JSON.stringify(config),
    });
    expect(res.status).toBe(409);
  });

  it("400s init with a malformed body", async () => {
    const id = roomId("bad-init");
    const res = await SELF.fetch(`https://x/rooms/${id}/init`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);

    // And the room must not have been left half-initialised by the attempt.
    const snap = await SELF.fetch(`https://x/rooms/${id}/snapshot`);
    expect(snap.status).toBe(404);
  });

  it("broadcasts a joined event to already-connected clients", async () => {
    const id = roomId("join-broadcast");
    await initRoom(id);
    const { inbox: adaInbox } = await openSocket(id, "ada");
    await waitFor(adaInbox, (m) => m.t === "snapshot", "ada's snapshot");

    await openSocket(id, "bob");

    const delta = await waitFor(
      adaInbox,
      (m) =>
        m.t === "delta" &&
        (m as { event?: { type?: string; nickname?: string } }).event?.type === "joined" &&
        (m as { event?: { type?: string; nickname?: string } }).event?.nickname === "bob",
      "bob's joined delta, seen by ada"
    );
    expect(delta.t).toBe("delta");
  });

  it("does not create a duplicate participant on repeated hello over the same socket", async () => {
    const id = roomId("rehello");
    await initRoom(id);
    const { ws, inbox } = await openSocket(id, "ada");
    await waitFor(inbox, (m) => m.t === "snapshot", "first snapshot");

    ws.send(encode({ t: "hello", lastSeenSeq: 0, nickname: "ada-again" }));
    await waitFor(
      inbox,
      () => inbox.filter((m) => m.t === "snapshot").length >= 2,
      "second snapshot"
    );

    const snap = await SELF.fetch(`https://x/rooms/${id}/snapshot`);
    const body = (await snap.json()) as {
      seq: number;
      state: { participants: Record<string, unknown> };
    };
    // One `joined` event, one participant — the second hello must not have
    // appended another event or minted another participant.
    expect(body.seq).toBe(1);
    expect(Object.keys(body.state.participants)).toHaveLength(1);
  });
});
