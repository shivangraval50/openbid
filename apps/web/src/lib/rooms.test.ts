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

  // NOTE: this does not by itself require the `Array.isArray` guard in
  // `isValidSnapshotEnvelope` -- `JSON.parse("[1,2,3]")` has no own `seq`/
  // `serverTime`/`state` properties, so the `typeof v.seq !== "number"`
  // check alone already rejects it. The guard is defence-in-depth (an
  // array is not a sensible envelope regardless of what happens to be on
  // it), and this test documents that shape is rejected, but the failure
  // here is coming from the field checks, not the array check.
  it("returns null when the envelope is an array, not an object", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([1, 2, 3]), { status: 200 }))
    );
    expect(await fetchSnapshot("alpha")).toBeNull();
  });

  // The "up but erroring" case, not "network down": a Worker that resolves
  // with a non-2xx status (a real 500, not a thrown fetch rejection). The
  // body is deliberately a well-formed, validly-shaped envelope -- if it
  // were unparsable text instead, the existing `try { body = await
  // res.json() } catch { return null; }` around the parse would mask a
  // deleted `if (!res.ok) return null;` guard and let this test pass for
  // the wrong reason. With a shape that would satisfy
  // `isValidSnapshotEnvelope`, deleting the `!res.ok` guard makes this
  // fall through and return that body instead of null, so the test only
  // passes because the status guard runs first.
  it("returns null when the Worker responds with a server error, even with a well-formed body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ seq: 3, serverTime: 1, state: { status: "open" } }), {
            status: 500,
          })
      )
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

  // The "up but erroring" case: a resolved non-2xx response is a
  // different failure mode than a thrown/rejected fetch (network down),
  // and the two other listRooms tests do not exercise it. The body is
  // deliberately a well-formed `{ rooms: [...] }` payload, not garbage
  // text -- listRooms already wraps the whole fetch+parse in a
  // try/catch for the network-down case, so an unparsable body would
  // land in that catch and return `[]` for the wrong reason, masking a
  // deleted `if (!res.ok) return [];` guard. With a body that parses
  // cleanly to a real room list, deleting that guard makes the function
  // return the rooms from the error body instead of `[]`, so this test
  // only passes because the status guard runs first.
  it("returns an empty list when the lobby resolves with a server error, even with a well-formed body", async () => {
    const rooms = [{ roomId: "ghost", itemName: "Should never surface", endsAtMs: 1, status: "open", highBid: null }];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ rooms }), { status: 500 }))
    );
    expect(await listRooms()).toEqual([]);
  });
});
