import { createStore, type StoreApi } from "zustand/vanilla";
import { reduce, type AuctionEvent, type AuctionState } from "@openbid/auction-core";
import type { RejectReason, ServerMessage } from "@openbid/protocol";

export interface PendingBid {
  clientSeq: number;
  amount: number;
}

export interface AuctionStoreState {
  server: AuctionState | null;
  youAre: string | null;
  lastSeenSeq: number;
  pending: PendingBid[];
  lastReject: { clientSeq: number; reason: RejectReason } | null;
  clockOffsetMs: number;
  nextClientSeq: number;

  applyServerMessage: (msg: ServerMessage) => void;
  placeOptimisticBid: (amount: number) => number;
  observeClock: (clientSentMs: number, serverTime: number, clientRecvMs: number) => void;
}

export type AuctionStore = StoreApi<AuctionStoreState>;

export function createAuctionStore(): AuctionStore {
  return createStore<AuctionStoreState>()((set, get) => ({
    server: null,
    youAre: null,
    lastSeenSeq: 0,
    pending: [],
    lastReject: null,
    clockOffsetMs: 0,
    nextClientSeq: 1,

    applyServerMessage: (msg) => {
      switch (msg.t) {
        case "snapshot": {
          // The snapshot is authoritative: it reflects every event the
          // server has committed, so any bid still pending locally is
          // moot -- either it is already folded into this state, or the
          // server never saw it and retrying silently would be wrong.
          // `state` crosses the wire as `unknown` (protocol does not own
          // an auction-core schema); `youAre` is a real, validated string
          // field on the message, so it needs no cast at all.
          set({
            server: msg.state as AuctionState,
            youAre: msg.youAre,
            lastSeenSeq: msg.seq,
            pending: [],
          });
          return;
        }
        case "delta": {
          // A delta at or below what we've already applied is a duplicate
          // (e.g. a resume replay overlapping what a snapshot already
          // covered) and must not be reduced twice.
          if (msg.seq <= get().lastSeenSeq) return;
          const server = get().server;
          if (server === null) return; // no snapshot yet to apply this on top of
          set({
            server: reduce(server, msg.event as AuctionEvent),
            lastSeenSeq: msg.seq,
          });
          return;
        }
        case "ack": {
          set((s) => ({
            pending: s.pending.filter((p) => p.clientSeq !== msg.clientSeq),
            lastSeenSeq: Math.max(s.lastSeenSeq, msg.seq),
          }));
          return;
        }
        case "reject": {
          // Rolls back only the rejected bid -- filtering by clientSeq
          // rather than clearing `pending` wholesale -- so sibling
          // optimistic bids survive untouched.
          set((s) => ({
            pending: s.pending.filter((p) => p.clientSeq !== msg.clientSeq),
            lastReject: { clientSeq: msg.clientSeq, reason: msg.reason },
          }));
          return;
        }
        case "pong": {
          // Clock sync is derived by `observeClock`, called directly by
          // the transport layer that actually knows the local receipt
          // time; there is nothing for this generic handler to do.
          return;
        }
      }
    },

    placeOptimisticBid: (amount) => {
      const clientSeq = get().nextClientSeq;
      set((s) => ({
        pending: [...s.pending, { clientSeq, amount }],
        nextClientSeq: s.nextClientSeq + 1,
        // A fresh bid supersedes whatever the last rejection was about; do
        // not let a stale reason linger once the user has tried again.
        lastReject: null,
      }));
      return clientSeq;
    },

    observeClock: (clientSentMs, serverTime, clientRecvMs) => {
      const rtt = clientRecvMs - clientSentMs;
      const serverTimeAtReceipt = serverTime + rtt / 2;
      set({ clockOffsetMs: serverTimeAtReceipt - clientRecvMs });
    },
  }));
}

/**
 * The optimistic price if a pending bid beats the server's, otherwise the
 * server's. A pending bid shows immediately; the server's price takes over
 * once it exceeds it (e.g. once the corresponding delta lands).
 */
export function selectDisplayPrice(s: AuctionStoreState): number {
  const serverPrice = s.server?.highBid?.amount ?? s.server?.config.startingPrice ?? 0;
  const bestPending = s.pending.reduce((max, p) => Math.max(max, p.amount), 0);
  return Math.max(serverPrice, bestPending);
}

export function selectPendingCount(s: AuctionStoreState): number {
  return s.pending.length;
}

/**
 * Server-corrected wall clock. Client code must never call `Date.now()`
 * directly for auction timing -- countdowns render against this instead.
 */
export function selectServerNow(s: AuctionStoreState): number {
  return Date.now() + s.clockOffsetMs;
}

export function selectMsRemaining(s: AuctionStoreState): number {
  if (s.server === null) return 0;
  return Math.max(0, s.server.endsAtMs - selectServerNow(s));
}
