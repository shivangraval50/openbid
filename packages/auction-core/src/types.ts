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
  /**
   * Whether this participant's `nickname` is a persistent, GitHub-backed
   * identity (`auth.ts` puts the unique `login` there) rather than a
   * guest cookie value. Carried on the participant, not derived at
   * settlement time from a live socket, because the settlement runs in
   * `alarm()` -- there may be no socket left by then, and the state is
   * rebuilt from the event log after an eviction. Only signed-in wins are
   * ranked on the leaderboard; see `apps/web/src/lib/leaderboard.ts`.
   */
  persistent: boolean;
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
  | {
      type: "joined";
      participantId: string;
      nickname: string;
      persistent: boolean;
      atMs: number;
    }
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
