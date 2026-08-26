import { describe, it, expect, vi, beforeEach } from "vitest";

const initRoom = vi.fn();
const registerRoom = vi.fn();
const redirect = vi.fn((path: string) => {
  // next/navigation's real `redirect` works by throwing a special error to
  // abort rendering; mirror that so `createRoom` can never fall through to
  // "success" after a redirect the mock recorded.
  throw new Error(`NEXT_REDIRECT:${path}`);
});

vi.mock("@/lib/rooms", () => ({ initRoom, registerRoom }));
vi.mock("next/navigation", () => ({ redirect }));

const { createRoom } = await import("./rooms");

function formDataWith(itemName: string): FormData {
  const fd = new FormData();
  fd.set("itemName", itemName);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  initRoom.mockResolvedValue(undefined);
  registerRoom.mockResolvedValue(undefined);
});

describe("createRoom", () => {
  it("initialises then registers the room before redirecting to it", async () => {
    await expect(createRoom(formDataWith("A rare compiler"))).rejects.toThrow(/NEXT_REDIRECT/);

    expect(initRoom).toHaveBeenCalledTimes(1);
    expect(registerRoom).toHaveBeenCalledTimes(1);

    const [roomId] = initRoom.mock.calls[0] as [string, unknown];
    expect(registerRoom.mock.calls[0]?.[0]).toBe(roomId);
    expect(redirect).toHaveBeenCalledWith(`/rooms/${roomId}`);
  });

  // Carried requirement from Task 10's review: initRoom succeeding and
  // registerRoom failing must not be a silent partial success (a room
  // that is live and biddable but permanently invisible in the lobby). A
  // naive implementation that calls each once and lets the error
  // propagate would still "surface" a hard failure, so it would pass the
  // next test below -- but it would never retry, so this test (asserting
  // a second, successful attempt) is what actually catches that naive
  // version and proves the transient-failure path recovers instead of
  // orphaning the room.
  it("retries registration after a transient failure instead of giving up immediately", async () => {
    registerRoom.mockRejectedValueOnce(new Error("network blip")).mockResolvedValueOnce(undefined);

    await expect(createRoom(formDataWith("Retry lot"))).rejects.toThrow(/NEXT_REDIRECT/);

    expect(initRoom).toHaveBeenCalledTimes(1);
    expect(registerRoom).toHaveBeenCalledTimes(2);
    expect(redirect).toHaveBeenCalledTimes(1);
  });

  // The other half of the same carried requirement: if registration never
  // succeeds, the failure must be surfaced to the caller, not swallowed
  // into a redirect that leaves the room permanently unlisted. A wrong
  // implementation that catches the registerRoom error and redirects
  // anyway would fail this test by calling `redirect`.
  it("surfaces an error instead of redirecting when every registration attempt fails", async () => {
    registerRoom.mockRejectedValue(new Error("lobby down"));

    await expect(createRoom(formDataWith("Orphan lot"))).rejects.toThrow(/could not be registered/);

    expect(initRoom).toHaveBeenCalledTimes(1);
    expect(registerRoom.mock.calls.length).toBeGreaterThan(1);
    expect(redirect).not.toHaveBeenCalled();
  });

  it("does not attempt to register a room whose init call failed", async () => {
    initRoom.mockRejectedValue(new Error("init failed"));

    await expect(createRoom(formDataWith("Never lives"))).rejects.toThrow(/init failed/);

    expect(registerRoom).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("falls back to a default lot name when itemName is blank", async () => {
    await expect(createRoom(formDataWith("   "))).rejects.toThrow(/NEXT_REDIRECT/);

    const [, config] = initRoom.mock.calls[0] as [string, { itemName: string }];
    expect(config.itemName).toBe("Untitled lot");
  });
});
