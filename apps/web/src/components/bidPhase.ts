"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The optimistic-bid lifecycle, as a value the UI can render.
 *
 * The store already models the *facts* -- how many bids are locally pending
 * (`selectPendingCount`) and which one the server last refused
 * (`lastReject`) -- but the interesting thing to show a bidder is the
 * TRANSITION between those facts, and a transition is not a fact you can read
 * off a single snapshot. "Your bid was accepted" is precisely "there was a
 * pending bid a moment ago, there is none now, and no rejection arrived",
 * which is only visible by comparing two consecutive observations.
 *
 * `confirmed` and `rejected` are therefore momentary: they describe something
 * that just happened, not a state the room is in. `useBidPhase` below decays
 * both back to `idle` on a timer.
 */
export type BidPhase = "idle" | "pending" | "confirmed" | "rejected";

export interface BidObservation {
  pendingCount: number;
  /**
   * `lastReject.clientSeq`, or `null` if the server has never refused a bid
   * from this client. The SEQUENCE NUMBER, not a boolean: `lastReject` is
   * sticky (the store never clears it), so "has a rejection" is true forever
   * after the first one. Only a *change* of clientSeq distinguishes a fresh
   * rejection from the stale record of an old one.
   */
  lastRejectSeq: number | null;
}

/**
 * Pure transition function: what just happened, given where we were and where
 * we are now.
 *
 * Rejection is tested FIRST because a rejection also empties `pending` (see
 * the store's `reject` branch, which filters the rejected clientSeq out).
 * Checking `pendingCount` first would therefore report a refused bid as
 * `confirmed` -- the exact inversion of its meaning.
 */
export function resolveBidPhase(prev: BidObservation, next: BidObservation): BidPhase {
  if (next.lastRejectSeq !== null && next.lastRejectSeq !== prev.lastRejectSeq) {
    return "rejected";
  }
  if (next.pendingCount > 0) return "pending";
  if (prev.pendingCount > 0) return "confirmed";
  return "idle";
}

/** How long a `confirmed`/`rejected` flash lasts before decaying to `idle`. */
export const RESOLVE_HOLD_MS = 900;

/**
 * Tracks the lifecycle across renders.
 *
 * Returns `idle` on the very first render by construction -- the previous
 * observation is seeded with the current one -- which is what keeps this
 * hydration-safe: the server render and the client's first render both see
 * `idle`, so the markup matches. A seed of `{ pendingCount: 0 }` would make
 * a page that server-renders with a pending bid announce a spurious
 * "confirmed" on hydration.
 */
export function useBidPhase(observation: BidObservation): BidPhase {
  const previous = useRef(observation);
  const [phase, setPhase] = useState<BidPhase>("idle");

  const { pendingCount, lastRejectSeq } = observation;

  useEffect(() => {
    const next = resolveBidPhase(previous.current, { pendingCount, lastRejectSeq });
    previous.current = { pendingCount, lastRejectSeq };
    setPhase(next);

    if (next !== "confirmed" && next !== "rejected") return;
    const id = setTimeout(() => setPhase("idle"), RESOLVE_HOLD_MS);
    return () => clearTimeout(id);
  }, [pendingCount, lastRejectSeq]);

  return phase;
}
