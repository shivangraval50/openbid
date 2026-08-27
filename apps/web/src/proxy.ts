import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { generateGuestNickname } from "@/nickname";

const GUEST_COOKIE = "openbid_guest";

/**
 * Assigns a guest identity cookie on a visitor's first request.
 *
 * This exists because Next.js does not support setting cookies during
 * Server Component rendering -- only in a Server Function, a Route
 * Handler, or here, in Proxy (the renamed `middleware.ts`). See
 * https://nextjs.org/docs/app/api-reference/functions/cookies#setting-cookies:
 * "Setting cookies is not supported during Server Component rendering."
 * `identity.ts`'s `resolveIdentity()` therefore only ever READS
 * `openbid_guest`; this is what actually assigns one.
 *
 * Rewrites the request's own `cookie` header (via `NextResponse.next({
 * request: { headers } })`), not just the response's `Set-Cookie`: that
 * makes the newly assigned nickname visible to `cookies().get()` in the
 * SAME request's render, so the very first page a guest ever sees
 * already shows the identity that got saved to their browser, rather
 * than a value that only takes effect starting with their second
 * request.
 *
 * Imports `generateGuestNickname` from `./nickname`, not `./identity`:
 * `identity.ts` also imports `./auth` (Auth.js), and pulling that into
 * Proxy's module graph broke plain-Node-style resolution of
 * `next/server` from inside `next-auth/lib/env.js` under vitest. Proxy
 * has no reason to know about Auth.js at all -- it only ever handles the
 * guest cookie.
 */
export function proxy(request: NextRequest): NextResponse {
  if (request.cookies.has(GUEST_COOKIE)) return NextResponse.next();

  const nickname = generateGuestNickname();

  const requestHeaders = new Headers(request.headers);
  const existingCookieHeader = requestHeaders.get("cookie");
  requestHeaders.set(
    "cookie",
    existingCookieHeader
      ? `${existingCookieHeader}; ${GUEST_COOKIE}=${nickname}`
      : `${GUEST_COOKIE}=${nickname}`
  );

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.cookies.set(GUEST_COOKIE, nickname, { httpOnly: false, sameSite: "lax", path: "/" });
  return response;
}

export const config = {
  // Skip static assets and Next.js internals; every other route (rooms,
  // the leaderboard, and any future page that wants guest identity) gets
  // a guest cookie assigned on first visit.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
