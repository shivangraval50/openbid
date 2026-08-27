import type { AuctionEvent, AuctionState, RejectReason } from "./types";

export function minimumBid(state: AuctionState): number {
  return state.highBid === null
    ? state.config.startingPrice
    : state.highBid.amount + state.config.minIncrement;
}

export interface BidCommand {
  participantId: string;
  amount: number;
  atMs: number;
}

export type BidDecision =
  | { ok: true; event: AuctionEvent }
  | { ok: false; reason: RejectReason };

export function validateBid(state: AuctionState, cmd: BidCommand): BidDecision {
  const participant = state.participants[cmd.participantId];
  if (state.status === "closed" || cmd.atMs >= state.endsAtMs || participant === undefined) {
    return { ok: false, reason: "AUCTION_CLOSED" };
  }
  if (cmd.amount < minimumBid(state)) {
    return { ok: false, reason: "TOO_LOW" };
  }
  if (cmd.amount > participant.budget) {
    return { ok: false, reason: "INSUFFICIENT_BUDGET" };
  }

  const insideAntiSnipeWindow =
    state.endsAtMs - cmd.atMs <= state.config.antiSnipeWindowMs;
  const newEndsAtMs = insideAntiSnipeWindow
    ? cmd.atMs + state.config.antiSnipeExtensionMs
    : state.endsAtMs;

  return {
    ok: true,
    event: {
      type: "bidPlaced",
      participantId: cmd.participantId,
      amount: cmd.amount,
      atMs: cmd.atMs,
      newEndsAtMs,
    },
  };
}
