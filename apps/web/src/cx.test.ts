import { describe, it, expect } from "vitest";
import { cx } from "./cx";

describe("cx", () => {
  it("joins the names it is given", () => {
    expect(cx("a", "b")).toBe("a b");
  });

  // The actual reason this function exists: a CSS-module lookup is typed
  // `string | undefined` under `noUncheckedIndexedAccess`, and a template
  // literal would render the missing one as the class name "undefined".
  it("drops an undefined class rather than stringifying it", () => {
    expect(cx("a", undefined, "b")).toBe("a b");
  });

  it("drops a conditional that resolved to false", () => {
    expect(cx("a", false && "b")).toBe("a");
  });

  it("drops the empty string, so no double space is emitted", () => {
    expect(cx("a", "", "b")).toBe("a b");
  });

  it("returns an empty string when nothing survives", () => {
    expect(cx(undefined, false, "")).toBe("");
  });
});
