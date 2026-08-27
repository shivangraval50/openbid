"use client";

import { useState } from "react";
import type { AuctionConfig, AuctionEvent } from "@openbid/auction-core";
import { replayTo } from "@/lib/replay";
import styles from "./replay.module.css";

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
  const price = state.highBid?.amount ?? state.config.startingPrice;

  return (
    <section className={styles.panel}>
      <div className={styles.readout}>
        <div className={styles.priceCell}>
          <p className={styles.eyebrow}>Price at this point</p>
          <p className={styles.price} data-testid="replay-price">
            {price}
          </p>
        </div>
        <div className={styles.statusCell}>
          <p className={styles.eyebrow}>Status</p>
          <p
            className={`${styles.status} ${
              state.status === "closed" ? styles.statusClosed : styles.statusOpen
            }`}
            data-testid="replay-status"
          >
            {state.status}
          </p>
        </div>
      </div>

      <div className={styles.scrubGroup}>
        <div className={styles.scrubHead}>
          <label htmlFor="scrub" className={styles.scrubLabel}>
            Replay position
          </label>
          {/* A determinate position readout beside a determinate control --
              loading.md: "you use a determinate progress indicator when you
              know how long loading will take". Here we know exactly where in
              the log we are, so say so in figures rather than leaving the
              thumb's position as the only cue. */}
          <span className={styles.scrubPosition}>
            {position} / {events.length}
          </span>
        </div>
        <input
          id="scrub"
          type="range"
          min={0}
          max={events.length}
          value={position}
          onChange={(e) => setPosition(Number(e.target.value))}
          className={styles.scrub}
        />
        <p className={styles.hint}>
          Every value above is re-derived from the archived log by the same
          reducer the live auction used.
        </p>
      </div>
    </section>
  );
}
