import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

const GUEST_COOKIE = "openbid_guest";

describe("proxy", () => {
  // This is the regression this file exists to prevent: `identity.ts`'s
  // `resolveIdentity()` cannot call `cookies().set()` itself, because
  // Next.js does not support setting cookies during Server Component
  // rendering (only in a Server Function or Route Handler) -- see
  // https://nextjs.org/docs/app/api-reference/functions/cookies#setting-cookies.
  // A version of this app that skipped `proxy.ts` and relied on the
  // brief's original `resolveIdentity()` sample (which calls `jar.set()`
  // directly from the room page, a Server Component) would throw
  // `ReadonlyRequestCookiesError` on a guest's very first visit -- the
  // majority path, since a first-time guest has no cookie yet.
  it("assigns a new guest cookie on the response when none is present", () => {
    const request = new NextRequest("https://example.com/rooms/abc123");

    const response = proxy(request);

    const cookie = response.cookies.get(GUEST_COOKIE);
    expect(cookie?.value).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{3}$/);
  });

  // The nickname assigned above must also be visible to the SAME
  // request's downstream Server Component render (via `cookies().get()`
  // in `identity.ts`), not only to the browser on the NEXT request --
  // otherwise the very first render a guest ever sees would still fall
  // through to identity.ts's unpersisted fallback, and the nickname
  // shown during that render would not match the one saved to the
  // browser, silently diverging from request 2 onward.
  it("rewrites the request's own Cookie header so the same request can read the new value back", () => {
    const request = new NextRequest("https://example.com/rooms/abc123");

    const response = proxy(request);

    const cookie = response.cookies.get(GUEST_COOKIE);
    // `NextResponse.next({ request: { headers } })` encodes a rewritten
    // request header as `x-middleware-request-<name>` plus a manifest in
    // `x-middleware-override-headers` (see next/dist/server/web/spec-
    // extension/response.js). The rewritten `cookie` header must contain
    // the SAME value just assigned to the outgoing Set-Cookie.
    const forwardedCookieHeader = response.headers.get("x-middleware-request-cookie");
    expect(response.headers.get("x-middleware-override-headers")).toContain("cookie");
    expect(forwardedCookieHeader).toContain(`${GUEST_COOKIE}=${cookie?.value}`);
  });

  it("passes an existing guest cookie through unchanged", () => {
    const request = new NextRequest("https://example.com/rooms/abc123", {
      headers: { cookie: `${GUEST_COOKIE}=brisk-otter-7f3` },
    });

    const response = proxy(request);

    // No new Set-Cookie should be issued when one already exists --
    // otherwise every request would silently reassign a fresh identity,
    // defeating the entire point of a persistent-for-the-session guest
    // nickname.
    expect(response.cookies.get(GUEST_COOKIE)).toBeUndefined();
  });
});
