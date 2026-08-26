import { describe, it, expect } from "vitest";
import { SELF, runInDurableObject, env } from "cloudflare:test";
import { encode, parseServerMessage } from "@openbid/protocol";
import type { AuctionConfig } from "@openbid/auction-core";
import type { RoomDO } from "../src/RoomDO.js";

/**
 * `isolatedStorage: false` means every test file in this package shares the
 * same underlying storage (see vitest.config.ts and test/room.test.ts for
 * the full explanation). Every room id here gets its own
 * crypto.randomUUID() suffix so no test — in this file or any other — can
 * ever collide on the same room.
 */
function roomId(label: string): string {
  return `${label}-${crypto.randomUUID()}`;
}

function configEndingIn(ms: number, overrides: Partial<AuctionConfig> = {}): AuctionConfig {
  return {
    itemName: "expiring",
    startingPrice: 100,
    minIncrement: 10,
    startingBudget: 500,
    antiSnipeWindowMs: 0,
    antiSnipeExtensionMs: 0,
    endsAtMs: Date.now() + ms,
    ...overrides,
  };
}

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

/**
 * Drive `alarm()` directly on the room's own Durable Object instance,
 * exactly as Cloudflare would when a scheduled alarm fires — but on demand,
 * so no test here has to block on real wall-clock time to prove the
 * server-owned clock actually closes an auction.
 */
async function fireAlarm(id: string): Promise<void> {
  const stub = env.ROOMS.get(env.ROOMS.idFromName(id));
  await runInDurableObject(stub, async (instance: RoomDO) => {
    await instance.alarm();
  });
}

