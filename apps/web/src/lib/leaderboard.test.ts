import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sql = vi.fn();
const neon = vi.fn(() => sql);

vi.mock("@neondatabase/serverless", () => ({ neon }));

const { rankBidders, topBidders } = await import("./leaderboard");

describe("rankBidders", () => {
  it("ranks by wins descending", () => {
    const ranked = rankBidders([
      { nickname: "ada", wins: 1, overpay: 0 },
      { nickname: "grace", wins: 3, overpay: 500 },
    ]);
    expect(ranked.map((r) => r.nickname)).toEqual(["grace", "ada"]);
  });

  it("breaks ties on lower total overpay", () => {
    const ranked = rankBidders([
      { nickname: "ada", wins: 2, overpay: 400 },
      { nickname: "grace", wins: 2, overpay: 100 },
    ]);
    expect(ranked.map((r) => r.nickname)).toEqual(["grace", "ada"]);
  });

  it("returns an empty list unchanged", () => {
    expect(rankBidders([])).toEqual([]);
  });

  // The two tests above each already have their expected order differ
  // from input order, so a no-op / identity function fails both. This
  // third case adds a THREE-row input where wins-descending alone gives
  // the wrong answer for the bottom two (a tie), pinning that the tie
  // break is applied within an otherwise-correct primary sort rather
  // than only on inputs of length 2.
  it("sorts by wins first, then applies the overpay tie-break only among equal-win rows", () => {
    const ranked = rankBidders([
      { nickname: "low-overpay-tie", wins: 2, overpay: 50 },
      { nickname: "champion", wins: 5, overpay: 9999 },
      { nickname: "high-overpay-tie", wins: 2, overpay: 900 },
    ]);
    expect(ranked.map((r) => r.nickname)).toEqual([
      "champion",
      "low-overpay-tie",
      "high-overpay-tie",
    ]);
  });

  // Guards against a mutation that never returns a new array reference
  // (e.g. an in-place `.sort()` on the caller's own array), which every
  // assertion above would still pass if it happened to mutate correctly
  // but which is a real interface hazard for callers like `topBidders`
  // that pass a freshly-fetched, otherwise-unshared array.
  it("does not mutate the input array", () => {
    const input = [
      { nickname: "ada", wins: 1, overpay: 0 },
      { nickname: "grace", wins: 3, overpay: 500 },
    ];
    const original = [...input];
    rankBidders(input);
    expect(input).toEqual(original);
  });
});

describe("topBidders", () => {
  const originalUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    neon.mockImplementation(() => sql);
  });

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  });

  // This is the graceful-degradation requirement: DATABASE_URL is
  // deliberately unset in tests (and may be unset in a deployment), and
  // the leaderboard is a read-only nicety that must never turn into a
  // 500 page over it.
  it("returns an empty list when DATABASE_URL is not configured", async () => {
    delete process.env.DATABASE_URL;

    await expect(topBidders()).resolves.toEqual([]);
    expect(neon).not.toHaveBeenCalled();
  });

  // Same requirement, the other failure shape: DATABASE_URL is present
  // but the query itself fails (network error, bad credentials, Postgres
  // outage). A version that only guarded the "unset" case, but let a
  // thrown/rejected query propagate, would fail this.
  it("returns an empty list when the query rejects, rather than throwing", async () => {
    process.env.DATABASE_URL = "postgres://example/db";
    sql.mockRejectedValue(new Error("connection refused"));

    await expect(topBidders()).resolves.toEqual([]);
  });

  // Same requirement, a third failure shape: neon() itself throws
  // synchronously (e.g. a malformed connection string), before any query
  // is even issued. A try/catch that only wraps the `await sql\`...\``
  // call and not the `neon(url)` call above it would still throw here.
  it("returns an empty list when constructing the client throws synchronously", async () => {
    process.env.DATABASE_URL = "not-a-valid-url";
    neon.mockImplementation(() => {
      throw new Error("invalid connection string");
    });

    await expect(topBidders()).resolves.toEqual([]);
  });

  // Proves the rows that come back from Postgres are actually re-ranked,
  // not just passed through in whatever order the SQL happened to
  // return. The mock returns them in the WRONG order (by overpay, not by
  // wins), so a version that returned `rows` directly instead of
  // `rankBidders(rows)` would fail this.
  it("re-ranks the rows returned by the query using rankBidders' ordering", async () => {
    process.env.DATABASE_URL = "postgres://example/db";
    sql.mockResolvedValue([
      { nickname: "ada", wins: 1, overpay: 0 },
      { nickname: "grace", wins: 3, overpay: 500 },
    ]);

    const result = await topBidders();

    expect(result.map((r) => r.nickname)).toEqual(["grace", "ada"]);
  });

  it("passes the limit through to the query", async () => {
    process.env.DATABASE_URL = "postgres://example/db";
    sql.mockResolvedValue([]);

    await topBidders(5);

    // The tagged-template call is `sql(strings, ...values)`; the limit
    // is the only interpolated value in the brief's query.
    expect(sql.mock.calls[0]?.[1]).toBe(5);
  });
});
