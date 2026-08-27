import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { initialState, type AuctionConfig } from "@openbid/auction-core";

const fetchSnapshot = vi.fn();
const resolveIdentity = vi.fn();
const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});

// LiveRoom itself opens a real WebSocket in an effect and is already
// covered by LiveRoom.test.tsx; this test's only concern is the SERVER
// component's wiring -- what props RoomPage passes down -- so LiveRoom is
// replaced with a stand-in that just records what it received.
const liveRoomProps = vi.fn();
vi.mock("./LiveRoom", () => ({
  LiveRoom: (props: unknown) => {
    liveRoomProps(props);
    return null;
  },
}));
vi.mock("@/lib/rooms", () => ({ fetchSnapshot }));
vi.mock("@/identity", () => ({ resolveIdentity }));
vi.mock("next/navigation", () => ({ notFound }));

const { default: RoomPage } = await import("./page");

const config: AuctionConfig = {
  itemName: "wiring-test item",
  startingPrice: 100,
  minIncrement: 10,
  startingBudget: 500,
  antiSnipeWindowMs: 10_000,
  antiSnipeExtensionMs: 15_000,
  endsAtMs: Date.now() + 60_000,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RoomPage", () => {
  // The regression this pins: LiveRoom accepts an optional `nickname`
  // prop but nothing passed it, so every participant connected as the
  // literal string "guest" (LiveRoom's own fallback) and the "Leader:"
  // line read "guest" for everyone. A version that reverted to the
  // pre-Task-15 page.tsx (which never imports or calls resolveIdentity)
  // fails this, because `liveRoomProps` would never receive a `nickname`
  // key at all.
  it("passes the resolved identity's nickname down to LiveRoom", async () => {
    fetchSnapshot.mockResolvedValue({
      seq: 3,
      serverTime: Date.now(),
      state: initialState(config),
    });
    resolveIdentity.mockResolvedValue({ nickname: "brisk-otter-7f3", persistent: false });

    await renderToStaticMarkup(
      await RoomPage({ params: Promise.resolve({ id: "room-1" }) })
    );

    expect(liveRoomProps).toHaveBeenCalledTimes(1);
    const props = liveRoomProps.mock.calls[0]?.[0] as { nickname?: string };
    expect(props.nickname).toBe("brisk-otter-7f3");
  });

  // A signed-in bidder's persistent GitHub nickname must reach the room
  // exactly the same way a guest's does -- there is no separate code
  // path in LiveRoom for the two, by design (no auth-gated room type).
  it("passes a signed-in user's nickname the same way as a guest's", async () => {
    fetchSnapshot.mockResolvedValue({
      seq: 0,
      serverTime: Date.now(),
      state: initialState(config),
    });
    resolveIdentity.mockResolvedValue({ nickname: "octocat", persistent: true });

    await renderToStaticMarkup(
      await RoomPage({ params: Promise.resolve({ id: "room-2" }) })
    );

    const props = liveRoomProps.mock.calls[0]?.[0] as { nickname?: string };
    expect(props.nickname).toBe("octocat");
  });

  it("calls notFound instead of rendering LiveRoom when the room has no snapshot", async () => {
    fetchSnapshot.mockResolvedValue(null);
    resolveIdentity.mockResolvedValue({ nickname: "brisk-otter-7f3", persistent: false });

    await expect(
      RoomPage({ params: Promise.resolve({ id: "missing-room" }) })
    ).rejects.toThrow(/NEXT_NOT_FOUND/);

    expect(liveRoomProps).not.toHaveBeenCalled();
  });
});
