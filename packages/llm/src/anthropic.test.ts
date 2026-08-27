import { describe, it, expect, vi, beforeEach } from "vitest";

// The SDK's default export is a client class; mock it so no real network
// call is ever made (see task-18 brief: "do not make live API calls to
// either provider in tests"). `streamMock` stands in for
// `client.messages.stream(...)`, which returns a stream object whose
// `.finalMessage()` resolves to the completed Message.
const streamMock = vi.fn();
const ClientMock = vi.fn().mockImplementation(() => ({
  messages: { stream: streamMock },
}));

vi.mock("@anthropic-ai/sdk", () => ({ default: ClientMock }));

const { createAnthropicProvider } = await import("./anthropic");

function fakeStream(finalMessage: unknown) {
  return { finalMessage: vi.fn().mockResolvedValue(finalMessage) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createAnthropicProvider", () => {
  it("is named 'anthropic'", () => {
    expect(createAnthropicProvider("sk-test").name).toBe("anthropic");
  });

  it("constructs the SDK client with exactly the given API key", () => {
    createAnthropicProvider("sk-test-secret");
    expect(ClientMock).toHaveBeenCalledWith({ apiKey: "sk-test-secret" });
  });

  // Requirement 1: model id is a complete id with no date suffix, adaptive
  // thinking is the only thinking config sent, and temperature/top_p/top_k
  // are never sent (they 400 on this model). A plausible-but-wrong
  // implementation might send `{type: "enabled", budget_tokens: N}` (the
  // stale form) or a dated model id, or carry over a `temperature: 1`
  // default from another codebase -- this test fails on any of those.
  it("sends claude-opus-5, adaptive thinking, and no sampling parameters", async () => {
    streamMock.mockReturnValue(
      fakeStream({ stop_reason: "end_turn", content: [{ type: "text", text: "hi" }] })
    );
    const provider = createAnthropicProvider("sk-test");
    await provider.complete({ system: "You are terse.", prompt: "hello", maxTokens: 123 });

    expect(streamMock).toHaveBeenCalledTimes(1);
    const [request] = streamMock.mock.calls[0] as [Record<string, unknown>];

    expect(request.model).toBe("claude-opus-5");
    expect(request.thinking).toEqual({ type: "adaptive" });
    expect(request.max_tokens).toBe(123);
    expect(request.system).toBe("You are terse.");
    expect(request.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(request).not.toHaveProperty("temperature");
    expect(request).not.toHaveProperty("top_p");
    expect(request).not.toHaveProperty("top_k");
  });

  it("joins multiple text blocks and ignores non-text blocks such as thinking", async () => {
    streamMock.mockReturnValue(
      fakeStream({
        stop_reason: "end_turn",
        content: [
          { type: "thinking", thinking: "reasoning the caller must never see here", signature: "sig" },
          { type: "text", text: "Going once, going twice, " },
          { type: "text", text: "sold." },
        ],
      })
    );
    const provider = createAnthropicProvider("sk-test");
    const text = await provider.complete({ system: "sys", prompt: "hello", maxTokens: 10 });
    expect(text).toBe("Going once, going twice, sold.");
  });

  // Requirement 1's core case: a refusal returns HTTP 200 with empty OR
  // partial content. Code that reads `content[0]` unconditionally breaks
  // on the empty case; code that forgets the check at all leaks the
  // partial pre-refusal text on the non-empty case. Both are covered.
  it("returns an empty string on refusal when content is empty", async () => {
    streamMock.mockReturnValue(
      fakeStream({ stop_reason: "refusal", content: [], stop_details: { category: "cyber" } })
    );
    const provider = createAnthropicProvider("sk-test");
    const text = await provider.complete({ system: "sys", prompt: "hello", maxTokens: 10 });
    expect(text).toBe("");
  });

  it("returns an empty string on refusal even when partial content was streamed before the decline", async () => {
    streamMock.mockReturnValue(
      fakeStream({
        stop_reason: "refusal",
        content: [{ type: "text", text: "partial output that must be discarded, not returned" }],
      })
    );
    const provider = createAnthropicProvider("sk-test");
    const text = await provider.complete({ system: "sys", prompt: "hello", maxTokens: 10 });
    expect(text).toBe("");
  });

  // Constraint: "Never log or echo an API key." A regression here would be
  // e.g. a stray `console.log(apiKey)` added while debugging.
  it("never logs the API key while completing a request", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    streamMock.mockReturnValue(
      fakeStream({ stop_reason: "end_turn", content: [{ type: "text", text: "hi" }] })
    );

    const provider = createAnthropicProvider("sk-super-secret-key-12345");
    await provider.complete({ system: "sys", prompt: "hello", maxTokens: 10 });

    const logged = [...logSpy.mock.calls, ...errorSpy.mock.calls, ...warnSpy.mock.calls]
      .flat()
      .map((v) => String(v))
      .join(" ");
    expect(logged).not.toContain("sk-super-secret-key-12345");

    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
