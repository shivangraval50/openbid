import { cookies } from "next/headers";
import { NICKNAME_MAX_LENGTH } from "@openbid/protocol";
import { auth } from "./auth";
import { generateGuestNickname } from "./nickname";

// Re-exported for this module's public surface (the brief specifies
// `generateGuestNickname` as one of `identity.ts`'s exports, and tests
// import it from here) -- see nickname.ts for why the implementation and
// its collision-probability rationale live in their own leaf module.
export { generateGuestNickname };

const GUEST_COOKIE = "openbid_guest";

// `String.prototype.slice` truncates by UTF-16 code unit, so a display
// name with an emoji (or any character outside the Basic Multilingual
// Plane) straddling the boundary would be cut in the middle of a
// surrogate pair -- a malformed string that renders as U+FFFD, yet
// still passes the protocol's `.max(NICKNAME_MAX_LENGTH)` check (a lone
// surrogate still counts as one `.length` unit).
//
// `for...of` iterates a string by code point (each `ch` below is one
// full character, 1 or 2 UTF-16 units), so appending only whole
// characters can never split a pair. This also has to stay within
// `maxLength` in UTF-16 units, not code points: naively taking the
// first `maxLength` code points (e.g. `Array.from(value).slice(0,
// maxLength)`) can overshoot the wire limit by one unit whenever a
// surrogate-pair character is among them, which would fail the exact
// `hello.nickname` schema this value is truncated FOR. Tracking
// `result.length` (UTF-16 units) as the budget avoids both failure
// modes: a trailing character that would only partially fit is dropped
// whole rather than split or overshot.
function truncateToCodePoints(value: string, maxLength: number): string {
  let result = "";
  for (const ch of value) {
    if (result.length + ch.length > maxLength) break;
    result += ch;
  }
  return result;
}

/**
 * Signed-in identity (from the Auth.js session) always takes precedence
 * over the guest cookie. Falls back to the guest cookie when there is no
 * session -- which is the common case, since guests can bid in any room
 * without signing in.
 *
 * BOTH branches run their nickname through `truncateToCodePoints`. Neither
 * source is trustworthy: a GitHub display name can be any length, and the
 * guest cookie is client-writable (`httpOnly: false`, see `proxy.ts`).
 * This function is the only length gate between either of them and
 * `clientMessageSchema`'s `.max(NICKNAME_MAX_LENGTH)` on the wire.
 *
 * `session.user.name` is GitHub's globally-unique `login`, not the
 * free-text display name: `auth.ts`'s `jwt` callback overwrites it with
 * `profile.login` on sign-in, specifically so two different real GitHub
 * users who happen to share a display name don't collide on the
 * leaderboard's `GROUP BY winner_nickname`, or on the live "Leader:"/
 * "Won by" lines during an active auction between them -- the same
 * collision defect Requirement 1 fixed for guests, applying with equal
 * force to the supposedly-more-trustworthy signed-in path.
 *
 * Deliberately never calls `cookies().set()`: Next.js does not support
 * setting cookies during Server Component rendering, only in a Server
 * Function, a Route Handler, or Proxy (see
 * https://nextjs.org/docs/app/api-reference/functions/cookies#setting-cookies).
 * `resolveIdentity` runs from a Server Component (the room page), so it
 * only ever READS `openbid_guest`. `proxy.ts` is what actually assigns
 * that cookie, before this ever runs, on a guest's first request. The
 * `generateGuestNickname()` fallback below only fires if that somehow
 * didn't happen (a request path outside `proxy.ts`'s matcher, or a
 * direct test of this function) -- it still returns a usable identity
 * rather than ever throwing, just an unpersisted one for this one call.
 *
 * Deliberately does NOT compare any identifier here to a participant's
 * `participantId`: that ID is per-connection and reassigned on every
 * reconnect, so it cannot answer "is this me" across a disconnect. Only
 * the nickname is stable identity in this app.
 */
export async function resolveIdentity(): Promise<{ nickname: string; persistent: boolean }> {
  const session = await auth();
  const name = session?.user?.name;
  if (typeof name === "string" && name.length > 0) {
    return { nickname: truncateToCodePoints(name, NICKNAME_MAX_LENGTH), persistent: true };
  }

  const jar = await cookies();
  const existing = jar.get(GUEST_COOKIE)?.value;
  // Truncated exactly like the signed-in branch above, and for a sharper
  // reason: `proxy.ts` sets `openbid_guest` with `httpOnly: false`, so the
  // browser can write it. This value is untrusted input, not something
  // this app put there. An over-long one fails `clientMessageSchema`'s
  // `.max(NICKNAME_MAX_LENGTH)` when `connectRoom` puts it on a `hello`,
  // `RoomDO` closes that socket with 1003 ("unsupported payload"), and
  // `connectRoom`'s `onclose` immediately reconnects and sends the same
  // over-long nickname again -- an infinite reconnect loop that locks that
  // browser out of every room in the app until the cookie is cleared by
  // hand. Truncating here is the whole fix: there is no other length gate
  // between the cookie and the wire.
  if (existing) {
    return {
      nickname: truncateToCodePoints(existing, NICKNAME_MAX_LENGTH),
      persistent: false,
    };
  }

  return { nickname: generateGuestNickname(), persistent: false };
}
