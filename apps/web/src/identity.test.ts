import { describe, it, expect, vi, beforeEach } from "vitest";
import { encode, parseClientMessage } from "@openbid/protocol";

// Declared and mocked at true module top level (matching
// src/actions/rooms.test.ts's convention) rather than inside a describe
// block: vitest hoists `vi.mock` calls above all other statements in the
// file, so a factory that closes over an outer `const` needs that const's
// declaration to already be side-effect-free by the time the mocked
// module is actually loaded, which is only guaranteed by keeping both at
// the top.
const cookieStore = { get: vi.fn(), set: vi.fn() };
const cookies = vi.fn(async () => cookieStore);
const auth = vi.fn();

vi.mock("next/headers", () => ({ cookies }));
vi.mock("./auth", () => ({ auth }));

const { generateGuestNickname, resolveIdentity } = await import("./identity");

describe("generateGuestNickname", () => {
  // The brief's original generator is two words drawn from 6x6 pools (36
  // combinations) with no discriminator. Nicknames are load-bearing --
  // PriceLadder names the leader by nickname, the settlement line names
  // the winner by nickname, and the leaderboard GROUPs by winner_nickname
  // -- so by the birthday bound a collision is more likely than not at
  // ~7 concurrent guests, an ordinary demo size. The fix appends a short
  // random discriminator (word-word-xxx, matching the brief's own
  // "brisk-otter-7f3" example), which is what this shape assertion pins.
  it("produces a two-word name plus a short discriminator", () => {
    const name = generateGuestNickname(() => 0);
    expect(name).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{3}$/);
  });

  it("is deterministic for a fixed random source", () => {
    expect(generateGuestNickname(() => 0.5)).toBe(generateGuestNickname(() => 0.5));
  });

  it("varies with the random source", () => {
    expect(generateGuestNickname(() => 0)).not.toBe(generateGuestNickname(() => 0.99));
  });

  it("never exceeds the protocol nickname limit of 32 characters", () => {
    for (const r of [0, 0.25, 0.5, 0.75, 0.99]) {
      expect(generateGuestNickname(() => r).length).toBeLessThanOrEqual(32);
    }
  });

  // Proves the discriminator actually discriminates: 20 calls that would
  // pick the SAME adjective/noun pair under a naive two-word generator
  // (the word draws pinned to 0 every time) still come out as 20 distinct
  // nicknames, because each call also draws its own 3-character suffix
  // from a counter that advances across calls. A version that dropped
  // the discriminator (reverting to the brief's plain two-word shape)
  // would collapse all 20 onto a single string and fail this.
  it("produces 20 distinct nicknames even when every adjective/noun draw is pinned to the same pick", () => {
    let call = 0;
    const rand = () => {
      const i = call % 5; // 2 word draws + 3 suffix-char draws per name
      call++;
      if (i < 2) return 0; // adjective, noun: always the first pool entry
      return (Math.floor(call / 5) % 36) / 36; // suffix chars vary per name
    };
    const names = new Set<string>();
    for (let n = 0; n < 20; n++) names.add(generateGuestNickname(rand));
    expect(names.size).toBe(20);
  });
});

