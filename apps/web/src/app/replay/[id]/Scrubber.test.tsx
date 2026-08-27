import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { AuctionConfig, AuctionEvent } from "@openbid/auction-core";
import { Scrubber } from "./Scrubber";

const config: AuctionConfig = {
  itemName: "scrubber-test",
  startingPrice: 100,
  minIncrement: 0,
  startingBudget: Number.MAX_SAFE_INTEGER,
  antiSnipeWindowMs: 0,
  antiSnipeExtensionMs: 0,
  endsAtMs: Number.MAX_SAFE_INTEGER,
};

const events: AuctionEvent[] = [
  { type: "joined", participantId: "ada", nickname: "ada", atMs: 0 },
  { type: "joined", participantId: "grace", nickname: "grace", atMs: 0 },
  { type: "bidPlaced", participantId: "ada", amount: 100, atMs: 10, newEndsAtMs: 20_000 },
  { type: "bidPlaced", participantId: "grace", amount: 150, atMs: 20, newEndsAtMs: 30_000 },
  { type: "closed", atMs: 40, winner: { participantId: "grace", amount: 150 } },
];

describe("Scrubber", () => {
  // Default position: the brief specifies `useState(events.length)`, i.e.
  // the scrubber opens showing the final, settled state -- not the
  // auction's start. A version that defaulted to 0 would show the
  // starting price and "open" here instead.
  it("defaults to the end of the log, showing the final settled state", () => {
    render(<Scrubber config={config} events={events} />);
    expect(screen.getByTestId("replay-price")).toHaveTextContent("150");
    expect(screen.getByTestId("replay-status")).toHaveTextContent("closed");
  });

  // The scrubber's whole point: dragging the range input must re-fold up
  // to that position via `replayTo`, not just relabel a fixed state. A
  // version that ignored the input's value (e.g. always rendered
  // `replayTo(config, events, events.length)`) would fail this by still
  // showing 150/closed after the change event.
  it("re-derives the displayed price and status when the scrub position changes", () => {
    render(<Scrubber config={config} events={events} />);

    // Position 3: two joins plus the first bid of 100; auction still open.
    fireEvent.change(screen.getByRole("slider"), { target: { value: "3" } });

    expect(screen.getByTestId("replay-price")).toHaveTextContent("100");
    expect(screen.getByTestId("replay-status")).toHaveTextContent("open");
  });

  // Position zero must show the starting price, not `null`/`undefined`
  // rendered as text and not the final price left over from a stale
  // render. This is the scrubber-level realization of `replayTo`'s own
  // "position zero is the initial state" guarantee.
  it("shows the starting price and open status at scrub position zero", () => {
    render(<Scrubber config={config} events={events} />);

    fireEvent.change(screen.getByRole("slider"), { target: { value: "0" } });

    expect(screen.getByTestId("replay-price")).toHaveTextContent("100");
    expect(screen.getByTestId("replay-status")).toHaveTextContent("open");
  });

  // The range input's own bounds must span the whole log, otherwise a
  // user could never scrub to intermediate or final positions at all.
  it("bounds the range input to the number of events", () => {
    render(<Scrubber config={config} events={events} />);
    const slider = screen.getByRole("slider");
    expect(slider).toHaveAttribute("min", "0");
    expect(slider).toHaveAttribute("max", String(events.length));
  });
});
