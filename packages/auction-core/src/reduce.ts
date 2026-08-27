import type { AuctionConfig, AuctionEvent, AuctionState } from "./types";

export function initialState(config: AuctionConfig): AuctionState {
  return {
    config,
    status: "open",
    endsAtMs: config.endsAtMs,
    highBid: null,
    participants: {},
    winner: null,
  };
}

export function reduce(state: AuctionState, event: AuctionEvent): AuctionState {
  switch (event.type) {
    case "joined": {
      if (state.participants[event.participantId] !== undefined) return state;
      return {
        ...state,
        participants: {
          ...state.participants,
          [event.participantId]: {
            id: event.participantId,
            nickname: event.nickname,
            budget: state.config.startingBudget,
            persistent: event.persistent,
          },
        },
      };
    }
    case "bidPlaced": {
      return {
        ...state,
        endsAtMs: event.newEndsAtMs,
        highBid: {
          participantId: event.participantId,
          amount: event.amount,
          atMs: event.atMs,
        },
      };
    }
    case "closed": {
      return { ...state, status: "closed", winner: event.winner };
    }
  }
}
