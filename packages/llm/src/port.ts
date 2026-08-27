/**
 * The provider port. Every adapter (Anthropic, Gemini, or a test fake)
 * implements this and nothing more -- no auction concepts, no streaming
 * details, no provider-specific error types leak across this boundary.
 * `botCommentary` (in index.ts) is the only thing in this package that
 * knows what an auction is; everything below it is a generic
 * system-prompt-in, text-out completion call.
 */
export interface CompletionRequest {
  system: string;
  prompt: string;
  maxTokens: number;
}

export interface LlmProvider {
  name: string;
  complete(req: CompletionRequest): Promise<string>;
}
