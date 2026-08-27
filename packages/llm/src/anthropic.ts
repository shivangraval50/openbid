import Anthropic from "@anthropic-ai/sdk";
import type { LlmProvider } from "./port";

/**
 * The real Claude integration, used in development. `claude-opus-5` is a
 * complete model id (never date-suffixed -- see shared/models.md). Two
 * things about this request shape changed during 2025-2026 and are easy
 * to get wrong from memory, both verified against the installed
 * `@anthropic-ai/sdk` (0.121.0) types rather than assumed:
 *
 *  - `thinking: {type: "adaptive"}` is the only supported "on" form on
 *    this model; the older `{type: "enabled", budget_tokens: N}` shape
 *    is rejected with a 400.
 *  - `temperature`/`top_p`/`top_k` are omitted entirely -- they are
 *    deprecated on this model and a non-default value 400s.
 *
 * Streaming + `.finalMessage()` avoids tripping the SDK's non-streaming
 * HTTP-timeout guard for larger `max_tokens` values, and costs nothing
 * for small ones.
 */
export function createAnthropicProvider(apiKey: string): LlmProvider {
  const client = new Anthropic({ apiKey });

  return {
    name: "anthropic",
    async complete(req) {
      const stream = client.messages.stream({
        model: "claude-opus-5",
        max_tokens: req.maxTokens,
        thinking: { type: "adaptive" },
        system: req.system,
        messages: [{ role: "user", content: req.prompt }],
      });

      const message = await stream.finalMessage();

      // A refusal is HTTP 200 with empty or partial content (the model can
      // decline mid-stream, after already emitting some text). Check this
      // BEFORE reading `content` -- indexing it unconditionally is exactly
      // the bug this guards against, and the partial text must be
      // discarded, not returned as if it were the complete answer.
      if (message.stop_reason === "refusal") return "";

      return message.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");
    },
  };
}
