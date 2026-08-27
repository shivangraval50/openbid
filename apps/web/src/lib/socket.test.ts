import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { initialState, type AuctionConfig, type AuctionState } from "@openbid/auction-core";
import { createAuctionStore } from "@openbid/store";
import { encode } from "@openbid/protocol";
import { backoffMs, connectRoom } from "./socket";

describe("backoffMs", () => {
  it("starts at half a second", () => {
    expect(backoffMs(0)).toBe(500);
  });

  it("doubles per attempt", () => {
    expect(backoffMs(1)).toBe(1_000);
    expect(backoffMs(2)).toBe(2_000);
  });

  it("caps at thirty seconds", () => {
    expect(backoffMs(20)).toBe(30_000);
  });

  // Pins the exact crossover point rather than only a value far past the
  // cap. Catches an off-by-one in the cap threshold (e.g. capping starting
  // one attempt too early or late) that a single far-away assertion like
  // `backoffMs(20)` would not distinguish from the correct formula.
  it("pins the exact attempt where doubling would exceed the cap", () => {
    expect(backoffMs(5)).toBe(16_000); // 500 * 2**5, still under the cap
    expect(backoffMs(6)).toBe(30_000); // 500 * 2**6 = 32_000, clamped
  });
});

// A minimal stand-in for the browser WebSocket, giving tests direct control
// over the lifecycle events `connectRoom` wires up to. `send` just records
// what was sent so tests can inspect outgoing messages without a real
// socket; `triggerOpen`/`triggerMessage`/`triggerClose` are test-only hooks
// (not part of the real WebSocket API) that let a test play the server's
// side of the conversation.
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readonly OPEN = FakeWebSocket.OPEN;
  readonly CLOSED = FakeWebSocket.CLOSED;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  triggerOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  triggerMessage(raw: string): void {
    this.onmessage?.({ data: raw });
  }

  triggerClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  sentMessages(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

const config: AuctionConfig = {
  itemName: "socket-test",
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
    participants: { me: { id: "me", nickname: "me", budget: 500, persistent: false } },
  };
}

