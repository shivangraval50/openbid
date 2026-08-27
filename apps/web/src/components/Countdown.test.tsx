import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  Countdown,
  extensionDeltaMs,
  formatExtension,
  formatRemaining,
} from "./Countdown";

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

describe("extensionDeltaMs", () => {
  it("reports the gain when the deadline moves later", () => {
    expect(extensionDeltaMs(1_000, 16_000)).toBe(15_000);
  });

  it("reports nothing when the deadline has not moved", () => {
    expect(extensionDeltaMs(1_000, 1_000)).toBeNull();
  });

  // A reconnecting client rebases on a server snapshot and can legitimately
  // see an EARLIER endsAtMs than the one it was holding. Reporting that as
  // an extension would announce "the deadline was extended by -3 seconds".
  it("reports nothing when the deadline moves earlier", () => {
    expect(extensionDeltaMs(16_000, 1_000)).toBeNull();
  });
});

describe("formatExtension", () => {
  it("renders whole seconds with a leading plus", () => {
    expect(formatExtension(15_000)).toBe("+15s");
  });

  // Rounds UP, so a sub-second extension reads as "+1s" rather than the
  // meaningless "+0s".
  it("rounds a partial second up", () => {
    expect(formatExtension(1)).toBe("+1s");
  });
});

describe("Countdown extension badge", () => {
  it("says nothing about an extension when there has not been one", () => {
    render(<Countdown msRemaining={95_000} />);
    expect(screen.queryByText(/anti-snipe/i)).not.toBeInTheDocument();
  });

  it("names both the size and the reason when the deadline jumps", () => {
    render(<Countdown msRemaining={95_000} extendedByMs={15_000} />);
    expect(screen.getByText("+15s")).toBeInTheDocument();
    expect(screen.getByText(/anti-snipe extension/i)).toBeInTheDocument();
  });

  // The room page has exactly one role="status" (ConnectionBanner) and
  // e2e/reconnect.spec.ts asserts on that single match. A live region here
  // would make `getByRole("status")` ambiguous and break it.
  it("does not introduce a second status role", () => {
    const { container } = render(<Countdown msRemaining={5_000} extendedByMs={15_000} />);
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector("[aria-live]:not([aria-live='off'])")).toBeNull();
  });
});
