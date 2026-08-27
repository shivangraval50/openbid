"use client";

import { useState } from "react";
import type { AuctionConfig, AuctionEvent } from "@openbid/auction-core";
import { replayTo } from "@/lib/replay";

/**
 * A scrub control over an archived auction's event log. Defaults to the
 * end of the log (the settled state) and re-derives the displayed price
 * and status from `replayTo` on every change -- there is no separate
 * "current state" kept in sync by hand, so the displayed values can
 * never drift from what `replayTo` itself would compute for that
 * position.
 */
export function Scrubber({
  config,
  events,
}: {
  config: AuctionConfig;
  events: AuctionEvent[];
}) {
  const [position, setPosition] = useState(events.length);
  const state = replayTo(config, events, position);

  return (
    <section>
      <label htmlFor="scrub">Replay position</label>
      <input
        id="scrub"
        type="range"
        min={0}
        max={events.length}
        value={position}
        onChange={(e) => setPosition(Number(e.target.value))}
      />
      <p data-testid="replay-price">{state.highBid?.amount ?? state.config.startingPrice}</p>
      <p data-testid="replay-status">{state.status}</p>
    </section>
  );
}
