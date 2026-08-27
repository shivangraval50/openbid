import { cookies } from "next/headers";
import { auth } from "./auth";
import { generateGuestNickname } from "./nickname";

// Re-exported for this module's public surface (the brief specifies
// `generateGuestNickname` as one of `identity.ts`'s exports, and tests
// import it from here) -- see nickname.ts for why the implementation and
// its collision-probability rationale live in their own leaf module.
export { generateGuestNickname };

const GUEST_COOKIE = "openbid_guest";
const NICKNAME_LIMIT = 32; // protocol's hello.nickname max length (packages/protocol/src/index.ts)

/**
 * Signed-in identity (from the Auth.js session) always takes precedence
 * over the guest cookie. Falls back to the guest cookie when there is no
 * session -- which is the common case, since guests can bid in any room
 * without signing in.
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
    return { nickname: name.slice(0, NICKNAME_LIMIT), persistent: true };
  }

  const jar = await cookies();
  const existing = jar.get(GUEST_COOKIE)?.value;
  if (existing) return { nickname: existing, persistent: false };

  return { nickname: generateGuestNickname(), persistent: false };
}
