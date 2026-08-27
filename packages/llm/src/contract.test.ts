import { describe, it, expect } from "vitest";
import {
  selectProvider,
  botCommentary,
  LlmConfigError,
  type LlmProvider,
  type CompletionRequest,
} from "./index";

/**
 * A fake that records what it was actually asked to complete, so the
 * `botCommentary` tests below can assert on the *content* of the prompt
 * (item name, winner, price) instead of only "produced a non-empty
 * string" -- a check that passes even if the wrong prompt were sent, or
 * the provider just echoed back a constant. This is the requirement-3 fix
 * to the brief's own sample test, which could not fail against a provider
 * returning literally anything.
 */
function fakeProvider(response: string): {
  provider: LlmProvider;
  getLastRequest: () => CompletionRequest | null;
} {
  let lastRequest: CompletionRequest | null = null;
  const provider: LlmProvider = {
    name: "fake",
    async complete(req) {
      lastRequest = req;
      return response;
    },
  };
  return { provider, getLastRequest: () => lastRequest };
}

describe("selectProvider", () => {
  it("prefers Anthropic when its key is present", () => {
    expect(selectProvider({ ANTHROPIC_API_KEY: "sk-test" }).name).toBe("anthropic");
  });

  it("falls back to Gemini when only that key is present", () => {
    expect(selectProvider({ GEMINI_API_KEY: "g-test" }).name).toBe("gemini");
  });

  it("honours an explicit LLM_PROVIDER override", () => {
    const provider = selectProvider({
      LLM_PROVIDER: "gemini",
      ANTHROPIC_API_KEY: "sk-test",
      GEMINI_API_KEY: "g-test",
    });
    expect(provider.name).toBe("gemini");
  });

  // An override naming a provider whose key is missing must not silently
  // construct that provider with an undefined key (which would only fail
  // later, inside a request) -- it should fall through to whichever key
  // actually is present, the same way selectProvider({}) would with no
  // override at all.
  it("falls through to the available key when the override names a provider with no key", () => {
    const provider = selectProvider({ LLM_PROVIDER: "gemini", ANTHROPIC_API_KEY: "sk-test" });
    expect(provider.name).toBe("anthropic");
  });

  // Constraint: "selectProvider must throw a clear, named error when no
  // key is configured... a missing one should fail loudly at the boundary
  // rather than produce empty strings." A named error class -- not a bare
  // Error -- lets a caller (the /api/bot route) distinguish "nothing
  // configured" from a provider's own runtime failure without string
  // matching. This test fails against an implementation that throws a
  // plain `Error` with the right message but the wrong class.
  it("throws a clear, named error when no key is configured", () => {
    let caught: unknown;
    try {
      selectProvider({});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LlmConfigError);
    expect((caught as Error).name).toBe("LlmConfigError");
    expect((caught as Error).message).toMatch(/no LLM provider configured/i);
  });
});

describe("botCommentary — one contract, any provider", () => {
  it("returns the provider's text verbatim, not a placeholder or a truncated copy", async () => {
    const { provider } = fakeProvider("Going once, going twice, sold to ada!");
    const text = await botCommentary(provider, {
      itemName: "A rare compiler",
      winner: "ada",
      price: 500,
    });
    expect(text).toBe("Going once, going twice, sold to ada!");
  });

  it("builds a prompt naming the item, the winner, and the price when there is a winner", async () => {
    const { provider, getLastRequest } = fakeProvider("commentary");
    await botCommentary(provider, { itemName: "A rare compiler", winner: "ada", price: 500 });

    const request = getLastRequest();
    expect(request?.prompt).toContain("A rare compiler");
    expect(request?.prompt).toContain("ada");
    expect(request?.prompt).toContain("500");
  });

  it("builds a prompt for a no-bids close that names the item but leaks no null/undefined", async () => {
    const { provider, getLastRequest } = fakeProvider("commentary");
    await botCommentary(provider, { itemName: "Nothing", winner: null, price: null });

    const request = getLastRequest();
    expect(request?.prompt).toContain("Nothing");
    expect(request?.prompt).not.toMatch(/\bnull\b/i);
    expect(request?.prompt).not.toContain("undefined");
  });

  // The two branches must actually diverge -- not just handle `null`
  // gracefully but produce the SAME templated sentence either way.
  it("sends genuinely different prompts for a winning close vs. a no-bids close", async () => {
    const { provider, getLastRequest } = fakeProvider("commentary");

    await botCommentary(provider, { itemName: "Same item", winner: "ada", price: 500 });
    const withWinner = getLastRequest()?.prompt;

    await botCommentary(provider, { itemName: "Same item", winner: null, price: null });
    const withoutWinner = getLastRequest()?.prompt;

    expect(withWinner).not.toBe(withoutWinner);
  });

  it("sends a non-empty system prompt and a positive maxTokens", async () => {
    const { provider, getLastRequest } = fakeProvider("commentary");
    await botCommentary(provider, { itemName: "X", winner: "ada", price: 500 });

    const request = getLastRequest();
    expect(request?.system.length).toBeGreaterThan(0);
    expect(request?.maxTokens).toBeGreaterThan(0);
  });
});