describe("connectRoom", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // Catches: a `hello` that omits `lastSeenSeq`, sends a hardcoded 0, or
  // otherwise doesn't reflect what the store actually holds at connect
  // time.
  it("sends hello with the store's current lastSeenSeq on open", () => {
    const store = createAuctionStore();
    store.getState().seedFromSnapshot(7, 1_000, seededState());
    connectRoom({ url: "ws://room", nickname: "alice", persistent: false, store, onStatus: vi.fn() });

    const ws = FakeWebSocket.instances[0]!;
    ws.triggerOpen();

    const hello = ws.sentMessages().find((m) => m.t === "hello");
    expect(hello).toMatchObject({ t: "hello", lastSeenSeq: 7, nickname: "alice" });
  });

  // The second link in the chain that ends at
  // `completed_auctions.winner_persistent`: RoomDO copies this straight
  // onto the room's `joined` event, so a hello that hardcoded `false` (or
  // omitted the field and let the schema default fill it in) would archive
  // every signed-in win as a guest's and quietly keep it off the
  // leaderboard.
  it("puts the caller's persistent flag on the hello", () => {
    const store = createAuctionStore();
    store.getState().seedFromSnapshot(1, 1_000, seededState());
    connectRoom({ url: "ws://room", nickname: "octocat", persistent: true, store, onStatus: vi.fn() });

    const ws = FakeWebSocket.instances[0]!;
    ws.triggerOpen();

    expect(ws.sentMessages().find((m) => m.t === "hello")).toMatchObject({
      nickname: "octocat",
      persistent: true,
    });
  });

  it("sends persistent: false for a guest", () => {
    const store = createAuctionStore();
    store.getState().seedFromSnapshot(1, 1_000, seededState());
    connectRoom({
      url: "ws://room",
      nickname: "brisk-otter-7f3",
      persistent: false,
      store,
      onStatus: vi.fn(),
    });

    const ws = FakeWebSocket.instances[0]!;
    ws.triggerOpen();

    expect(ws.sentMessages().find((m) => m.t === "hello")).toMatchObject({ persistent: false });
  });

  // This is Requirement 3's actual test: reading `lastSeenSeq` once at
  // `connectRoom()` call time (rather than fresh, inside `onopen`, on every
  // connection attempt) is exactly the bug the store's ack/delta ordering
  // fix was designed to make survivable -- and nothing catches a
  // regression back to it without a test that spans a reconnect. See the
  // task report for this test run against a deliberately-reintroduced
  // capture-at-call-time bug, RED before the fix, GREEN after.
  it("re-reads lastSeenSeq at each reconnect, not a value captured once at connect time", () => {
    const store = createAuctionStore();
    store.getState().seedFromSnapshot(1, 1_000, seededState());
    connectRoom({ url: "ws://room", nickname: "bob", persistent: false, store, onStatus: vi.fn() });

    const first = FakeWebSocket.instances[0]!;
    first.triggerOpen();

    // The store advances *after* the first connection is already open --
    // e.g. a delta arriving on this same connection.
    store.getState().applyServerMessage({
      t: "delta",
      seq: 5,
      serverTime: 1_100,
      event: {
        type: "bidPlaced",
        participantId: "me",
        amount: 300,
        atMs: 1_100,
        newEndsAtMs: 1_000_000,
      },
    });
    expect(store.getState().lastSeenSeq).toBe(5);

    first.triggerClose(); // schedules a reconnect at backoffMs(0) = 500ms
    vi.advanceTimersByTime(500);

    const second = FakeWebSocket.instances[1]!;
    second.triggerOpen();

    const hello = second.sentMessages().find((m) => m.t === "hello");
    expect(hello).toMatchObject({ lastSeenSeq: 5 });
  });

  // Catches: pings routed through `applyServerMessage` (which has a no-op
  // "pong" case and would silently never call `observeClock`, leaving the
  // client's clock offset stuck at 0 forever), or every message -- pong
  // included -- routed through `observeClock`.
  it("routes an incoming pong to observeClock, and every other message to applyServerMessage", () => {
    const store = createAuctionStore();
    store.getState().seedFromSnapshot(1, 1_000, seededState());
    const observeClockSpy = vi.spyOn(store.getState(), "observeClock");
    const applySpy = vi.spyOn(store.getState(), "applyServerMessage");

    connectRoom({ url: "ws://room", nickname: "carol", persistent: false, store, onStatus: vi.fn() });
    const ws = FakeWebSocket.instances[0]!;
    ws.triggerOpen();
    observeClockSpy.mockClear();
    applySpy.mockClear();

    ws.triggerMessage(encode({ t: "pong", clientTime: 100, serverTime: 200 }));
    expect(observeClockSpy).toHaveBeenCalledTimes(1);
    expect(observeClockSpy).toHaveBeenCalledWith(100, 200, expect.any(Number));
    expect(applySpy).not.toHaveBeenCalled();

    ws.triggerMessage(
      encode({
        t: "delta",
        seq: 2,
        serverTime: 1_100,
        event: {
          type: "bidPlaced",
          participantId: "other",
          amount: 150,
          atMs: 1_100,
          newEndsAtMs: 1_000_000,
        },
      })
    );
    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(observeClockSpy).toHaveBeenCalledTimes(1); // unchanged by the delta
  });

  // Minor from review: `parseServerMessage` was called outside any
  // try/catch, so a malformed frame threw inside `ws.onmessage` unhandled --
  // asymmetric with the DO's inbound path, which catches and closes with
  // 1003 rather than letting a throw tear down every socket in the room.
  // The store must be untouched and the connection must stay usable.
  it("drops a malformed frame instead of throwing out of onmessage", () => {
    const store = createAuctionStore();
    store.getState().seedFromSnapshot(4, 1_000, seededState());
    connectRoom({ url: "ws://room", nickname: "gil", persistent: false, store, onStatus: vi.fn() });
    const ws = FakeWebSocket.instances[0]!;
    ws.triggerOpen();

    expect(() => ws.triggerMessage("{{{ not json")).not.toThrow();
    expect(store.getState().lastSeenSeq).toBe(4);

    // Still live: a good frame after the bad one is still applied.
    ws.triggerMessage(
      encode({
        t: "delta",
        seq: 5,
        serverTime: 1_100,
        event: {
          type: "bidPlaced",
          participantId: "me",
          amount: 300,
          atMs: 1_100,
          newEndsAtMs: 1_000_000,
        },
      })
    );
    expect(store.getState().server?.highBid?.amount).toBe(300);
  });

  // The same guard, on the shape that only became reachable once
  // `snapshot.state`/`delta.event` were given real schemas instead of
  // `z.unknown()`: a well-formed envelope carrying a payload `reduce` would
  // not recognise. Before that change this frame parsed fine and the cast
  // fed it straight into `reduce`'s default-less switch.
  it("drops a well-formed envelope whose payload fails validation", () => {
    const store = createAuctionStore();
    store.getState().seedFromSnapshot(4, 1_000, seededState());
    connectRoom({ url: "ws://room", nickname: "hal", persistent: false, store, onStatus: vi.fn() });
    const ws = FakeWebSocket.instances[0]!;
    ws.triggerOpen();

    expect(() =>
      ws.triggerMessage(
        JSON.stringify({
          t: "delta",
          seq: 5,
          serverTime: 1_100,
          event: { type: "bidRetracted", participantId: "me", atMs: 1_100 },
        })
      )
    ).not.toThrow();
    expect(store.getState().lastSeenSeq).toBe(4);
    expect(store.getState().server?.highBid).toBeNull();
  });

  // Catches: `close()` leaving the 5s ping interval running (a leaked
  // timer that keeps sending on a socket the caller believes is dead) or
  // still scheduling a reconnect after an intentional, disposed close.
  it("close() stops the ping interval and does not reconnect", () => {
    const onStatus = vi.fn();
    const store = createAuctionStore();
    store.getState().seedFromSnapshot(1, 1_000, seededState());
    const conn = connectRoom({ url: "ws://room", nickname: "dan", persistent: false, store, onStatus });

    const ws = FakeWebSocket.instances[0]!;
    ws.triggerOpen();
    const sentBeforeClose = ws.sent.length;

    conn.close();
    vi.advanceTimersByTime(60_000);

    expect(ws.sent.length).toBe(sentBeforeClose); // no further pings
    expect(FakeWebSocket.instances.length).toBe(1); // no reconnect attempt
    expect(onStatus).toHaveBeenCalledWith("closed");
  });

  // Catches: reconnect scheduling that ignores `backoffMs` entirely (e.g.
  // a fixed delay, or immediate retry), or that doesn't advance `attempt`
  // between failures.
  it("increases the reconnect delay across consecutive failures, per backoffMs", () => {
    const store = createAuctionStore();
    store.getState().seedFromSnapshot(1, 1_000, seededState());
    connectRoom({ url: "ws://room", nickname: "erin", persistent: false, store, onStatus: vi.fn() });

    const first = FakeWebSocket.instances[0]!;
    first.triggerClose(); // never opened; still schedules a reconnect at backoffMs(0)

    vi.advanceTimersByTime(499);
    expect(FakeWebSocket.instances.length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances.length).toBe(2); // reconnected at 500ms

    const second = FakeWebSocket.instances[1]!;
    second.triggerClose(); // second consecutive failure -> backoffMs(1) = 1000ms

    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances.length).toBe(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances.length).toBe(3);
  });

  // Catches: dropping the immediate on-open ping (leaving the client on
  // its untrusted local clock until the first 5s interval tick).
  it("sends a ping immediately on open, not only on the 5s interval", () => {
    const store = createAuctionStore();
    store.getState().seedFromSnapshot(1, 1_000, seededState());
    connectRoom({ url: "ws://room", nickname: "fay", persistent: false, store, onStatus: vi.fn() });

    const ws = FakeWebSocket.instances[0]!;
    ws.triggerOpen();

    const pings = ws.sentMessages().filter((m) => m.t === "ping");
    expect(pings.length).toBe(1); // sent immediately, before any timer advances
  });
});
