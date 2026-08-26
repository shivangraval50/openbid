import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchSnapshot, listRooms, roomsBaseUrl } from "./rooms";

beforeEach(() => {
  process.env.ROOMS_BASE_URL = "https://rooms.test";
  vi.restoreAllMocks();
});

describe("roomsBaseUrl", () => {
  it("reads ROOMS_BASE_URL", () => {
    expect(roomsBaseUrl()).toBe("https://rooms.test");
  });

  it("throws a clear error when unset, rather than fetching undefined", () => {
    delete process.env.ROOMS_BASE_URL;
    expect(() => roomsBaseUrl()).toThrow(/ROOMS_BASE_URL/);
  });
});

describe("fetchSnapshot", () => {
  it("returns null for a 404 room", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 404 }))
    );
    expect(await fetchSnapshot("ghost")).toBeNull();
  });

  it("returns the parsed snapshot on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ seq: 3, serverTime: 1, state: { status: "open" } }), {
            status: 200,
          })
      )
    );
    const snapshot = await fetchSnapshot("alpha");
    expect(snapshot?.seq).toBe(3);
  });

  // A malformed envelope must fail loudly (return null, same as a 404),
  // never flow a bad shape into the client store and `reduce`. A plausibly
  // wrong implementation that just casts `await res.json()` would pass the
  // "success" test above and then silently hand back garbage here instead.

  it("returns null when the body is not valid JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json at all", { status: 200 }))
    );
    expect(await fetchSnapshot("alpha")).toBeNull();
  });

  it("returns null when seq is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ serverTime: 1, state: { status: "open" } }), {
            status: 200,
          })
      )
    );
    expect(await fetchSnapshot("alpha")).toBeNull();
  });

  it("returns null when seq is negative", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ seq: -1, serverTime: 1, state: { status: "open" } }), {
            status: 200,
          })
      )
    );
    expect(await fetchSnapshot("alpha")).toBeNull();
  });

  it("returns null when seq is not an integer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ seq: 3.5, serverTime: 1, state: { status: "open" } }), {
            status: 200,
          })
      )
    );
    expect(await fetchSnapshot("alpha")).toBeNull();
  });

  it("returns null when seq is a numeric string, not a number", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ seq: "3", serverTime: 1, state: { status: "open" } }), {
            status: 200,
          })
      )
    );
    expect(await fetchSnapshot("alpha")).toBeNull();
  });

  it("returns null when serverTime is not a number", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ seq: 3, serverTime: "soon", state: { status: "open" } }), {
            status: 200,
          })
      )
    );
    expect(await fetchSnapshot("alpha")).toBeNull();
  });

  it("returns null when state is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ seq: 3, serverTime: 1 }), { status: 200 }))
    );
    expect(await fetchSnapshot("alpha")).toBeNull();
  });

  it("returns null when state is null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ seq: 3, serverTime: 1, state: null }), { status: 200 })
      )
    );
    expect(await fetchSnapshot("alpha")).toBeNull();
  });

  it("returns null when the envelope is an array, not an object", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([1, 2, 3]), { status: 200 }))
    );
    expect(await fetchSnapshot("alpha")).toBeNull();
  });
});

describe("listRooms", () => {
  it("returns an empty list when the lobby is unreachable, so the page still renders", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      })
    );
    expect(await listRooms()).toEqual([]);
  });

  it("returns the rooms array from a healthy lobby", async () => {
    const rooms = [{ roomId: "alpha", itemName: "A rare compiler", endsAtMs: 1, status: "open", highBid: null }];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ rooms }), { status: 200 }))
    );
    expect(await listRooms()).toEqual(rooms);
  });
});
