import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { initialState, type AuctionConfig, type AuctionState } from "@openbid/auction-core";
import { LiveRoom } from "./LiveRoom";

// Same minimal stub as socket.test.ts: LiveRoom's connect effect constructs
// a real `WebSocket`, which doesn't exist in jsdom. It's never opened in
// these tests, so it only needs to exist, not do anything.
class FakeWebSocket {
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  constructor(public url: string) {}
  send(): void {}
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
    participants: { me: { id: "me", nickname: "me", budget: 500 } },
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
      />
    );

    expect(screen.getByRole("button", { name: /place bid/i })).toBeDisabled();
    expect(screen.getByTestId("outcome")).toHaveTextContent(/won by me at 250/i);
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
});