describe("resolveIdentity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cookies.mockImplementation(async () => cookieStore);
  });

  it("prefers the signed-in session's nickname over any guest cookie", async () => {
    auth.mockResolvedValue({ user: { name: "octocat" } });

    const identity = await resolveIdentity();

    expect(identity).toEqual({ nickname: "octocat", persistent: true });
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it("falls back to an existing guest cookie when there is no session", async () => {
    auth.mockResolvedValue(null);
    cookieStore.get.mockReturnValue({ value: "brisk-otter-7f3" });

    const identity = await resolveIdentity();

    expect(identity).toEqual({ nickname: "brisk-otter-7f3", persistent: false });
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  // `proxy.ts` (see proxy.ts and proxy.test.ts) is what actually assigns
  // `openbid_guest` on a guest's first request, because Next.js does not
  // support setting cookies during Server Component rendering. This
  // test pins that `resolveIdentity` itself never attempts to -- a
  // version that reverted to the brief's original sample (calling
  // `jar.set(...)` here) would throw `ReadonlyRequestCookiesError` at
  // runtime the moment it ran inside the actual room page, a failure
  // this cookie-store mock is too permissive to catch on its own; this
  // assertion is the guard against reintroducing that call.
  it("falls back to a freshly generated nickname without writing the cookie when there is no session and no cookie", async () => {
    auth.mockResolvedValue(null);
    cookieStore.get.mockReturnValue(undefined);

    const identity = await resolveIdentity();

    expect(identity.persistent).toBe(false);
    expect(identity.nickname).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{3}$/);
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it("truncates an overly long session name to the 32-character protocol limit", async () => {
    auth.mockResolvedValue({ user: { name: "x".repeat(50) } });

    const identity = await resolveIdentity();

    expect(identity.nickname.length).toBe(32);
  });

  // A naive `name.slice(0, 32)` truncates by UTF-16 code unit, so an
  // emoji (a surrogate pair, 2 code units) straddling the boundary gets
  // cut in half -- a lone surrogate that still satisfies the protocol's
  // `.max(32)` check (it still counts as one `.length` unit) but is not
  // valid Unicode. This name is built so the 32-code-unit mark lands
  // exactly inside the emoji: 31 "a"s (31 units) then one emoji (2
  // units) would only partially fit. The fix must drop the emoji
  // whole, landing at 31 characters, rather than emit a corrupted
  // 32-unit string.
  it("truncates by whole character instead of splitting a surrogate pair", async () => {
    const name = "a".repeat(31) + "\u{1F600}" + "trailing text";
    auth.mockResolvedValue({ user: { name } });

    const identity = await resolveIdentity();

    expect(identity.nickname).toBe("a".repeat(31));
    expect(identity.nickname.length).toBeLessThanOrEqual(32);
  });

  // `openbid_guest` is set `httpOnly: false` (proxy.ts), so it is
  // client-writable: anything in that cookie is untrusted input on exactly
  // the same footing as a session display name. An over-long value fails
  // `clientMessageSchema`'s `.max(NICKNAME_MAX_LENGTH)` on the `hello`,
  // `RoomDO` closes the socket with 1003, and `connectRoom`'s `onclose`
  // reconnects -- an infinite loop that leaves that browser permanently
  // unable to use ANY room until the cookie is cleared by hand. The
  // signed-in branch was already truncated; this branch returned the cookie
  // value raw.
  it("truncates an overly long guest cookie to the 32-character protocol limit", async () => {
    auth.mockResolvedValue(null);
    cookieStore.get.mockReturnValue({ value: "x".repeat(200) });

    const identity = await resolveIdentity();

    expect(identity.nickname.length).toBe(32);
  });

  // The assertion that names the actual consequence rather than a length
  // number: the value must survive the very schema it is truncated FOR.
  // A length check that used a different limit than the protocol's, or one
  // applied to the wrong branch, fails here even if the test above passed.
  it("returns a guest cookie nickname that a hello message can actually carry", async () => {
    auth.mockResolvedValue(null);
    cookieStore.get.mockReturnValue({ value: "x".repeat(200) });

    const identity = await resolveIdentity();

    expect(() =>
      parseClientMessage(
        encode({ t: "hello", lastSeenSeq: 0, nickname: identity.nickname, persistent: false })
      )
    ).not.toThrow();
  });

  // Same surrogate-pair hazard as the signed-in branch above, on a value an
  // attacker (or just a user with an emoji in a hand-edited cookie)
  // controls directly. `slice(0, 32)` would emit a lone high surrogate here.
  it("truncates a guest cookie by whole character instead of splitting a surrogate pair", async () => {
    auth.mockResolvedValue(null);
    cookieStore.get.mockReturnValue({ value: "a".repeat(31) + "\u{1F600}" + "more" });

    const identity = await resolveIdentity();

    expect(identity.nickname).toBe("a".repeat(31));
  });

  it("treats an empty session name as signed-out and falls back to the guest cookie", async () => {
    auth.mockResolvedValue({ user: { name: "" } });
    cookieStore.get.mockReturnValue({ value: "quiet-vole-a1b" });

    const identity = await resolveIdentity();

    expect(identity).toEqual({ nickname: "quiet-vole-a1b", persistent: false });
  });
});
