import { createAnthropicProvider } from "./anthropic";
import { createGeminiProvider } from "./gemini";
import type { LlmProvider } from "./port";

export * from "./port";
export { createAnthropicProvider } from "./anthropic";
export { createGeminiProvider } from "./gemini";

/**
 * Thrown by `selectProvider` when neither provider has a key configured.
 * A named class -- not a bare `Error` -- so a caller (the `/api/bot`
 * route, or anything else built on this port) can distinguish "nothing
 * configured" (a deploy/config problem, fail loudly) from a provider's
 * own runtime failure (a network error, a malformed response -- decoration
 * that should degrade quietly) without parsing the error message.
 */
export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmConfigError";
  }
}

export function selectProvider(env: {
  // `| undefined` is explicit, not redundant: this repo's tsconfig sets
  // `exactOptionalPropertyTypes`, and callers pass `process.env.X` values
  // straight through -- those are `string | undefined`, not "absent or
  // string", so the parameter type must say so or every real call site
  // (e.g. the /api/bot route) fails to typecheck.
  LLM_PROVIDER?: string | undefined;
  ANTHROPIC_API_KEY?: string | undefined;
  GEMINI_API_KEY?: string | undefined;
}): LlmProvider {
  if (env.LLM_PROVIDER === "gemini" && env.GEMINI_API_KEY) {
    return createGeminiProvider(env.GEMINI_API_KEY);
  }
  if (env.LLM_PROVIDER === "anthropic" && env.ANTHROPIC_API_KEY) {
    return createAnthropicProvider(env.ANTHROPIC_API_KEY);
  }
  if (env.ANTHROPIC_API_KEY) return createAnthropicProvider(env.ANTHROPIC_API_KEY);
  if (env.GEMINI_API_KEY) return createGeminiProvider(env.GEMINI_API_KEY);
  throw new LlmConfigError("no LLM provider configured: set ANTHROPIC_API_KEY or GEMINI_API_KEY");
}

const COMMENTARY_SYSTEM =
  "You are a laconic auction house announcer. Two sentences maximum, no exclamation marks.";

// Adaptive thinking (see anthropic.ts) shares one token budget with the
// visible response on Claude Opus 5 -- a tight maxTokens can be consumed
// entirely by thinking, truncating a two-sentence reply to nothing before
// it starts. 512 leaves headroom for that without being large enough to
// need streaming's HTTP-timeout protection to matter (the adapter streams
// unconditionally regardless). Gemini has no such coupling and is
// unaffected by the higher cap -- it stops at end-of-turn either way.
const COMMENTARY_MAX_TOKENS = 512;

/**
 * A discriminated union, not `{itemName, winner: string | null, price:
 * number | null}` with independent nulls -- that shape is type-legal for
 * `winner: "ada", price: null` or `winner: null, price: 500`, neither of
 * which is a real auction outcome, and the second would have embedded the
 * literal text "null" into the prompt. Killing the invalid combination at
 * the type level means every caller of `botCommentary`, not just the one
 * route that happens to validate its input today, is structurally unable
 * to construct it.
 */
export type AuctionOutcome =
  | { itemName: string; winner: string; price: number }
  | { itemName: string; winner: null; price: null };

export async function botCommentary(
  provider: LlmProvider,
  opts: AuctionOutcome
): Promise<string> {
  const prompt =
    opts.winner === null
      ? `The lot "${opts.itemName}" closed with no bids. Comment on it.`
      : `The lot "${opts.itemName}" sold to ${opts.winner} for ${opts.price}. Comment on it.`;

  return provider.complete({ system: COMMENTARY_SYSTEM, prompt, maxTokens: COMMENTARY_MAX_TOKENS });
}
