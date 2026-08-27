import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BidForm } from "./BidForm";

describe("BidForm", () => {
  it("prefills the minimum acceptable bid", () => {
    render(<BidForm minimum={110} disabled={false} rejectReason={null} onBid={vi.fn()} />);
    expect(screen.getByLabelText(/your bid/i)).toHaveValue(110);
  });

  it("submits the entered amount", async () => {
    const onBid = vi.fn();
    render(<BidForm minimum={100} disabled={false} rejectReason={null} onBid={onBid} />);

    const input = screen.getByLabelText(/your bid/i);
    await userEvent.clear(input);
    await userEvent.type(input, "250");
    await userEvent.click(screen.getByRole("button", { name: /place bid/i }));

    expect(onBid).toHaveBeenCalledWith(250);
  });

  it("blocks submission below the minimum without calling onBid", async () => {
    const onBid = vi.fn();
    render(<BidForm minimum={100} disabled={false} rejectReason={null} onBid={onBid} />);

    const input = screen.getByLabelText(/your bid/i);
    await userEvent.clear(input);
    await userEvent.type(input, "50");
    await userEvent.click(screen.getByRole("button", { name: /place bid/i }));

    expect(onBid).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/at least 100/i);
  });

  it("disables the control when the auction is closed", () => {
    render(<BidForm minimum={100} disabled rejectReason={null} onBid={vi.fn()} />);
    expect(screen.getByRole("button", { name: /place bid/i })).toBeDisabled();
  });

  it("shows a specific message for each reject reason", () => {
    const { rerender } = render(
      <BidForm minimum={100} disabled={false} rejectReason="TOO_LOW" onBid={vi.fn()} />
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/outbid/i);

    rerender(
      <BidForm minimum={100} disabled={false} rejectReason="INSUFFICIENT_BUDGET" onBid={vi.fn()} />
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/budget/i);

    rerender(
      <BidForm minimum={100} disabled={false} rejectReason="RATE_LIMITED" onBid={vi.fn()} />
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/too fast/i);

    rerender(
      <BidForm minimum={100} disabled={false} rejectReason="AUCTION_CLOSED" onBid={vi.fn()} />
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/closed/i);
  });

  // Beyond the brief: pins the "don't fight the user mid-edit" behaviour
  // called out explicitly in the task's constraints. Without this test,
  // an effect that always resyncs to the new minimum on every prop change
  // (fighting the user while they type) would pass every test above (none
  // of them change `minimum` after mount) yet violate the requirement.
  it("does not clobber a user-entered value that is still valid when the minimum rises", async () => {
    const { rerender } = render(
      <BidForm minimum={100} disabled={false} rejectReason={null} onBid={vi.fn()} />
    );
    const input = screen.getByLabelText(/your bid/i);
    // Simulate the user having typed a value comfortably above both the
    // old and new minimum.
    await userEvent.clear(input);
    await userEvent.type(input, "500");

    rerender(<BidForm minimum={120} disabled={false} rejectReason={null} onBid={vi.fn()} />);
    expect(screen.getByLabelText(/your bid/i)).toHaveValue(500);
  });

  // Beyond the brief: the mirror image of the above. When the field still
  // holds the *old, now-stale* minimum (the user never touched it), a
  // rising minimum must resync it forward -- otherwise a bid at the old
  // minimum would be rejected as TOO_LOW despite the UI looking valid.
  it("resyncs the field when it still holds the previous (now stale) minimum", () => {
    const { rerender } = render(
      <BidForm minimum={100} disabled={false} rejectReason={null} onBid={vi.fn()} />
    );
    rerender(<BidForm minimum={120} disabled={false} rejectReason={null} onBid={vi.fn()} />);
    expect(screen.getByLabelText(/your bid/i)).toHaveValue(120);
  });

  // This is the actual case the "don't fight the user mid-edit" requirement
  // names, and the case a naive `Number(current) < props.minimum` check
  // does NOT cover: a half-typed replacement value that happens to look
  // numerically low. The user means to type "500" but has only typed "5"
  // so far when a rival bid lifts the minimum past it -- a comparison
  // against the *new* minimum alone can't tell "half-typed" from "stale",
  // and would destroy the in-progress keystroke.
  it("does not clobber a half-typed replacement value, even though it now looks too low", async () => {
    const { rerender } = render(
      <BidForm minimum={120} disabled={false} rejectReason={null} onBid={vi.fn()} />
    );
    const input = screen.getByLabelText(/your bid/i);
    await userEvent.clear(input);
    await userEvent.type(input, "5"); // still typing toward "500"

    rerender(<BidForm minimum={130} disabled={false} rejectReason={null} onBid={vi.fn()} />);
    expect(screen.getByLabelText(/your bid/i)).toHaveValue(5);
  });

  // The other example the requirement calls out: a deliberately cleared
  // field. `Number("") === 0`, so the same naive `<` comparison would treat
  // an empty field as "stale" and refill it against the user's intent.
  it("does not refill a deliberately cleared field", async () => {
    const { rerender } = render(
      <BidForm minimum={120} disabled={false} rejectReason={null} onBid={vi.fn()} />
    );
    const input = screen.getByLabelText(/your bid/i);
    await userEvent.clear(input);

    rerender(<BidForm minimum={130} disabled={false} rejectReason={null} onBid={vi.fn()} />);
    expect(screen.getByLabelText(/your bid/i)).toHaveValue(null);
  });
});

// Guards a contract that lives in another suite: e2e/simultaneous-bid.spec.ts
// tells "the DO adjudicated this pair and rejected one" apart from "one client
// independently guessed it would lose and never asked" by comparing this
// element's text to the server copy with EXACT string equality (via
// `allTextContents()`, which does not normalise whitespace). A decorative
// glyph, an icon character, or a stray space inside the <p role="alert">
// would silently make that e2e assertion unsatisfiable, and nothing in this
// unit suite's `toHaveTextContent` substring checks would notice.
describe("BidForm rejection alert text", () => {
  const SERVER_REJECT_TEXT = "You were outbid — the price moved while you were typing.";

  it("renders the server's rejection copy as the alert's entire text content", () => {
    render(<BidForm minimum={100} disabled={false} rejectReason="TOO_LOW" onBid={() => {}} />);
    expect(screen.getByRole("alert").textContent).toBe(SERVER_REJECT_TEXT);
  });

  it("renders the local minimum-check copy as the alert's entire text content", async () => {
    render(<BidForm minimum={100} disabled={false} rejectReason={null} onBid={() => {}} />);
    const input = screen.getByLabelText(/your bid/i);
    await userEvent.clear(input);
    await userEvent.type(input, "5");
    await userEvent.click(screen.getByRole("button", { name: /place bid/i }));
    expect(screen.getByRole("alert").textContent).toBe("Bid must be at least 100.");
  });

  // The alert must live inside the <form>: the e2e helper scopes to
  // `form p[role="alert"]` precisely because Next's App Router injects its own
  // offscreen route announcer, which is also role="alert", on every page.
  it("keeps the alert inside the form element", () => {
    const { container } = render(
      <BidForm minimum={100} disabled={false} rejectReason="TOO_LOW" onBid={() => {}} />
    );
    expect(container.querySelector('form p[role="alert"]')).not.toBeNull();
  });
});
