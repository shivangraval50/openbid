import { describe, it, expect } from "vitest";
import { PROTOCOL_VERSION } from "./index.js";

describe("workspace wiring", () => {
  it("exposes a protocol version", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