describe("expiry and settlement", () => {
  it("closes the auction once the deadline passes", async () => {
    const id = roomId("expire");
    // Already expired at init: the test environment's own alarm scheduler
    // may fire this alarm on its own the instant it is armed (it does not
    // wait for a manual trigger just because one exists), so this test
    // cannot assume it is the one running `alarm()` — only that the room
    // ends up closed one way or the other. `fireAlarm` below is still
    // exercised directly (rather than only relying on the scheduler) so
    // this test does not depend on real time to make that happen.
    await initRoom(id, configEndingIn(-1));

    await fireAlarm(id);

    const snapshotRes = await SELF.fetch(`https://x/rooms/${id}/snapshot`);
    const body = (await snapshotRes.json()) as { state: { status: string } };
    expect(body.state.status).toBe("closed");
  });

  it("rejects bids after settlement with AUCTION_CLOSED", async () => {
    const id = roomId("after");
    await initRoom(id, configEndingIn(-1));
    await fireAlarm(id);

    const { ws, inbox } = await openSocket(id, "grace");
    await waitFor(inbox, (m) => m.t === "snapshot", "snapshot");
    ws.send(encode({ t: "bid", clientSeq: 1, amount: 200 }));

    const reject = await waitFor(inbox, (m) => m.t === "reject", "reject");
    expect(reject).toMatchObject({ reason: "AUCTION_CLOSED" });
  });

  it(
    "queues exactly one settlement in the outbox, with the right winner, " +
      "price and room, when the archive write fails",
    async () => {
      const id = roomId("outbox-payload");
      // Generous window: the hello+bid round trip only needs to land before
      // this, and the test explicitly waits out whatever is left afterward
      // (see below) rather than assuming the round trip is fast — so
      // nothing here depends on staying under a tight wall-clock budget.
      const config = configEndingIn(500);
      await initRoom(id, config);

      const { ws, inbox } = await openSocket(id, "grace");
      await waitFor(inbox, (m) => m.t === "snapshot", "snapshot");
      ws.send(encode({ t: "bid", clientSeq: 1, amount: 150 }));
      await waitFor(inbox, (m) => m.t === "ack", "ack");

      const remaining = config.endsAtMs - Date.now();
      if (remaining > 0) {
        await new Promise((r) => setTimeout(r, remaining + 20));
      }

      // DATABASE_URL is unset (empty string) in the test environment, so
      // archiveSettlement throws and the record must stay queued rather
      // than being dropped or silently duplicated.
      await fireAlarm(id);

      const stub = env.ROOMS.get(env.ROOMS.idFromName(id));
      await runInDurableObject(stub, (_instance: RoomDO, state: DurableObjectState) => {
        const rows = state.storage.sql
          .exec<{ n: number }>("SELECT COUNT(*) AS n FROM outbox")
          .toArray();
        // Exactly one — not "at least one". Several queued rows (e.g. from
        // repeated alarm firings each re-enqueuing their own record) would
        // satisfy a >0 check just as well as the single correct record;
        // only an exact count catches that.
        expect(rows[0]!.n).toBe(1);

        const payloadRows = state.storage.sql
          .exec<{ payload: string }>("SELECT payload FROM outbox")
          .toArray();
        const record = JSON.parse(payloadRows[0]!.payload) as {
          roomId: string;
          itemName: string;
          startingPrice: number;
          winnerNickname: string | null;
          winningPrice: number | null;
          closedAtMs: number;
          bidLog: unknown[];
        };
        expect(record.roomId).toBe(id);
        expect(record.itemName).toBe(config.itemName);
        expect(record.startingPrice).toBe(config.startingPrice);
        expect(record.winnerNickname).toBe("grace");
        expect(record.winningPrice).toBe(150);
        expect(Array.isArray(record.bidLog)).toBe(true);
        expect(
          record.bidLog.some((e) => (e as { type?: string }).type === "closed")
        ).toBe(true);
      });
    }
  );

  it(
    "does not let a failed outbox retry clobber a pending expiry alarm on a still-open room",
    async () => {
      const id = roomId("guard");
      // Comfortably longer than the 60s outbox retry delay the brief's
      // (buggy) drainOutbox would schedule unconditionally. If the guard is
      // missing, that unconditional setAlarm(now + 60_000) overwrites this
      // and the auction could never close on time.
      const config = configEndingIn(5_000);
      await initRoom(id, config);

      const stub = env.ROOMS.get(env.ROOMS.idFromName(id));

      // Seed a queued outbox record directly, bypassing a real close, so
      // drainOutbox has something to fail on while the room is still open.
      // In production a room only ever gets an outbox row once it has
      // closed (queueing happens inside the same branch that appends the
      // `closed` event), so this seeds the one situation that lets the
      // test observe the guard: a retry attempt racing a still-pending
      // expiry alarm.
      await runInDurableObject(stub, (_instance: RoomDO, state: DurableObjectState) => {
        state.storage.sql.exec(
          "INSERT INTO outbox (payload) VALUES (?)",
          JSON.stringify({
            roomId: id,
            itemName: config.itemName,
            startingPrice: config.startingPrice,
            winnerNickname: null,
            winningPrice: null,
            closedAtMs: Date.now(),
            bidLog: [],
          })
        );
      });

      // The auction is still open and nowhere near its deadline, so this
      // alarm() call takes the "re-arm for the current deadline" branch,
      // then drainOutbox() finds the seeded row, fails to archive it
      // (DATABASE_URL is unset), and must decide whether to touch the
      // alarm again.
      await fireAlarm(id);

      await runInDurableObject(stub, async (_instance: RoomDO, state: DurableObjectState) => {
        // The outbox record is still queued — the failure must not have
        // dropped it.
        const rows = state.storage.sql
          .exec<{ n: number }>("SELECT COUNT(*) AS n FROM outbox")
          .toArray();
        expect(rows[0]!.n).toBe(1);

        // The load-bearing assertion: the alarm must still be the real
        // expiry deadline, not a 60-second-out retry that would land
        // *after* it. A version of drainOutbox that calls
        // `setAlarm(Date.now() + 60_000)` unconditionally on failure would
        // push this past config.endsAtMs and fail this exact check.
        const alarmAt = await state.storage.getAlarm();
        expect(alarmAt).toBe(config.endsAtMs);
      });
    }
  );
});
