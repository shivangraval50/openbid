import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { initialState, type AuctionConfig, type AuctionState } from "@openbid/auction-core";
import { LiveRoom } from "./LiveRoom";

// Same minimal stub as socket.test.ts: LiveRoom's connect effect constructs
// a real `WebSocket`, which doesn't exist in jsdom. It's never opened in
// these tests, so it only needs to exist, not do anything.
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(): void {}
  // A no-op, deliberately: a real close is delivered asynchronously, and
  // the test below depends on firing `onclose` LATER than the cleanup that
  // requested it. Synchronous delivery here would hide the race.
  close(): void {}
}

const config: AuctionConfig = {
  itemName: "liveroom-test",
  startingPrice: 100,
  minIncrement: 10,
  startingBudget: 500,
  antiSnipeWindowMs: 10_000,
  antiSnipeExtensionMs: 15_000,
  endsAtMs: Date.now() + 60_000,
};

function seededState(overrides: Partial<AuctionState> = {}): AuctionState {
  return {
    ...initialState(config),
    participants: { me: { id: "me", nickname: "me", budget: 500, persistent: false } },
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  // jsdom has no real canvas backend; without this it falls back to a
  // "Not implemented" console warning on every render. PriceChart.test.tsx
  // stubs the same thing for the same reason.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  // Belt-and-braces alongside the in-test `vi.useRealTimers()` calls: if a
  // fake-timer test fails part-way through, its trailing restore never
  // runs and every later test in this file inherits frozen timers, which
  // makes `waitFor` hang for its full timeout and reports a cascade of
  // failures that have nothing to do with the real defect. Observed
  // exactly that while mutation-testing the commentary wiring.
  vi.useRealTimers();
});

