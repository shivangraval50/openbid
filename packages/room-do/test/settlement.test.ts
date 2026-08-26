import { describe, it, expect } from "vitest";
import { SELF, runInDurableObject, env } from "cloudflare:test";
import { encode, parseServerMessage } from "@openbid/protocol";
import type { AuctionConfig } from "@openbid/auction-core";
import type { RoomDO } from "../src/RoomDO.js";
import type { SettlementRecord } from "../src/archive.js";
import { appendEvent } from "../src/sql.js";

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

function stubFor(id: string) {
  return env.ROOMS.get(env.ROOMS.idFromName(id));
}

/**
 * Drive `alarm()` directly on the room's own Durable Object instance,
 * exactly as Cloudflare would when a scheduled alarm fires — but on demand,
 * so no test here has to block on real wall-clock time to prove the
 * server-owned clock actually closes an auction.
 */
async function fireAlarm(id: string): Promise<void> {
  await runInDurableObject(stubFor(id), async (instance: RoomDO) => {
    await instance.alarm();
  });
}

function outboxCount(state: DurableObjectState): number {
  return state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM outbox").toArray()[0]!
    .n;
}

/** Seed a queued outbox row directly, bypassing a real close. Used only to
 * exercise `drainOutbox` in isolation from `alarm()`'s own closing logic. */
function seedOutboxRow(state: DurableObjectState, id: string, config: AuctionConfig): void {
  const record: SettlementRecord = {
    roomId: id,
    itemName: config.itemName,
    startingPrice: config.startingPrice,
    winnerNickname: null,
    winningPrice: null,
    closedAtMs: Date.now(),
    bidLog: [],
  };
  state.storage.sql.exec("INSERT INTO outbox (payload) VALUES (?)", JSON.stringify(record));
}

/** A day out is far enough that this package's own test suite (each file
 * finishes in low single-digit seconds) can never reach it: a room
 * configured this way stays genuinely open for the whole test with zero
 * real-time risk — no waiting, and no possibility of the environment's own
 * alarm scheduler firing it out from under the test. */
