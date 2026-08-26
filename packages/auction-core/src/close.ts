import type { AuctionEvent, AuctionState } from "./types";

export function closeAuction(state: AuctionState, atMs: number): AuctionEvent | null {
  if (state.status === "closed") return null;
  return {
    type: "closed",
    atMs,
    winner:
      state.highBid === null
        ? null
        : { participantId: state.highBid.participantId, amount: state.highBid.amount },
  };
}
