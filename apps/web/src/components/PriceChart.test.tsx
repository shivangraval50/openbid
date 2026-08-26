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
});
