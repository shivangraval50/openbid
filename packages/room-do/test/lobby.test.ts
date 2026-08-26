import { describe, it, expect } from "vitest";
import { SELF, runInDurableObject, env } from "cloudflare:test";
import type { AuctionConfig } from "@openbid/auction-core";
import { encode, parseServerMessage } from "@openbid/protocol";
import type { RoomDO } from "../src/RoomDO.js";

interface LobbyRoom {
  roomId: string;
  itemName: string;
  endsAtMs: number;
  status: "open" | "closed";
  highBid: number | null;
}

/**
 * `isolatedStorage: false` (see vitest.config.ts) means every test file in
 * this package shares the same underlying storage — and `LobbyDO` is a
 * deliberate singleton addressed via `idFromName("global")`, so unlike a
 * room id, there is only ever *one* lobby instance across the entire test
 * run. Every test here therefore registers its own uniquely-suffixed room
 * id and asserts only on the entries it created, never on the registry's
 * total contents or length — those would be order-dependent (a "starts
 * empty" assertion, or a `toHaveLength(1)` on the whole list, is only true
 * if this test happens to run before every other test that has ever
 * registered a room in this run).
 */
function roomId(label: string): string {
  return `${label}-${crypto.randomUUID()}`;
}

/**
 * `LobbyDO` is the one Durable Object in this package that multiple test
 * *files* address by the same id (`idFromName("global")`) — room.test.ts
 * and settlement.test.ts also reach it, indirectly, via RoomDO's
 * `notifyLobby`. `@cloudflare/vitest-pool-workers` gives each test file its
 * own freshly-imported module graph even under `singleWorker: true`, and the
 * first time a shared Durable Object is touched from a *different* file's
 * graph than whichever one last touched it, the harness recreates the
 * instance and rejects that one call with an error whose own message says
 * "Please retry the `DurableObjectStub#fetch()` call." (see
 * node_modules/@cloudflare/vitest-pool-workers/dist/worker/lib/cloudflare/test-internal.mjs).
 * The throw is what recreates the instance, so this can only ever fire once
 * per such transition — a single retry is sufficient, and it is retrying
 * exactly what the harness's own error asks for, not masking a real bug in
 * `LobbyDO` or `RoomDO`. `RoomDO`'s own `notifyLobby` already tolerates this
 * silently (it swallows every error by design); this wrapper gives the
 * lobby's *direct* HTTP calls in this test file the same tolerance so no
 * test's pass/fail depends on which file happened to touch the singleton
 * first.
 */
async function lobbyFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await SELF.fetch(url, init);
  } catch (err) {
    if (err instanceof Error && err.message.includes("invalidating this Durable Object")) {
      return await SELF.fetch(url, init);
    }
    throw err;
  }
}

async function listRooms(): Promise<LobbyRoom[]> {
  const res = await lobbyFetch("https://x/lobby/rooms");
  expect(res.status).toBe(200);
  return ((await res.json()) as { rooms: LobbyRoom[] }).rooms;
}

async function findRoom(id: string): Promise<LobbyRoom | undefined> {
  return (await listRooms()).find((r) => r.roomId === id);
}

async function registerRoom(
  id: string,
  overrides: Partial<{ itemName: string; endsAtMs: number }> = {}
): Promise<Response> {
  return lobbyFetch("https://x/lobby/rooms", {
    method: "POST",
    body: JSON.stringify({ roomId: id, itemName: "Widget", endsAtMs: 5_000, ...overrides }),
  });
}

/** Poll the lobby's registry until `predicate` matches this room, or the
 * budget expires. Used only for waiting on `notifyLobby`'s async, best-effort
 * write to land — not for any assertion about how *fast* it lands. */
