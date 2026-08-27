import { describe, it, expect, vi, beforeEach } from "vitest";

const selectProvider = vi.fn();
const botCommentary = vi.fn();

vi.mock("@openbid/llm", () => ({ selectProvider, botCommentary }));

const { POST } = await import("./route");

/** `ip` defaults to a value unique-enough per call site to avoid one
 * test's requests exhausting another's rate-limit budget -- the limiter
 * is a module-level singleton shared across every test in this file. */
function postRequest(body: unknown, ip = "203.0.113.1"): Request {
  return new Request("http://localhost/api/bot", {
    method: "POST",
    headers: { "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

function rawRequest(rawBody: string, ip = "203.0.113.1"): Request {
  return new Request("http://localhost/api/bot", {
    method: "POST",
    headers: { "x-forwarded-for": ip },
    body: rawBody,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/bot", () => {
  it("returns the commentary text and the provider name on success", async () => {
    selectProvider.mockReturnValue({ name: "anthropic", complete: vi.fn() });
    botCommentary.mockResolvedValue("Sold to ada for 500.");

    const res = await POST(postRequest({ itemName: "X", winner: "ada", price: 500 }, "203.0.113.10"));

    expect(res.status).toBe(200);
    const json = (await res.json()) as { text: string; provider: string };
    expect(json).toEqual({ text: "Sold to ada for 500.", provider: "anthropic" });
  });

  // Constraint: "Commentary is decoration: a provider failure must never
  // break the auction page or the route." The plausible-wrong
  // implementation here lets selectProvider's thrown error propagate,
  // which Next.js turns into an unhandled 500 -- this is the test that
  // would catch that regression.
  it("degrades to a 200 with empty text when no provider is configured, rather than throwing", async () => {
    selectProvider.mockImplementation(() => {
      throw new Error("no LLM provider configured: set ANTHROPIC_API_KEY or GEMINI_API_KEY");
    });

    const res = await POST(postRequest({ itemName: "X", winner: "ada", price: 500 }, "203.0.113.11"));

    expect(res.status).toBe(200);
    const json = (await res.json()) as { text: string; provider: string | null; error?: string };
    expect(json.text).toBe("");
    expect(json.provider).toBeNull();
  });

  it("degrades to a 200 with empty text when the provider call itself fails (e.g. a malformed response)", async () => {
    selectProvider.mockReturnValue({ name: "gemini", complete: vi.fn() });
    botCommentary.mockRejectedValue(new Error("gemini response did not match the expected shape"));

    const res = await POST(postRequest({ itemName: "X", winner: "ada", price: 500 }, "203.0.113.12"));

    expect(res.status).toBe(200);
    const json = (await res.json()) as { text: string; provider: string | null };
    expect(json.text).toBe("");
    expect(json.provider).toBeNull();
  });

  // Important #1 (review round 1): a malformed request body is a CALLER
  // error, not a provider failure -- it must be distinguishable (400),
  // not silently absorbed into the same 200-with-empty-text path used for
  // "the LLM had nothing to say." Also asserts the provider is never even
  // reached, so this can't pass merely because a mocked provider degrades
  // gracefully downstream.
  describe("caller errors (must not be absorbed into the provider-failure 200 path)", () => {
    it("returns 400 when the request body is not valid JSON at all", async () => {
      const res = await POST(rawRequest("not json", "203.0.113.20"));

      expect(res.status).toBe(400);
      expect(selectProvider).not.toHaveBeenCalled();
      expect(botCommentary).not.toHaveBeenCalled();
    });

    it("returns 400 when winner is set but price is null (a shape botCommentary's own type can no longer express)", async () => {
      const res = await POST(postRequest({ itemName: "X", winner: "ada", price: null }, "203.0.113.21"));

      expect(res.status).toBe(400);
      expect(botCommentary).not.toHaveBeenCalled();
    });

    it("returns 400 when winner is null but price is set", async () => {
      const res = await POST(postRequest({ itemName: "X", winner: null, price: 500 }, "203.0.113.22"));

      expect(res.status).toBe(400);
      expect(botCommentary).not.toHaveBeenCalled();
    });

    it("returns 400 when itemName is missing", async () => {
      const res = await POST(postRequest({ winner: "ada", price: 500 }, "203.0.113.23"));

      expect(res.status).toBe(400);
      expect(botCommentary).not.toHaveBeenCalled();
    });

    // Requirement 2's discipline, applied to the request side: a wrong-
    // shaped body must not silently embed the literal string "undefined"
    // into a prompt paid for per token. itemName over the room-creation
    // form's own 80-char cap (apps/web/src/app/page.tsx) is exactly the
    // kind of oversized value that would otherwise ride straight into the
    // prompt uncapped.
    it("returns 400 when itemName exceeds the 80-character bound enforced elsewhere in this app", async () => {
      const res = await POST(
        postRequest({ itemName: "x".repeat(81), winner: "ada", price: 500 }, "203.0.113.24")
      );

      expect(res.status).toBe(400);
      expect(botCommentary).not.toHaveBeenCalled();
    });

    it("returns 400 when winner exceeds NICKNAME_MAX_LENGTH (32)", async () => {
      const res = await POST(
        postRequest({ itemName: "X", winner: "a".repeat(33), price: 500 }, "203.0.113.25")
      );

      expect(res.status).toBe(400);
      expect(botCommentary).not.toHaveBeenCalled();
    });

    // Deliberately NOT `postRequest({..., price: Number.POSITIVE_INFINITY})`:
    // `JSON.stringify({price: Infinity})` silently produces `{"price":null}`
    // (JSON.stringify converts Infinity/NaN to null), so that body would
    // never actually carry a non-finite price to the server -- it would
    // carry `price: null`, which the winner-without-price test above
    // already covers, for a completely different reason. That was
    // literally what this test did before this fix, and it "passed"
    // while proving nothing about `.finite()`. A real wire payload CAN
    // carry Infinity: `JSON.parse('{"price":1e400}')` overflows to
    // `Infinity` (the JSON grammar allows the exponent; the underlying
    // float parser doesn't reject the overflow), so a raw body with an
    // unquoted `1e400` literal is what actually reaches the schema.
    it("returns 400 when price overflows to Infinity in a raw wire payload", async () => {
      const res = await POST(
        rawRequest('{"itemName":"X","winner":"ada","price":1e400}', "203.0.113.26")
      );

      expect(res.status).toBe(400);
      expect(botCommentary).not.toHaveBeenCalled();
    });
  });

  // Important #1: the endpoint spends real API budget per request, so it
  // must be throttled per caller. Capacity is exercised directly rather
  // than mocked, so this proves the real limiter is wired into the route,
  // not merely that a fake would return false.
  describe("rate limiting", () => {
    it("rejects a caller's request once it exceeds the per-IP budget, before ever selecting a provider", async () => {
      selectProvider.mockReturnValue({ name: "anthropic", complete: vi.fn() });
      botCommentary.mockResolvedValue("commentary");
      const ip = "203.0.113.30";
      const body = { itemName: "X", winner: "ada", price: 500 };

      // The limiter's capacity is 5 (see route.ts) -- five requests must
      // succeed, and the sixth in the same window must not.
      for (let i = 0; i < 5; i++) {
        const res = await POST(postRequest(body, ip));
        expect(res.status).toBe(200);
      }

      const limited = await POST(postRequest(body, ip));
      expect(limited.status).toBe(429);

      // The 6th call must be rejected before spending an LLM call -- the
      // mock call count should still be 5, not 6.
      expect(botCommentary).toHaveBeenCalledTimes(5);
    });

    it("does not rate-limit one caller based on another caller's usage", async () => {
      selectProvider.mockReturnValue({ name: "anthropic", complete: vi.fn() });
      botCommentary.mockResolvedValue("commentary");
      const body = { itemName: "X", winner: "ada", price: 500 };

      for (let i = 0; i < 5; i++) {
        await POST(postRequest(body, "203.0.113.40"));
      }
      // A fresh IP must still get its own full budget.
      const res = await POST(postRequest(body, "203.0.113.41"));
      expect(res.status).toBe(200);
    });

    // Review round 2: x-forwarded-for is client-suppliable in general,
    // and this test's own postRequest() helper rotates it for isolation
    // -- which is exactly the attack this route must not fall for. On
    // Vercel, x-vercel-forwarded-for is the header the edge itself sets
    // (per Vercel's docs: "x-forwarded-for could be overwritten if
    // you're using a proxy on top of Vercel" -- x-vercel-forwarded-for is
    // not). The route must key on it when present, so rotating
    // x-forwarded-for on every call can't manufacture a fresh budget.
    it("keys on x-vercel-forwarded-for over x-forwarded-for, so rotating the latter can't defeat the limit", async () => {
      selectProvider.mockReturnValue({ name: "anthropic", complete: vi.fn() });
      botCommentary.mockResolvedValue("commentary");
      const body = { itemName: "X", winner: "ada", price: 500 };

      function requestWithBoth(vercelIp: string, forwardedFor: string): Request {
        return new Request("http://localhost/api/bot", {
          method: "POST",
          headers: { "x-vercel-forwarded-for": vercelIp, "x-forwarded-for": forwardedFor },
          body: JSON.stringify(body),
        });
      }

      // Same trusted header on every call; a different, attacker-rotated
      // x-forwarded-for each time. If the route keyed on x-forwarded-for,
      // every call would land in a fresh bucket and the limit would
      // never trigger.
      for (let i = 0; i < 5; i++) {
        const res = await POST(requestWithBoth("203.0.113.60", `10.0.0.${i}`));
        expect(res.status).toBe(200);
      }
      const limited = await POST(requestWithBoth("203.0.113.60", "10.0.0.99"));
      expect(limited.status).toBe(429);
    });
  });

  // Minor 1 (review round 1): the raw error must never reach the client
  // verbatim -- today nothing in the reachable throw sites embeds a key,
  // but the invariant should not rest on every future error message
  // continuing to avoid that. The detail goes to server-side logs instead.
  describe("error detail does not reach the client", () => {
    it("returns a fixed, generic error string on provider failure -- never the raw error text", async () => {
      selectProvider.mockReturnValue({ name: "gemini", complete: vi.fn() });
      const secretLookingDetail = "gemini request failed: 401 (key sk-live-abc123 rejected)";
      botCommentary.mockRejectedValue(new Error(secretLookingDetail));

      const res = await POST(postRequest({ itemName: "X", winner: "ada", price: 500 }, "203.0.113.50"));
      const json = (await res.json()) as { error?: string };

      expect(json.error).not.toContain(secretLookingDetail);
      expect(json.error).not.toContain("sk-live-abc123");
    });

    it("logs the failure detail server-side via console.error", async () => {
      const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      selectProvider.mockReturnValue({ name: "gemini", complete: vi.fn() });
      botCommentary.mockRejectedValue(new Error("some provider-side detail"));

      await POST(postRequest({ itemName: "X", winner: "ada", price: 500 }, "203.0.113.51"));

      expect(logSpy).toHaveBeenCalled();
      const logged = logSpy.mock.calls.flat().map(String).join(" ");
      expect(logged).toContain("some provider-side detail");

      logSpy.mockRestore();
    });
  });
});
