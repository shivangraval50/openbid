import type { AuctionState } from "@openbid/auction-core";
import type { BidPhase } from "./bidPhase";
import styles from "./PriceLadder.module.css";

export function PriceLadder({
  state,
  displayPrice,
  pendingCount,
  minimum,
  phase = "idle",
}: {
  state: AuctionState;
  displayPrice: number;
  pendingCount: number;
  /**
   * The lowest amount the server would currently accept. Optional so that
   * the two reference rungs are additive: a caller that has not computed a
   * minimum still gets a valid, complete price readout.
   */
  minimum?: number;
  /** Where the caller's own last bid is in its lifecycle. See bidPhase.ts. */
  phase?: BidPhase;
}) {
  const leader =
    state.highBid === null
      ? "no bids yet"
      : state.participants[state.highBid.participantId]?.nickname ?? "unknown";

  return (
    <section className={styles.ladder} aria-label="Current price">
      <p className={styles.eyebrow}>Current price</p>
      {/* `data-phase` drives the provisional/confirmed/rejected treatment in
          CSS. It sits on the WRAPPER, not on the price element itself, so
          that `data-testid="display-price"` keeps rendering the bare number
          as its only child and its only attributes stay in the order the
          server-render assertion in LiveRoom.test.tsx matches. */}
      <div className={styles.priceRow} data-phase={phase}>
        <p className={styles.price} data-testid="display-price">
          {displayPrice}
        </p>
      </div>
      <div className={styles.pendingSlot}>
        {pendingCount > 0 ? (
          <p className={styles.pending} data-testid="pending">
            <span className={styles.pendingDot} aria-hidden="true" />
            confirming…
          </p>
        ) : null}
      </div>
      <p className={styles.leader}>
        Leader: <span className={styles.leaderName}>{leader}</span>
      </p>
      <div className={styles.rungs}>
        {minimum === undefined ? null : (
          <p className={`${styles.rung} ${styles.rungNext}`}>
            <span className={styles.rungLabel}>Next bid at least</span>
            <span className={styles.rungValue}>{minimum}</span>
          </p>
        )}
        <p className={styles.rung}>
          <span className={styles.rungLabel}>Opened at</span>
          <span className={styles.rungValue}>{state.config.startingPrice}</span>
        </p>
      </div>
    </section>
  );
}
