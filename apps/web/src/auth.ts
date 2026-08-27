import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";

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
});