const FAR_FUTURE_MS = 24 * 60 * 60 * 1000;

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
      "price, room, and bid log, when the archive write fails",
    async () => {
      const id = roomId("outbox-payload");
      // Generous window: the two bidders' hello+bid round trips only need
      // to land before this, and the test explicitly waits out whatever
      // is left afterward (see below) rather than assuming the round
      // trips are fast — so nothing here depends on staying under a tight
      // wall-clock budget.
      const config = configEndingIn(2_000);
      await initRoom(id, config);

      // bob bids first and loses; grace bids second, higher, and wins.
      // With only one bidder, a bug that resolves "the first/only
      // participant" instead of correctly mapping winnerId -> nickname
      // would still pass every assertion below; a second, losing bidder
      // rules that out.
      const { ws: bobWs, inbox: bobInbox } = await openSocket(id, "bob");
      await waitFor(bobInbox, (m) => m.t === "snapshot", "bob's snapshot");
      bobWs.send(encode({ t: "bid", clientSeq: 1, amount: 100 }));
      await waitFor(bobInbox, (m) => m.t === "ack", "bob's ack");

      const { ws: graceWs, inbox: graceInbox } = await openSocket(id, "grace");
      await waitFor(graceInbox, (m) => m.t === "snapshot", "grace's snapshot");
      graceWs.send(encode({ t: "bid", clientSeq: 1, amount: 150 }));
      await waitFor(graceInbox, (m) => m.t === "ack", "grace's ack");

      const remaining = config.endsAtMs - Date.now();
      if (remaining > 0) {
        await new Promise((r) => setTimeout(r, remaining + 20));
      }

      // DATABASE_URL is unset (undefined) in the test environment, so
      // archiveSettlement throws and the record must stay queued rather
      // than being dropped or silently duplicated.
      await fireAlarm(id);

      await runInDurableObject(stubFor(id), (_instance: RoomDO, state: DurableObjectState) => {
        // Exactly one — not "at least one". Several queued rows (e.g.
        // from repeated alarm firings each re-enqueuing their own record)
        // would satisfy a >0 check just as well as the single correct
        // record; only an exact count catches that.
        expect(outboxCount(state)).toBe(1);

        const payloadRows = state.storage.sql
          .exec<{ payload: string }>("SELECT payload FROM outbox")
          .toArray();
        const record = JSON.parse(payloadRows[0]!.payload) as SettlementRecord;
        expect(record.roomId).toBe(id);
        expect(record.itemName).toBe(config.itemName);
        expect(record.startingPrice).toBe(config.startingPrice);
        expect(record.winnerNickname).toBe("grace");
        expect(record.winningPrice).toBe(150);

        // A real check on the log's contents, not just "it's an array"
        // (which `bidLog: unknown[]` already guarantees at compile time
        // and so can never fail): the exact sequence of event types this
        // room actually produced — both joins, both bids, then the close.
        const types = record.bidLog.map((e) => (e as { type: string }).type);
        expect(types).toEqual(["joined", "bidPlaced", "joined", "bidPlaced", "closed"]);
      });
    }
  );

  it(
    "removes a settlement from the outbox once the archive write succeeds",
    async () => {
      const id = roomId("archive-success");
      // Open, and never due during this test (see FAR_FUTURE_MS): this
      // test is only about drainOutbox's success path, not about closing
      // a real auction, so there is nothing to gain from a real deadline.
      const config = configEndingIn(FAR_FUTURE_MS);
      await initRoom(id, config);

      // Everything happens inside one runInDurableObject callback so there
      // is no doubt the in-memory `archiveFn` override below is read back
      // by the very same `alarm()` call that follows it — an in-memory
      // field, unlike the SQL storage the other tests in this file poke
      // at, would not survive a hand-off to a different instance.
      await runInDurableObject(
        stubFor(id),
        async (instance: RoomDO, state: DurableObjectState) => {
          seedOutboxRow(state, id, config);

          // Testability seam, not a public extension point: replace the
          // real Neon writer with a fake that always succeeds, so this
          // test can prove drainOutbox actually deletes a row on success
          // — the one behavior this suite otherwise cannot exercise at
          // all, since DATABASE_URL is deliberately unset everywhere else
          // in it.
          (
            instance as unknown as {
              archiveFn: (url: string | undefined, record: SettlementRecord) => Promise<void>;
            }
          ).archiveFn = async () => {};

          await instance.alarm();

          expect(outboxCount(state)).toBe(0);
        }
      );
    }
  );

  it(
    "does not let a failed outbox retry clobber a pending expiry alarm on a still-open room",
    async () => {
      const id = roomId("guard-skip");
      // Sooner than the 60s retry the guard would otherwise schedule, but
      // as generous as that constraint allows: this specific scenario —
      // protecting a real, still-pending expiry alarm on an *open* room —
      // requires the room to actually still be open with a near-term
      // deadline (see the two far-future variants below for the branches
      // that don't need that), so some margin against real elapsed time
      // is unavoidable here. 50s leaves roughly 49.4s of slack over the
      // sub-second time this test actually takes.
      const config = configEndingIn(50_000);
      await initRoom(id, config);

      // Seed a queued outbox record directly, bypassing a real close, so
      // drainOutbox has something to fail on while the room is still
      // open. This precondition — a still-open room already holding an
      // outbox row — cannot occur in production: the only `INSERT INTO
      // outbox` runs strictly after `reduce` has flipped status to
      // "closed" in the same turn, and a closed room can never reopen. So
      // this is an invariant-violation test, not a race reproduction: it
      // proves the guard holds even if that invariant were ever broken by
      // a future change, which is exactly the kind of decoupling a
      // structural guard like this is cheap insurance against.
      await runInDurableObject(stubFor(id), (_instance: RoomDO, state: DurableObjectState) => {
        seedOutboxRow(state, id, config);
      });

      // The auction is still open and nowhere near its deadline, so this
      // alarm() call takes the "re-arm for the current deadline" branch,
      // then drainOutbox() finds the seeded row, fails to archive it
      // (DATABASE_URL is unset), and must decide whether to touch the
      // alarm again.
      await fireAlarm(id);

      await runInDurableObject(
        stubFor(id),
        async (_instance: RoomDO, state: DurableObjectState) => {
          // The outbox record is still queued — the failure must not have
          // dropped it.
          expect(outboxCount(state)).toBe(1);

          // The load-bearing assertion: the alarm must still be the real
          // expiry deadline, not a 60-second-out retry that would land
          // *after* it. A version of drainOutbox that calls
          // `setAlarm(Date.now() + 60_000)` unconditionally on failure
          // would push this past config.endsAtMs and fail this exact
          // check.
          const alarmAt = await state.storage.getAlarm();
          expect(alarmAt).toBe(config.endsAtMs);
        }
      );
    }
  );

  it(
    "schedules a retry when no alarm is currently scheduled and the archive write fails",
    async () => {
      const id = roomId("guard-noalarm");
      // Open at init (so /init's own setAlarm call is exercised normally),
      // but far enough out that it is never actually due during this
      // test. Status is forced to "closed" below without waiting on real
      // time, which is what makes `existing === null` reachable at all:
      // for an *open* room, alarm()'s own re-arm branch always sets the
      // alarm to state.endsAtMs before drainOutbox ever runs, so
      // `existing` there can never be null. Only a closed room — where
      // that branch does not run at all — can present drainOutbox with no
      // alarm scheduled.
      const config = configEndingIn(FAR_FUTURE_MS);
      await initRoom(id, config);

      await runInDurableObject(stubFor(id), async (_instance: RoomDO, state: DurableObjectState) => {
        // Force "closed" the same way alarm()'s own close branch does —
        // append a `closed` event directly — rather than waiting for a
        // real deadline.
        appendEvent(state.storage.sql, { type: "closed", atMs: Date.now(), winner: null });
        seedOutboxRow(state, id, config);
        // /init already scheduled a real (far-future) expiry alarm;
        // clear it so this test's precondition — no alarm scheduled at
        // all — is explicit rather than incidental.
        await state.storage.deleteAlarm();
      });

      await fireAlarm(id);

      await runInDurableObject(
        stubFor(id),
        async (_instance: RoomDO, state: DurableObjectState) => {
          // Still queued — the failed write must not have dropped it.
          expect(outboxCount(state)).toBe(1);

          // The load-bearing assertion: with nothing else to protect, the
          // guard must schedule the retry rather than leave the alarm
          // unset — a guard written `if (existing !== null && retryAt <
          // existing)` would skip here (existing is null), leaving this
          // closed room's failed settlement stuck in the outbox forever
          // with no future alarm to ever retry it.
          const alarmAt = await state.storage.getAlarm();
          expect(alarmAt).not.toBeNull();
          const now = Date.now();
          expect(alarmAt!).toBeGreaterThanOrEqual(now + 55_000);
          expect(alarmAt!).toBeLessThanOrEqual(now + 65_000);
        }
      );
    }
  );

  it(
    "pulls in a later pending alarm to the retry time when the archive write fails",
    async () => {
      const id = roomId("guard-pullin");
      // Open, and far later than the 60s retry the guard should pull the
      // alarm in to. Because the room stays genuinely open throughout,
      // alarm()'s own re-arm branch sets the alarm to state.endsAtMs
      // (i.e. this far-future value) immediately before drainOutbox runs
      // — so drainOutbox is guaranteed to see an *existing* alarm that is
      // later than the retry candidate, without needing any real time to
      // pass.
      const config = configEndingIn(FAR_FUTURE_MS);
      await initRoom(id, config);

      await runInDurableObject(stubFor(id), (_instance: RoomDO, state: DurableObjectState) => {
        seedOutboxRow(state, id, config);
      });

      await fireAlarm(id);

      await runInDurableObject(
        stubFor(id),
        async (_instance: RoomDO, state: DurableObjectState) => {
          expect(outboxCount(state)).toBe(1);

          // The load-bearing assertion: the alarm must have been pulled
          // in to the ~60s retry, not left at the far-future deadline. A
          // guard written `if (existing === null || retryAt < existing)`
          // with the comparison inverted (`existing < retryAt`), or one
          // that only ever "skips" and never overwrites a later alarm,
          // would leave this at config.endsAtMs (a day out) and fail
          // these bounds.
          const alarmAt = await state.storage.getAlarm();
          expect(alarmAt).not.toBeNull();
          expect(alarmAt!).toBeLessThan(config.endsAtMs);
          const now = Date.now();
          expect(alarmAt!).toBeGreaterThanOrEqual(now + 55_000);
          expect(alarmAt!).toBeLessThanOrEqual(now + 65_000);
        }
      );
    }
  );
});
