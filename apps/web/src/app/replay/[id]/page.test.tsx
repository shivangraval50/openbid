import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const fetchArchivedAuction = vi.fn();
const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});

// Scrubber itself is a client component covered by Scrubber.test.tsx; this
// file's only concern is the SERVER component's wiring -- what props
// ReplayPage passes down and when it calls notFound -- so Scrubber is
// replaced with a stand-in that just records what it received.
const scrubberProps = vi.fn();
vi.mock("./Scrubber", () => ({
  Scrubber: (props: unknown) => {
    scrubberProps(props);
    return null;
  },
}));
vi.mock("@/lib/replay", () => ({ fetchArchivedAuction }));
vi.mock("next/navigation", () => ({ notFound }));

const { default: ReplayPage } = await import("./page");

const archived = {
  itemName: "A rare compiler",
  startingPrice: 100,
  winningPrice: 400,
  winnerNickname: "ada",
  bidLog: [
    { type: "joined", participantId: "ada", nickname: "ada", persistent: false, atMs: 0 },
    { type: "bidPlaced", participantId: "ada", amount: 400, atMs: 10, newEndsAtMs: 20_000 },
    { type: "closed", atMs: 30, winner: { participantId: "ada", amount: 400 } },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ReplayPage", () => {
  it("calls notFound instead of rendering the Scrubber when there is no archived auction", async () => {
    fetchArchivedAuction.mockResolvedValue(null);

    await expect(
      ReplayPage({ params: Promise.resolve({ id: "missing-room" }) })
    ).rejects.toThrow(/NEXT_NOT_FOUND/);

    expect(scrubberProps).not.toHaveBeenCalled();
  });

  // The regression this pins: the config built for replay must carry the
  // archive's own item name and starting price through to the Scrubber,
  // and the archived bid log unchanged (not re-wrapped, not truncated).
  // A version that dropped `bidLog` or hardcoded a placeholder config
  // would fail the property assertions below.
  it("passes the archived bid log and a permissive config down to the Scrubber", async () => {
    fetchArchivedAuction.mockResolvedValue(archived);

    await renderToStaticMarkup(
      await ReplayPage({ params: Promise.resolve({ id: "room-1" }) })
    );

    expect(scrubberProps).toHaveBeenCalledTimes(1);
    const props = scrubberProps.mock.calls[0]?.[0] as {
      events: unknown[];
      config: { itemName: string; startingPrice: number; minIncrement: number; endsAtMs: number };
    };
    expect(props.events).toEqual(archived.bidLog);
    expect(props.config.itemName).toBe("A rare compiler");
    expect(props.config.startingPrice).toBe(100);
    // Permissive by design -- see replay.ts and page.tsx's own comment:
    // replay only ever calls `reduce`, never `validateBid`, so these
    // values cannot affect the replayed outcome.
    expect(props.config.minIncrement).toBe(0);
    expect(props.config.endsAtMs).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("renders the archived item name as the page heading", async () => {
    fetchArchivedAuction.mockResolvedValue(archived);

    const html = renderToStaticMarkup(
      await ReplayPage({ params: Promise.resolve({ id: "room-1" }) })
    );

    expect(html).toContain("A rare compiler");
  });
});
