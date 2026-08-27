import styles from "./Countdown.module.css";

export function formatRemaining(ms: number): string {
  const clamped = Math.max(0, ms);
  const total = Math.floor(clamped / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * The anti-snipe extension, as the amount of time the deadline just gained.
 *
 * `null` means "no extension": either the deadline did not move, or it moved
 * *backwards*. Backwards is worth handling rather than asserting away -- a
 * reconnecting client rebases on a snapshot and can legitimately observe a
 * lower `endsAtMs` than the one it had optimistically extended -- and
 * announcing "the deadline was extended by -3 seconds" would be worse than
 * saying nothing.
 */
export function extensionDeltaMs(previousEndsAtMs: number, endsAtMs: number): number | null {
  const delta = endsAtMs - previousEndsAtMs;
  return delta > 0 ? delta : null;
}

/** Whole seconds, rounded up, so a 15,000ms extension reads "+15s". */
export function formatExtension(ms: number): string {
  return `+${Math.ceil(ms / 1000)}s`;
}

// `msRemaining` must be computed by the caller from the store's
// server-corrected clock (`selectMsRemaining`/`selectServerNow`), never
// from this component's own `Date.now()` -- there is no local timestamp
// read here at all, by design.
export function Countdown({
  msRemaining,
  extendedByMs = null,
}: {
  msRemaining: number;
  extendedByMs?: number | null;
}) {
  const urgent = msRemaining <= 10_000;
  return (
    <div className={styles.clock}>
      <span
        className={styles.time}
        role="timer"
        aria-live="off"
        data-urgent={urgent ? "true" : "false"}
      >
        {formatRemaining(msRemaining)}
      </span>
      {/* Deliberately NOT role="status" (and not aria-live either): the room
          page already has exactly one role="status" -- ConnectionBanner --
          and an end-to-end spec asserts on that single match. A second
          status role here would make `getByRole("status")` ambiguous and
          break it. The badge is visible text next to the timer it
          describes, which is where feedback.md wants status feedback:
          "integrated into your interface ... near the items it describes". */}
      {extendedByMs !== null ? (
        <span className={styles.badge}>
          <span className={styles.badgeDelta}>{formatExtension(extendedByMs)}</span>
          anti-snipe extension
        </span>
      ) : null}
    </div>
  );
}
