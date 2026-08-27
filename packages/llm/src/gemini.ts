import { z } from "zod";
import type { LlmProvider } from "./port";

const ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

// Gemini's response is genuinely external input -- unlike the internal,
// same-repo shapes `@openbid/protocol` exists for (see that package's own
// header comment), this schema validates one third-party provider's wire
// format on one side only. It lives here, in `llm`, rather than in
// `@openbid/protocol`, for that reason: it is provider-specific, not a
// contract this repo owns on both ends. `llm` has no other workspace
// dependency (see the task brief's Interfaces section), so it brings its
// own `zod` dependency instead of reaching into protocol's.
//
// Deliberately permissive about *content*: `parts` entries with no `text`
// field are fine (some content-block kinds carry none), and `candidates`
// being absent or empty is a legitimate "nothing to say" outcome (e.g. a
// safety block), not malformed input. What it rejects is a *shape*
// mismatch -- `candidates` present but not an array, `parts` entries that
// aren't objects, a `text` that isn't a string -- which is what the
// brief's `as {candidates?: ...}` cast would let through as `undefined`
// silently flowing into the UI instead of a clear failure.
const geminiPartSchema = z.object({ text: z.string().optional() });
const geminiCandidateSchema = z.object({
  content: z.object({ parts: z.array(geminiPartSchema).optional() }).optional(),
});
const geminiResponseSchema = z.object({
  candidates: z.array(geminiCandidateSchema).optional(),
});

// Google's documented error envelope for a request it rejects outright
// (bad key, quota, disabled API, ...). Checked before the success schema
// so a 200 carrying this shape -- Gemini normally uses a 4xx and the !res.ok
// branch below catches it, but some proxies rewrite the status -- still
// surfaces the real reason instead of silently parsing as "no candidates".
const geminiErrorSchema = z.object({
  error: z.object({ message: z.string() }).passthrough(),
});

/** The free-tier adapter used by the public deploy. Same contract, raw HTTP. */
export function createGeminiProvider(apiKey: string): LlmProvider {
  return {
    name: "gemini",
    async complete(req) {
      const res = await fetch(`${ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: req.system }] },
          contents: [{ role: "user", parts: [{ text: req.prompt }] }],
          generationConfig: { maxOutputTokens: req.maxTokens },
        }),
      });
      // Deliberately omit `res.url` here: it carries the API key as a
      // query parameter, and this message can end up in logs.
      if (!res.ok) throw new Error(`gemini request failed: ${res.status}`);

      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw new Error("gemini response was not valid JSON");
      }

      const errorBody = geminiErrorSchema.safeParse(json);
      if (errorBody.success) {
        throw new Error(`gemini returned an error: ${errorBody.data.error.message}`);
      }

      const body = geminiResponseSchema.safeParse(json);
      if (!body.success) {
        throw new Error(`gemini response did not match the expected shape: ${body.error.message}`);
      }

      return body.data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    },
  };
}
