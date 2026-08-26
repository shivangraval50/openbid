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
});