describe("LiveRoom", () => {
  // This is the actual regression test for "SSR renders Loading… instead
  // of the seeded snapshot": seeding must happen synchronously during
  // render (inside the store-creating `useMemo`), not in a `useEffect`,
  // because `renderToStaticMarkup` never runs effects at all. If seeding
  // were still effect-based, `server` would be `null` on this render and
  // the component would emit the "Loading…" placeholder instead -- which
  // is exactly what shipped before this fix.
  it("renders the seeded price directly in server-rendered markup, with no client effects run", () => {
    const markup = renderToStaticMarkup(
      <LiveRoom
        roomId="room-1"
        initialSeq={4}
        initialServerTime={1_000}
        initialState={seededState()}
        socketBaseUrl="http://localhost:8787"
        itemName="liveroom-test"
      />
    );

    expect(markup).not.toContain("Loading");
    expect(markup).toContain('data-testid="display-price"');
    // No bids yet, so the displayed price is the starting price.
    expect(markup).toMatch(/data-testid="display-price">100</);
  });

  it("disables the bid form and shows the resolved winner once the auction is closed", () => {
    render(
      <LiveRoom
        roomId="room-2"
        initialSeq={9}
        initialServerTime={1_000}
        initialState={seededState({
          status: "closed",
          highBid: { participantId: "me", amount: 250, atMs: 1_000 },
          winner: { participantId: "me", amount: 250 },
        })}
        socketBaseUrl="http://localhost:8787"
        itemName="liveroom-test"
      />
    );

    expect(screen.getByRole("button", { name: /place bid/i })).toBeDisabled();
    expect(screen.getByTestId("outcome")).toHaveTextContent(/won by me at 250/i);
  });

  // Minor from review: every `hello` on a fresh socket mints a new
  // participantId and appends another `joined` event, and nothing ever
  // removes a participant -- so one person who reconnected twice used to
  // read as three "Bidders". The state below is exactly what the DO holds
  // after that: three participant records, two of them the same person.
  // `Object.keys(server.participants).length` reports 3 and fails this.
  // Catches: a superseded connection's late `onclose` overwriting the live
  // connection's "open" status, which pinned the room at "Disconnected."
  // forever while the replacement socket sat there connected and healthy.
  //
  // Reproduces the real interleaving, which is only possible because a close
  // is delivered asynchronously: the effect re-runs and closes A, B opens and
  // reports "open", and only THEN does A's queued `onclose` land.
  it("ignores a superseded connection's close after its replacement is open", () => {
    FakeWebSocket.instances = [];
    const { rerender } = render(
      <LiveRoom
        roomId="room-race"
        initialSeq={1}
        initialServerTime={1_000}
        initialState={seededState()}
        socketBaseUrl="http://ws.test"
        nickname="ada"
        persistent={false}
      />
    );

    const first = FakeWebSocket.instances[0]!;
    act(() => first.onopen?.());
    expect(screen.queryByText(/Disconnected/i)).toBeNull();

    // Changing a dependency re-runs the connect effect: cleanup closes A,
    // then a second socket is constructed.
    rerender(
      <LiveRoom
        roomId="room-race"
        initialSeq={1}
        initialServerTime={1_000}
        initialState={seededState()}
        socketBaseUrl="http://ws.test"
        nickname="ada-renamed"
        persistent={false}
      />
    );
    const second = FakeWebSocket.instances[1]!;
    expect(second).not.toBe(first);
    act(() => second.onopen?.());

    // A's close arrives last. It must not be allowed to speak for the room.
    act(() => first.onclose?.());

    expect(screen.queryByText(/Disconnected/i)).toBeNull();
  });

  it("counts distinct bidders by nickname, so one person's reconnects are not three bidders", () => {
    render(
      <LiveRoom
        roomId="room-3"
        initialSeq={4}
        initialServerTime={1_000}
        initialState={seededState({
          participants: {
            "conn-1": { id: "conn-1", nickname: "brisk-otter-7f3", budget: 500, persistent: false },
            "conn-2": { id: "conn-2", nickname: "brisk-otter-7f3", budget: 500, persistent: false },
            "conn-3": { id: "conn-3", nickname: "octocat", budget: 500, persistent: true },
          },
        })}
        socketBaseUrl="http://localhost:8787"
        itemName="liveroom-test"
      />
    );

    // Two real people, three connections.
    expect(screen.getByText("Bidders").nextElementSibling).toHaveTextContent("2");
  });

  // Functional consequence of fix #1 (routing `selectMsRemaining`/
  // `selectServerNow` through plain `store.getState()` calls rather than
  // `useSyncExternalStore`): the countdown must still visibly update as
  // server-corrected time elapses, driven by the 250ms `forceTick`. This
  // closes a real gap -- nothing previously exercised the countdown
  // actually changing over time under `LiveRoom` -- though see the task
  // report for why this test alone can't *distinguish* the fixed routing
  // from the buggy one (both update the displayed value correctly; the
  // bug's actual defect is a React-internal double-render/warning that
  // could not be reliably reproduced under jsdom in either direction, see
  // report for what was tried).
  it("the countdown decreases as server-corrected time elapses", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    render(
      <LiveRoom
        roomId="room-4"
        initialSeq={1}
        initialServerTime={0}
        initialState={seededState({ endsAtMs: 10_000 })}
        socketBaseUrl="http://localhost:8787"
        itemName="liveroom-test"
      />
    );

    const before = screen.getByRole("timer").textContent;
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    const after = screen.getByRole("timer").textContent;

    expect(before).toBe("0:10");
    expect(after).toBe("0:05");

    vi.useRealTimers();
  });

  // Task 19: `/api/bot` had no caller at all before this. These tests are
  // about the WIRING -- that the room actually asks for commentary, with
  // the right outcome, only once the server has closed the auction.
  // `Commentary.test.tsx` covers the component's own behaviour (every
  // degradation path, the request shape, the fire-once guarantee).
  describe("post-settlement commentary", () => {
    function stubBot(response: Response | Error): ReturnType<typeof vi.fn> {
      const fetchMock = vi.fn(
        response instanceof Error ? () => Promise.reject(response) : () => Promise.resolve(response)
      );
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    function botResponse(text: string): Response {
      return new Response(JSON.stringify({ text, provider: "gemini" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    it("requests and displays commentary once the auction has closed", async () => {
      const fetchMock = stubBot(botResponse("Sold to me for 250. Briskly done."));

      render(
        <LiveRoom
          roomId="room-5"
          initialSeq={9}
          initialServerTime={1_000}
          initialState={seededState({
            status: "closed",
            highBid: { participantId: "me", amount: 250, atMs: 1_000 },
            winner: { participantId: "me", amount: 250 },
          })}
          socketBaseUrl="http://localhost:8787"
          itemName="liveroom-test"
        />
      );

      expect(await screen.findByTestId("commentary")).toHaveTextContent(
        "Sold to me for 250. Briskly done."
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/bot");
      // The winner is reported by NICKNAME, resolved out of
      // `state.participants` -- never as the per-connection
      // `participantId`, which is meaningless to a reader and is
      // reassigned on every reconnect.
      expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
        itemName: "liveroom-test",
        winner: "me",
        price: 250,
      });
    });

    // The countdown reaching zero is NOT settlement: the room is closed by
    // the DO's alarm, whose `closed` event arrives one round trip later,
    // and `winner` is still null in between. Requesting on the local
    // countdown instead of on the server's `status` would spend a provider
    // call describing an auction that closed "with no bids" moments before
    // the real winner landed -- and then spend a second one when it did.
    //
    // Fake timers, and `initialServerTime` well past `endsAtMs`, are both
    // load-bearing. The store's clock is server-corrected: `selectServerNow`
    // returns `Date.now() + (initialServerTime - Date.now())`, i.e. roughly
    // `initialServerTime`, NOT the local wall clock. An earlier draft of
    // this test set `endsAtMs: Date.now() - 1_000` with
    // `initialServerTime: 1_000`, which made `msRemaining` about 1.8e12 ms
    // -- the countdown never reached zero at all, so the test asserted
    // nothing and passed even with `settled` deliberately mis-wired to
    // `closed` (verified by making that exact mutation). The `0:00`
    // assertion below is what pins the precondition down: with
    // `settled = closed`, the fetch assertion after it fails.
    it("does not request commentary merely because the countdown reached zero", () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const fetchMock = stubBot(botResponse("premature"));

      render(
        <LiveRoom
          roomId="room-6"
          initialSeq={3}
          initialServerTime={20_000}
          initialState={seededState({
            status: "open",
            endsAtMs: 10_000,
            highBid: { participantId: "me", amount: 180, atMs: 900 },
          })}
          socketBaseUrl="http://localhost:8787"
          itemName="liveroom-test"
        />
      );

      // Precondition: the countdown really has run out.
      expect(screen.getByRole("timer")).toHaveTextContent("0:00");
      // But the server has not said `closed`, so no commentary was
      // requested. `Commentary` calls `fetch` synchronously inside its
      // effect, which `render` has already flushed -- so this is a real
      // check, not a race.
      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.queryByTestId("commentary")).not.toBeInTheDocument();

      vi.useRealTimers();
    });

    it("still renders the auction outcome when commentary fails outright", async () => {
      const fetchMock = stubBot(new TypeError("Failed to fetch"));

      render(
        <LiveRoom
          roomId="room-7"
          initialSeq={9}
          initialServerTime={1_000}
          initialState={seededState({
            status: "closed",
            highBid: { participantId: "me", amount: 250, atMs: 1_000 },
            winner: { participantId: "me", amount: 250 },
          })}
          socketBaseUrl="http://localhost:8787"
          itemName="liveroom-test"
        />
      );

      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(screen.getByTestId("outcome")).toHaveTextContent(/won by me at 250/i);
      expect(screen.queryByTestId("commentary")).not.toBeInTheDocument();
    });
  });
});
