"use client";

import { useEffect, useState } from "react";
import styles from "./Commentary.module.css";

/**
 * Post-settlement auction commentary, fetched from `/api/bot` once the
 * room's authoritative `closed` event has landed.
 *
 * Decoration, not product surface: every failure path renders nothing at
 * all. A missing `GEMINI_API_KEY`/`ANTHROPIC_API_KEY` (the default state
 * of a fresh deploy), a dead network, this route's own rate limiter, a
 * provider changing its response shape -- all of them leave the room page
 * rendering exactly what it rendered before. Nothing here can throw into
 * the render tree.
 *
 * Props are PRIMITIVES, deliberately, not an `AuctionOutcome` object.
 * `LiveRoom` derives them inline on every one of its 250ms countdown
 * re-renders, so an object prop would get a fresh identity ~4 times a
 * second; used as an effect dependency that is an unbounded request loop
 * against a per-token-billed provider. Primitive dependencies make the
 * effect fire exactly once, on the transition into `settled`.
 *
 * `settled` must come from the server's own `status === "closed"`, NOT
 * from the countdown reaching zero. Those differ by one round trip, and
 * during that window `winner` is still null -- requesting then would
 * produce commentary about an auction that closed "with no bids" moments
 * before the real winner arrived, and then a second request once it did.
 */
export function Commentary(props: {
  settled: boolean;
  itemName: string;
  winner: string | null;
  price: number | null;
}) {
  const [text, setText] = useState("");
  const { settled, itemName, winner, price } = props;

  useEffect(() => {
    if (!settled) return;

    // `/api/bot` validates a discriminated union: winner and price are
    // either both present or both null. A half-populated pair is a 400
    // (a caller error, correctly distinguished there from a provider
    // failure), so collapse it here rather than posting a body the route
    // is contractually obliged to reject. Reachable: LiveRoom resolves
    // the winner's nickname out of `state.participants`, a lookup that
    // can miss.
    const outcome =
      winner !== null && winner !== "" && price !== null && Number.isFinite(price)
        ? { itemName, winner, price }
        : { itemName, winner: null, price: null };

    // Guards against applying a response to an unmounted component, and
    // against a stale in-flight response overwriting a newer one if the
    // outcome somehow changes while a request is open.
    let cancelled = false;

    void (async () => {
      try {
        const res = await fetch("/api/bot", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(outcome),
        });
        // A non-2xx is a caller/limit error (400/429), not "the LLM had
        // nothing to say" -- either way there is nothing to render.
        if (!res.ok) return;
        const body: unknown = await res.json();
        const candidate = (body as { text?: unknown }).text;
        // Checked, not cast: a `text` that is absent or not a string is
        // exactly the shape a bare read would render as the literal
        // "undefined" or "[object Object]" in the UI.
        if (typeof candidate !== "string" || candidate.trim() === "") return;
        if (!cancelled) setText(candidate);
      } catch {
        // Network failure, or a 200 whose body is not JSON. Silent by
        // design -- see this component's doc comment.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [settled, itemName, winner, price]);

  if (text === "") return null;
  return (
    <p className={styles.commentary} data-testid="commentary" aria-label="Auction commentary">
      {text}
    </p>
  );
}
