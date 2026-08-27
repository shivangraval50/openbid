// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { PriceChart } from "./PriceChart";

describe("PriceChart", () => {
  it("mounts without a 2d context available (jsdom) and does not throw", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    expect(() => render(<PriceChart price={100} serverNow={1_000} />)).not.toThrow();
  });

  it("renders a canvas with an accessible label", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const { getByLabelText } = render(<PriceChart price={100} serverNow={1_000} />);
    expect(getByLabelText(/price over time/i)).toBeInTheDocument();
  });

  // Catches: pushing/rendering a point on every `serverNow` change (i.e.
  // every re-render, since the countdown's 250ms tick forces one) rather
  // than only on a genuine `price` change. `render()` calls
  // `canvas.getContext("2d")` exactly once per push+render cycle, so
  // counting calls to the (already-mocked) `getContext` is a direct proxy
  // for how many times that cycle actually ran.
  it("pushes a point only when price changes, not on every serverNow tick", () => {
    const getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(null);

    const { rerender } = render(<PriceChart price={100} serverNow={1_000} />);
    const callsAfterMount = getContextSpy.mock.calls.length;

    // serverNow ticks (as it does every 250ms from LiveRoom's countdown
    // timer) but price does not move.
    rerender(<PriceChart price={100} serverNow={2_000} />);
    expect(getContextSpy.mock.calls.length).toBe(callsAfterMount);
    rerender(<PriceChart price={100} serverNow={3_000} />);
    expect(getContextSpy.mock.calls.length).toBe(callsAfterMount);

    // A genuine price change must still push exactly one more point.
    rerender(<PriceChart price={105} serverNow={4_000} />);
    expect(getContextSpy.mock.calls.length).toBe(callsAfterMount + 1);
  });

  // Catches: a regression that always renders the "no change" copy (i.e.
  // `hasMoved` wired to always be false, or the opening price never
  // captured), which would ship green under the two tests above since
  // neither one inspects the wording once the price has actually moved.
  it("switches the caption and label to the opened/now wording once the price moves", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);

    const { getByLabelText, getByText, queryByText, rerender } = render(
      <PriceChart price={100} serverNow={1_000} />,
    );

    // Before any push beyond the mount point, the component must still be
    // in the "no change" state: the placeholder paragraph is present and
    // the label says nothing has moved.
    expect(
      getByLabelText("Price over time. No change since this page opened; the price is 100."),
    ).toBeInTheDocument();
    expect(queryByText("No change since you opened this page.")).not.toBeNull();

    // A genuine price change.
    rerender(<PriceChart price={105} serverNow={2_000} />);

    // The label must now report the opening price and the new price, not
    // the static "no change" copy.
    expect(
      getByLabelText("Price over time. Opened at 100, now 105."),
    ).toBeInTheDocument();
    // The placeholder paragraph must be gone, and the opening -> now range
    // must be printed in the caption.
    expect(queryByText("No change since you opened this page.")).toBeNull();
    expect(getByText("100")).toBeInTheDocument();
    expect(getByText("105")).toBeInTheDocument();
  });
});
