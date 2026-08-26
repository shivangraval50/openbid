export type RejectReason =
  | "TOO_LOW"
  | "AUCTION_CLOSED"
  | "RATE_LIMITED"
  | "INSUFFICIENT_BUDGET";

export interface AuctionConfig {
  itemName: string;
  startingPrice: number;
  minIncrement: number;
  startingBudget: number;
  antiSnipeWindowMs: number;
  antiSnipeExtensionMs: number;
  endsAtMs: number;
}

export interface Participant {
  id: string;
  nickname: string;
  budget: number;
}

export interface Bid {
  participantId: string;
  amount: number;
  atMs: number;
}

export interface AuctionState {
  config: AuctionConfig;
  status: "open" | "closed";
  endsAtMs: number;
  highBid: Bid | null;
  participants: Record<string, Participant>;
  winner: { participantId: string; amount: number } | null;
}

export type AuctionEvent =
  | { type: "joined"; participantId: string; nickname: string; atMs: number }
  | {
      type: "bidPlaced";
      participantId: string;
      amount: number;
      atMs: number;
      newEndsAtMs: number;
    }
  | {
      type: "closed";
      atMs: number;
      winner: { participantId: string; amount: number } | null;
    };
