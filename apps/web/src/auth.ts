import NextAuth from "next-auth";
import type { JWT } from "next-auth/jwt";
import type { Profile } from "next-auth";
import GitHub from "next-auth/providers/github";

/**
 * GitHub's OAuth `profile` (the raw userinfo response) carries `login`
 * -- GitHub's globally unique handle -- alongside `name`, a free-text
 * display name two different real accounts can share. `identity.ts`
 * reads `session.user.name` as this app's one signed-in identity
 * field, so it has to be the collision-safe value: overwriting
 * `token.name` with `login` here means every later `session` (built
 * from `token.name` -- see @auth/core's `lib/actions/session.js`,
 * which constructs `session.user = { name: token.name, ... }` before
 * any `session` callback runs) already carries the unique handle, with
 * no separate `session` callback or type augmentation needed.
 *
 * `profile` is only present on the actual sign-in request ("available
 * when `trigger` is `signIn`", per @auth/core's own JSDoc on this
 * callback) -- every later request only has the encoded `token`, which
 * is why this has to be captured onto the token now rather than read
 * fresh each time.
 *
 * Exported (rather than inlined in the `NextAuth(...)` call below) so
 * it is directly unit-testable without exercising a real OAuth
 * exchange -- see auth.test.ts.
 */
export async function jwt({
  token,
  profile,
}: {
  token: JWT;
  profile?: Profile;
}): Promise<JWT> {
  const login = profile?.login;
  if (typeof login === "string" && login.length > 0) {
    token.name = login;
  }
  return token;
}

/**
 * Guests can bid in any room without signing in (see identity.ts) --
 * GitHub sign-in only adds a persistent leaderboard identity on top of
 * that. JWT sessions (`strategy: "jwt"`) mean there is no database
 * adapter and therefore no paid storage tier: the session is encoded
 * entirely in a signed cookie, never written to Neon.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [GitHub],
  session: { strategy: "jwt" },
  callbacks: { jwt },
});
