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
});
