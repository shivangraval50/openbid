import { describe, it, expect, vi } from "vitest";
import type { JWT } from "next-auth/jwt";

// `auth.ts` calls `NextAuth({...})` at module scope, and the real
// `next-auth` package fails to resolve `next/server` under vitest's
// plain-Node-style module resolution from deep inside
// `next-auth/lib/env.js` (the same issue documented in proxy.ts, for
// the same underlying reason: vitest's resolver isn't Next's own
// bundler). Mocking both packages here means importing `./auth` for
// its plain, dependency-free `jwt` export never touches that code path
// -- `jwt` itself has no runtime dependency on either package, only
// erased type-only imports.
vi.mock("next-auth", () => ({
  default: vi.fn(() => ({ handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() })),
}));
vi.mock("next-auth/providers/github", () => ({ default: vi.fn() }));

const { jwt } = await import("./auth");

function githubProfile(overrides: { login: string; name: string }) {
  // Trimmed to the fields this callback reads; a real GitHub userinfo
  // response carries many more (id, avatar_url, email, ...).
  return { login: overrides.login, name: overrides.name };
}

describe("auth jwt callback", () => {
  // This is Important 1 from review: two different real GitHub users
  // can share a free-text display `name` (GitHub does not enforce
  // uniqueness on it), but `login` is globally unique. A version that
  // sourced the token's name from `profile.name` instead of
  // `profile.login` would collapse both users below onto the identical
  // nickname "Ada Lovelace" -- corrupting the live "Leader:"/"Won by"
  // lines during an auction between them, and merging their wins on
  // the leaderboard's `GROUP BY winner_nickname`, the exact defect
  // class Requirement 1 fixed for guests.
  it("gives two users with the same display name distinct nicknames, sourced from their distinct GitHub logins", async () => {
    const tokenA = {} as JWT;
    const tokenB = {} as JWT;

    const resultA = await jwt({
      token: tokenA,
      profile: githubProfile({ login: "ada-lovelace-1815", name: "Ada Lovelace" }),
    });
    const resultB = await jwt({
      token: tokenB,
      profile: githubProfile({ login: "ada-lovelace-2026", name: "Ada Lovelace" }),
    });

    expect(resultA.name).toBe("ada-lovelace-1815");
    expect(resultB.name).toBe("ada-lovelace-2026");
    expect(resultA.name).not.toBe(resultB.name);
  });

  // `profile` is only present on the actual sign-in request; every
  // later call (session refresh, etc.) passes the same token back with
  // no `profile` at all. A version that required `profile.login` on
  // every call, or that cleared `token.name` when `profile` is absent,
  // would wipe out the identity this callback exists to persist.
  it("leaves an already-set token.name alone when profile is absent (a non-sign-in call)", async () => {
    const token = { name: "existing-login" } as JWT;

    const result = await jwt({ token });

    expect(result.name).toBe("existing-login");
  });

  // Guards the `typeof login === "string" && login.length > 0` check:
  // a malformed or empty `login` must not overwrite the token with a
  // useless value.
  it("does not overwrite token.name when profile.login is an empty string", async () => {
    const token = { name: "existing-login" } as JWT;

    const result = await jwt({ token, profile: githubProfile({ login: "", name: "Someone" }) });

    expect(result.name).toBe("existing-login");
  });
});
