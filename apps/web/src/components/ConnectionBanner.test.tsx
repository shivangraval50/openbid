import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConnectionBanner } from "./ConnectionBanner";

describe("ConnectionBanner", () => {
  it("says nothing when the socket is open", () => {
    const { container } = render(<ConnectionBanner status="open" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("warns that data may be stale while reconnecting", () => {
    render(<ConnectionBanner status="reconnecting" />);
    expect(screen.getByRole("status")).toHaveTextContent(/reconnect/i);
  });

  it("reports a closed connection", () => {
    render(<ConnectionBanner status="closed" />);
    expect(screen.getByRole("status")).toHaveTextContent(/disconnected/i);
  });

  // Beyond the brief's three cases: pins that "connecting" also renders
  // something (a role=status banner), rather than silently falling through
  // to the same "render nothing" branch as "open". Without this, swapping
  // the MESSAGES map's "connecting" entry for `null` would pass every test
  // the brief specifies.
  it("shows a status while the initial connection is being established", () => {
    render(<ConnectionBanner status="connecting" />);
    expect(screen.getByRole("status")).toHaveTextContent(/connect/i);
  });
});
