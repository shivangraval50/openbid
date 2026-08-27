import { describe, it, expect, vi, beforeEach } from "vitest";

const selectProvider = vi.fn();
const botCommentary = vi.fn();

vi.mock("@openbid/llm", () => ({ selectProvider, botCommentary }));

const { POST } = await import("./route");

function postRequest(body: unknown): Request {
  return new Request("http://localhost/api/bot", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/bot", () => {
  it("returns the commentary text and the provider name on success", async () => {
    selectProvider.mockReturnValue({ name: "anthropic", complete: vi.fn() });
    botCommentary.mockResolvedValue("Sold to ada for 500.");

    const res = await POST(postRequest({ itemName: "X", winner: "ada", price: 500 }));

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

    const res = await POST(postRequest({ itemName: "X", winner: "ada", price: 500 }));

    expect(res.status).toBe(200);
    const json = (await res.json()) as { text: string; provider: string | null; error?: string };
    expect(json.text).toBe("");
    expect(json.provider).toBeNull();
    expect(json.error).toContain("no LLM provider configured");
  });

  it("degrades to a 200 with empty text when the provider call itself fails (e.g. a malformed response)", async () => {
    selectProvider.mockReturnValue({ name: "gemini", complete: vi.fn() });
    botCommentary.mockRejectedValue(
      new Error("gemini response did not match the expected shape")
    );

    const res = await POST(postRequest({ itemName: "X", winner: "ada", price: 500 }));

    expect(res.status).toBe(200);
    const json = (await res.json()) as { text: string; provider: string | null };
    expect(json.text).toBe("");
    expect(json.provider).toBeNull();
  });

  it("degrades to a 200 with empty text when the request body itself is malformed JSON", async () => {
    const badRequest = new Request("http://localhost/api/bot", {
      method: "POST",
      body: "not json",
    });

    const res = await POST(badRequest);

    expect(res.status).toBe(200);
    const json = (await res.json()) as { text: string; provider: string | null };
    expect(json.text).toBe("");
    expect(json.provider).toBeNull();
  });
});
