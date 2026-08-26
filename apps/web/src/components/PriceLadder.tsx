import type { AuctionState } from "@openbid/auction-core";

export function PriceLadder({
  state,
  displayPrice,
  pendingCount,
}: {
  state: AuctionState;
  displayPrice: number;
  pendingCount: number;
}) {
  const leader =
    state.highBid === null
      ? "no bids yet"
      : state.participants[state.highBid.participantId]?.nickname ?? "unknown";

  return (
    <section aria-label="Current price">
      <p data-testid="display-price">{displayPrice}</p>
      <p>Leader: {leader}</p>
      {pendingCount > 0 ? <p data-testid="pending">confirming…</p> : null}
    </section>
  );
}
