import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const topBidders = vi.fn();
vi.mock("@/lib/leaderboard", () => ({ topBidders }));

const { default: LeaderboardPage } = await import("./page");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("LeaderboardPage", () => {
  // The direct realization of Requirement 4 at the component the
  // requirement is actually about (topBidders.test.ts already proves
  // the function boundary never rejects; this proves the PAGE renders
  // correctly when it doesn't).
  it("renders the empty state when there are no completed auctions", async () => {
    topBidders.mockResolvedValue([]);

    const html = renderToStaticMarkup(await LeaderboardPage());

    expect(html).toContain("No completed auctions yet.");
    expect(html).not.toContain("<ol");
  });

  // This is the actual regression the page's own try/catch exists to
  // prevent: `topBidders()`'s contract is to never reject, but that
  // contract lives in a different file. If `topBidders` were mocked to
  // reject here and the page had no defense of its own, `await
  // topBidders()` would throw out of this async Server Component and
  // Next would show an error page -- not "an empty leaderboard" as
  // Requirement 4 requires. Deleting the page's try/catch (see the
  // report for the mutation run) makes this fail with the rejection
  // propagating instead of resolving to the empty-state markup.
  it("renders the empty state instead of throwing when topBidders rejects", async () => {
    topBidders.mockRejectedValue(new Error("connection refused"));

    const html = renderToStaticMarkup(await LeaderboardPage());

    expect(html).toContain("No completed auctions yet.");
  });

  it("renders each bidder's nickname and win count when there are completed auctions", async () => {
    topBidders.mockResolvedValue([
      { nickname: "grace", wins: 3, overpay: 500 },
      { nickname: "ada", wins: 1, overpay: 0 },
    ]);

    const html = renderToStaticMarkup(await LeaderboardPage());

    expect(html).toContain("grace");
    expect(html).toContain("3");
    expect(html).toContain("wins");
    expect(html).toContain("ada");
    expect(html).toContain("1");
    expect(html).toContain("win<"); // singular for a count of 1
    expect(html).not.toContain("No completed auctions yet.");
  });
});
