import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Countdown, formatRemaining } from "./Countdown";

describe("formatRemaining", () => {
  it("formats minutes and seconds", () => {
    expect(formatRemaining(95_000)).toBe("1:35");
  });

  it("pads seconds", () => {
    expect(formatRemaining(65_000)).toBe("1:05");
  });

  it("floors to zero rather than going negative", () => {
    expect(formatRemaining(-5_000)).toBe("0:00");
  });
});

describe("Countdown", () => {
  it("renders the remaining time", () => {
    render(<Countdown msRemaining={95_000} />);
    expect(screen.getByText("1:35")).toBeInTheDocument();
  });

  it("marks itself urgent inside the final ten seconds", () => {
    render(<Countdown msRemaining={5_000} />);
    expect(screen.getByRole("timer")).toHaveAttribute("data-urgent", "true");
  });

  // Beyond the brief: the "urgent" test above only exercises the true
  // branch. Without this, an implementation that is *always* urgent (e.g.
  // `data-urgent="true"` unconditionally) would pass every test in this
  // file. This pins the boundary is real by checking just outside it.
  it("is not urgent just outside the final ten seconds", () => {
    render(<Countdown msRemaining={10_001} />);
    expect(screen.getByRole("timer")).toHaveAttribute("data-urgent", "false");
  });
});
