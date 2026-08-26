import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Latency, describeSkew } from "./Latency";

describe("describeSkew", () => {
  it("reports a small offset as synced", () => {
    expect(describeSkew(40)).toMatch(/synced/i);
  });

  it("reports a large positive offset in milliseconds", () => {
    expect(describeSkew(1_500)).toMatch(/1500\s*ms/);
  });

  it("uses the magnitude, not the sign, for a negative offset", () => {
    expect(describeSkew(-1_500)).toMatch(/1500\s*ms/);
  });

  // Boundary tests pinning the 250ms threshold exactly.
  // Changing `<=` to `<` in the implementation will fail these.
  it("reports exactly 250ms (threshold) as synced", () => {
    expect(describeSkew(250)).toMatch(/synced/i);
  });

  it("reports exactly 251ms (above threshold) as not synced", () => {
    expect(describeSkew(251)).toMatch(/251\s*ms/);
  });

  it("reports exactly -250ms (negative threshold) as synced", () => {
    expect(describeSkew(-250)).toMatch(/synced/i);
  });

  it("reports exactly -251ms (negative above threshold) as not synced", () => {
    expect(describeSkew(-251)).toMatch(/251\s*ms/);
  });
});

describe("Latency", () => {
  it("renders the clock status", () => {
    render(<Latency offsetMs={20} />);
    expect(screen.getByTestId("latency")).toHaveTextContent(/synced/i);
  });

  // Beyond the brief: pins that a large offset actually reaches the
  // rendered component (not just the pure `describeSkew` helper), so a
  // `Latency` that ignores its prop and always renders "synced" would not
  // pass.
  it("renders a large offset through to the DOM", () => {
    render(<Latency offsetMs={1_500} />);
    expect(screen.getByTestId("latency")).toHaveTextContent(/1500\s*ms/);
  });
});