async function waitForRoom(
  id: string,
  predicate: (r: LobbyRoom) => boolean,
  label: string
): Promise<LobbyRoom> {
  for (let i = 0; i < 200; i += 1) {
    const room = await findRoom(id);
    if (room !== undefined && predicate(room)) return room;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for lobby room to reflect: ${label}`);
}

const auctionConfig: AuctionConfig = {
  itemName: "A rare compiler",
  startingPrice: 100,
  minIncrement: 10,
  startingBudget: 500,
  antiSnipeWindowMs: 0,
  antiSnipeExtensionMs: 0,
  endsAtMs: Date.now() + 600_000,
};

async function initRoom(id: string, config: AuctionConfig): Promise<void> {
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

async function fireAlarm(id: string): Promise<void> {
  const stub = env.ROOMS.get(env.ROOMS.idFromName(id));
  await runInDurableObject(stub, async (instance: RoomDO) => {
    await instance.alarm();
  });
}

describe("LobbyDO", () => {
  it("registers a room and lists it with open status and no cached price", async () => {
    const id = roomId("alpha");
    const res = await registerRoom(id, { itemName: "A rare compiler", endsAtMs: 5_000 });
    expect(res.status).toBe(201);

    const room = await findRoom(id);
    // A wrong implementation that never inserted the row, or inserted it
    // under the wrong key, leaves this undefined.
    expect(room).toMatchObject({
      roomId: id,
      itemName: "A rare compiler",
      endsAtMs: 5_000,
      status: "open",
      highBid: null,
    });
  });

  it("updates the cached price and status via the price endpoint", async () => {
    const id = roomId("beta");
    await registerRoom(id, { itemName: "Beta" });

    const res = await lobbyFetch(`https://x/lobby/rooms/${id}/price`, {
      method: "POST",
      body: JSON.stringify({ highBid: 250, status: "closed" }),
    });
    expect(res.status).toBe(204);

    const room = await findRoom(id);
    // Catches a price endpoint that no-ops, or that updates the wrong row
    // (e.g. ignores the :roomId path param and updates every room).
    expect(room).toMatchObject({ roomId: id, highBid: 250, status: "closed" });
  });

  it("overwrites itemName and endsAtMs, without duplicating the row, when the same room registers twice", async () => {
    const id = roomId("gamma");
    await registerRoom(id, { itemName: "Gamma v1", endsAtMs: 5_000 });
    await registerRoom(id, { itemName: "Gamma v2", endsAtMs: 9_000 });

    const rooms = (await listRooms()).filter((r) => r.roomId === id);
    // toHaveLength(1) alone would pass even if the second POST were a no-op
    // that never updated anything; matching the *second* write's values
    // additionally catches that "idempotent" degenerating into "ignored".
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({ itemName: "Gamma v2", endsAtMs: 9_000 });
  });

  it("400s registration with a missing itemName, and creates no row", async () => {
    const id = roomId("bad-register");
    const res = await lobbyFetch("https://x/lobby/rooms", {
      method: "POST",
      body: JSON.stringify({ roomId: id, endsAtMs: 5_000 }),
    });
    expect(res.status).toBe(400);

    // Proves the 400 short-circuited before any INSERT, not just that the
    // handler happens to also return 400 after writing a half-formed row.
    expect(await findRoom(id)).toBeUndefined();
  });

  it("400s registration with a non-numeric endsAtMs", async () => {
    const id = roomId("bad-ends-at");
    const res = await lobbyFetch("https://x/lobby/rooms", {
      method: "POST",
      body: JSON.stringify({ roomId: id, itemName: "Widget", endsAtMs: "soon" }),
    });
    expect(res.status).toBe(400);
    expect(await findRoom(id)).toBeUndefined();
  });

  it("400s a price update with an invalid status, and leaves the cached price untouched", async () => {
    const id = roomId("bad-price");
    await registerRoom(id, { itemName: "Delta" });

    const res = await lobbyFetch(`https://x/lobby/rooms/${id}/price`, {
      method: "POST",
      body: JSON.stringify({ highBid: 100, status: "pending" }),
    });
    expect(res.status).toBe(400);

    // A cast-based handler (the brief's `as {...}`) would accept "pending"
    // at the type level and write it straight into the status column; only
    // real Zod validation catches this before the UPDATE runs.
    const room = await findRoom(id);
    expect(room).toMatchObject({ status: "open", highBid: null });
  });

  it("400s a price update with a non-numeric highBid", async () => {
    const id = roomId("bad-highbid");
    await registerRoom(id, { itemName: "Epsilon" });

    const res = await lobbyFetch(`https://x/lobby/rooms/${id}/price`, {
      method: "POST",
      body: JSON.stringify({ highBid: "not-a-number", status: "open" }),
    });
    expect(res.status).toBe(400);
  });

  it("reflects an accepted bid's price in the lobby cache without the price endpoint being called directly", async () => {
    const id = roomId("notify-bid");
    await registerRoom(id, { itemName: "Notified widget", endsAtMs: Date.now() + 600_000 });
    await initRoom(id, auctionConfig);

    const { ws, inbox } = await openSocket(id, "ada");
    await waitFor(inbox, (m) => m.t === "snapshot", "snapshot");

    ws.send(encode({ t: "bid", clientSeq: 1, amount: 100 }));
    await waitFor(inbox, (m) => m.t === "ack", "ack");

    // If `notifyLobby` were never wired into the bid path, this room's
    // cached price would sit at `null` forever and this poll would time
    // out — this is the test the task calls out as required: proving the
    // cache updates from a real bid, not merely that the price endpoint
    // works when called directly (already covered above).
    const room = await waitForRoom(id, (r) => r.highBid === 100, "highBid to reach 100");
    expect(room).toMatchObject({ status: "open", highBid: 100 });
  });

  it("reflects settlement's final price and closed status in the lobby cache", async () => {
    const id = roomId("notify-settle");
    await registerRoom(id, { itemName: "Settled widget", endsAtMs: Date.now() + 2_000 });

    const config: AuctionConfig = { ...auctionConfig, endsAtMs: Date.now() + 2_000 };
    await initRoom(id, config);

    const { ws, inbox } = await openSocket(id, "bob");
    await waitFor(inbox, (m) => m.t === "snapshot", "snapshot");
    ws.send(encode({ t: "bid", clientSeq: 1, amount: 150 }));
    await waitFor(inbox, (m) => m.t === "ack", "ack");

    // Let the bid's own notifyLobby call land first, so the assertion below
    // is unambiguously about the settlement call site, not a repeat of the
    // bid one.
    await waitForRoom(id, (r) => r.highBid === 150, "highBid to reach 150 from the bid");

    const remaining = config.endsAtMs - Date.now();
    if (remaining > 0) {
      await new Promise((r) => setTimeout(r, remaining + 20));
    }
    await fireAlarm(id);

    // If `notifyLobby` were wired only into the bid path and not the alarm
    // handler, this room would stay stuck at `status: "open"` in the lobby
    // even though RoomDO itself has closed — this poll would time out.
    const room = await waitForRoom(id, (r) => r.status === "closed", "status to reach closed");
    expect(room).toMatchObject({ status: "closed", highBid: 150 });
  });
});
