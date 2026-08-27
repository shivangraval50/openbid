import { botCommentary, selectProvider } from "@openbid/llm";

/**
 * Commentary is decoration, never load-bearing for the auction: a missing
 * key, a network failure, or a provider changing its response shape must
 * all degrade to an empty comment with a 200, not a thrown error that
 * Next.js turns into a 500 for the room page's fetch. `request.json()`
 * is deliberately inside the try block too -- a malformed request body
 * is the same kind of "must not break the route" failure as a provider
 * outage, not a different code path.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as {
      itemName: string;
      winner: string | null;
      price: number | null;
    };

    const provider = selectProvider({
      LLM_PROVIDER: process.env.LLM_PROVIDER,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    });
    const text = await botCommentary(provider, body);
    return Response.json({ text, provider: provider.name });
  } catch (error) {
    return Response.json({ text: "", provider: null, error: String(error) }, { status: 200 });
  }
}
