import { botCommentary, selectProvider, type AuctionOutcome } from "@openbid/llm";
import { NICKNAME_MAX_LENGTH } from "@openbid/protocol";
import { z } from "zod";
import { InMemoryRateLimiter } from "@/lib/rateLimit";

// Matches apps/web/src/app/page.tsx's room-creation form, which already
// caps the lot-name input at `maxLength={80}` -- the same bound enforced
// server-side here, not a new one invented for this route.
const ITEM_NAME_MAX_LENGTH = 80;

const money = z.number().finite().positive();

// Mirrors @openbid/llm's `AuctionOutcome` discriminated union: winner and
// price are either both present (a real sale) or both null (no bids). Any
// other combination -- a winner with no price, a price with no winner, an
// oversized name, a non-finite price -- is a caller error and is rejected
// here, before it can reach `botCommentary` (whose own type can no longer
// even express the mismatched case) or ride uncapped into a prompt paid
// for per token.
const settledOutcomeSchema = z.object({
  itemName: z.string().min(1).max(ITEM_NAME_MAX_LENGTH),
  winner: z.string().min(1).max(NICKNAME_MAX_LENGTH),
  price: money,
});
const noBidsOutcomeSchema = z.object({
  itemName: z.string().min(1).max(ITEM_NAME_MAX_LENGTH),
  winner: z.null(),
  price: z.null(),
});
const botRequestSchema: z.ZodType<AuctionOutcome> = z.union([
  settledOutcomeSchema,
  noBidsOutcomeSchema,
]);

// This endpoint spends real Anthropic/Gemini tokens per request, unlike a
// bid submission -- 5 per minute per caller covers legitimate retries
// after a flaky network without leaving it open to being hammered. See
// apps/web/src/lib/rateLimit.ts for exactly what this does and does not
// guarantee (best-effort, per-instance, not a durable cross-instance cap;
// deliberately not backed by Upstash or any external store) -- and note
// that guarantee only holds because of the header choice in `clientKey`
// below; a limiter keyed on a forgeable value protects nobody.
const BOT_RATE_CAPACITY = 5;
const BOT_RATE_WINDOW_MS = 60_000;
const rateLimiter = new InMemoryRateLimiter(BOT_RATE_CAPACITY, BOT_RATE_WINDOW_MS);

/**
 * Picks the rate-limit key. `x-forwarded-for` alone is NOT trustworthy in
 * general -- it is an ordinary request header, and any client can set it
 * to a fresh value on every call (this file's own test suite rotates it
 * for test isolation, which is exactly the attack this guards against).
 *
 * Verified against Vercel's own request-headers reference
 * (https://vercel.com/docs/headers/request-headers, fetched during this
 * review round rather than assumed) before relying on it, per the
 * instruction not to trust recall here:
 *
 *   - `x-vercel-forwarded-for`: "identical to the x-forwarded-for header.
 *     However, x-forwarded-for could be overwritten if you're using a
 *     proxy on top of Vercel." This is the header Vercel's own edge
 *     attaches, and it is not the one an upstream proxy (or a client, if
 *     one somehow reached the origin directly) can overwrite before
 *     Vercel sees it. Preferred.
 *   - `x-forwarded-for`: on an actual Vercel deployment this IS also
 *     overwritten at the edge with the real client IP ("we currently
 *     overwrite the X-Forwarded-For header and do not forward external
 *     IPs. This restriction is in place to prevent IP spoofing.") -- but
 *     that guarantee is specific to requests that passed through
 *     Vercel's edge. In local dev (`next dev`, and this test suite) there
 *     is no edge in front of the server at all, so this header is
 *     whatever the caller sets, with no trust properties whatsoever. It
 *     is kept ONLY as the local-dev fallback, not because it's trusted.
 *   - `x-real-ip`: "identical to the x-forwarded-for header" per the same
 *     page -- same caveat, used only as a last-resort fallback.
 *
 * Net effect: on Vercel, this is spoof-resistant. Off Vercel (local dev,
 * or any other host), it is not, and nothing here can make it so without
 * an actual trusted-proxy boundary this app doesn't have.
 */
function clientKey(request: Request): string {
  const vercelForwardedFor = request.headers.get("x-vercel-forwarded-for");
  if (vercelForwardedFor) return vercelForwardedFor.split(",")[0]!.trim();

  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0]!.trim();

  return request.headers.get("x-real-ip") ?? "unknown";
}

/**
 * Commentary is decoration, never load-bearing for the auction: a missing
 * key, a network failure, or a provider changing its response shape must
 * all degrade to an empty comment with a 200, not a thrown error that
 * Next.js turns into a 500 for the room page's fetch.
 *
 * That 200-with-empty-text path is reserved for PROVIDER failures. A
 * malformed request body, an out-of-bounds field, or a caller past its
 * rate limit are CALLER errors and get a 400/429 instead -- conflating
 * the two would let a broken caller look, from the outside, exactly like
 * "the LLM had nothing to say."
 */
export async function POST(request: Request): Promise<Response> {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = botRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json({ error: "invalid request body" }, { status: 400 });
  }

  if (!rateLimiter.tryTake(clientKey(request), Date.now())) {
    return Response.json({ error: "rate limited" }, { status: 429 });
  }

  try {
    const provider = selectProvider({
      LLM_PROVIDER: process.env.LLM_PROVIDER,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    });
    const text = await botCommentary(provider, parsed.data);
    return Response.json({ text, provider: provider.name });
  } catch (error) {
    // The detail is logged server-side for debugging; the client gets a
    // fixed, generic message. Every error message reaching here already
    // avoids embedding an API key (see anthropic.ts/gemini.ts's own
    // comments on that), but the client-facing response doesn't rely on
    // that holding forever -- a future adapter bug that DID leak
    // something into its error message would still only ever reach
    // server logs, never a client response.
    console.error("bot commentary failed:", error);
    return Response.json({ text: "", provider: null, error: "commentary unavailable" }, { status: 200 });
  }
}
