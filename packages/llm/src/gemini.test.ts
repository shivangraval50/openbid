import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGeminiProvider } from "./gemini";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("createGeminiProvider", () => {
  it("is named 'gemini'", () => {
    expect(createGeminiProvider("g-test").name).toBe("gemini");
  });

  it("sends the system instruction, prompt, and max tokens; the key travels only in the URL", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({ candidates: [{ content: { parts: [{ text: "ok" }] } }] })
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = createGeminiProvider("g-secret-key");
    await provider.complete({ system: "sys prompt", prompt: "hello", maxTokens: 55 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("key=g-secret-key");
    // The key must not also ride in a header -- one transport for it, not two.
    expect(JSON.stringify(init.headers ?? {})).not.toContain("g-secret-key");

    const body = JSON.parse(init.body as string) as {
      systemInstruction: { parts: { text: string }[] };
      contents: { role: string; parts: { text: string }[] }[];
      generationConfig: { maxOutputTokens: number };
    };
    expect(body.systemInstruction.parts[0]?.text).toBe("sys prompt");
    expect(body.contents[0]?.parts[0]?.text).toBe("hello");
    expect(body.contents[0]?.role).toBe("user");
    expect(body.generationConfig.maxOutputTokens).toBe(55);
  });

  it("extracts and joins text from a well-formed response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          candidates: [{ content: { parts: [{ text: "Sold! " }, { text: "Going once." }] } }],
        })
      )
    );
    const provider = createGeminiProvider("g-test");
    const text = await provider.complete({ system: "s", prompt: "p", maxTokens: 10 });
    expect(text).toBe("Sold! Going once.");
  });

  it("returns an empty string when candidates is absent from an otherwise well-formed 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({})));
    const provider = createGeminiProvider("g-test");
    expect(await provider.complete({ system: "s", prompt: "p", maxTokens: 10 })).toBe("");
  });

  it("throws when the HTTP status is not ok, without leaking the API key in the error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const provider = createGeminiProvider("g-super-secret");

    let caught: unknown;
    try {
      await provider.complete({ system: "s", prompt: "p", maxTokens: 10 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).not.toContain("g-super-secret");
  });

  // Requirement 2: the JSON body is genuinely external input. A provider
  // changing its response shape must fail loudly, not produce `undefined`
  // silently flowing through `?.` chains into the UI as an empty comment.
  it("throws a clear error when candidates is present but the wrong type", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ candidates: "not-an-array" })));
    const provider = createGeminiProvider("g-test");
    await expect(
      provider.complete({ system: "s", prompt: "p", maxTokens: 10 })
    ).rejects.toThrow(/malformed|shape|expected/i);
  });

  it("throws a clear error when a candidate's content.parts entries are the wrong shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ candidates: [{ content: { parts: [{ text: 42 }] } }] }))
    );
    const provider = createGeminiProvider("g-test");
    await expect(
      provider.complete({ system: "s", prompt: "p", maxTokens: 10 })
    ).rejects.toThrow(/malformed|shape|expected/i);
  });

  // The "error body with a 200" case named explicitly in Requirement 2:
  // Google's documented error envelope, but arriving with a 200 status
  // instead of the expected 4xx/5xx (e.g. a misbehaving proxy).
  it("throws surfacing the message when a 200 response carries an error body instead of candidates", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { code: 400, message: "API key not valid" } }))
    );
    const provider = createGeminiProvider("g-test");
    await expect(
      provider.complete({ system: "s", prompt: "p", maxTokens: 10 })
    ).rejects.toThrow(/API key not valid/);
  });

  it("throws when the body is not valid JSON at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>not json</html>", { status: 200 }))
    );
    const provider = createGeminiProvider("g-test");
    await expect(provider.complete({ system: "s", prompt: "p", maxTokens: 10 })).rejects.toThrow();
  });
});
