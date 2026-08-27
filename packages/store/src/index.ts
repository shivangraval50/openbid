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
  // The REAL, measured clock offset. `null` means "no real round trip has
  // been measured yet." Only `observeClock` (a genuine send/receive round
  // trip) may set this to a number; `seedFromSnapshot` deliberately leaves
  // it alone. This used to be derived provisionally from `serverTime -
  // Date.now()` at seed time, but that computation reads the local clock at
  // a different real moment on the server (during SSR) than on the client
  // (during hydration) -- the two calls are separated by whatever the real
  // SSR-to-hydration latency happens to be. `Latency` displays this value
  // raw (that is its whole purpose), so it was rendering that latency
  // mislabelled as clock skew, differently on each render -- a genuine
  // hydration mismatch whenever that latency crossed its threshold. A pong
  // cannot arrive before mount, so SSR and the first client render now
  // necessarily agree: both see `null`, and `Latency` renders a static
  // placeholder for that case instead of a fabricated number.
  clockOffsetMs: number | null;
  // A SEPARATE provisional anchor, used only by `selectServerNow` (i.e. by
  // `Countdown`/`PriceChart`'s numeric timing math), never displayed raw.
  // This is exactly the old `clockOffsetMs` seed-time computation, kept
  // here instead of removed outright: for a *numeric* correction that gets
  // added back to a fresh `Date.now()` in the same synchronous render pass
  // that seeded it, the SSR-vs-hydration timing difference cancels out
  // algebraically (`selectServerNow`'s doc comment works through this), so
  // it is provably safe from the same hydration-mismatch class that made
  // `clockOffsetMs` unsafe to use for *display*. Removing it entirely (as
  // opposed to just not exposing it as `clockOffsetMs`) would have traded
  // the fixed `Latency` mismatch for an equivalent, newly-introduced one in
  // `Countdown` -- confirmed by actually deleting it and rerunning this
  // suite: `Countdown` started hydration-mismatching too, e.g. "2:58" vs
  // "2:59", the two renders' bare `Date.now()` calls now genuinely seconds
  // apart with nothing anchoring them together. Superseded by the real
  // `clockOffsetMs` once one exists (see `selectServerNow`).
  provisionalOffsetMs: number;
  nextClientSeq: number;

  applyServerMessage: (msg: ServerMessage) => void;
  seedFromSnapshot: (seq: number, serverTime: number, state: AuctionState) => void;
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
    clockOffsetMs: null,
    provisionalOffsetMs: 0,
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
          // `lastSeenSeq` means exactly "the highest seq I have applied to
          // `server` via `reduce`" -- it must advance only from a `delta`,
          // never from an `ack`. `RoomDO` broadcasts the delta for an
          // accepted bid (including back to the bidder's own socket)
          // before sending that bid's ack, so by the time this ack
          // arrives the matching delta has normally already been reduced
          // into `server`. But that ordering is a courtesy, not something
          // this handler may depend on: if an ack advanced `lastSeenSeq`
          // on its own, a delta that arrived out of order, or one lost to
          // a swallowed per-socket send failure, would then be dropped as
          // a "duplicate" it never actually applied -- silently freezing
          // `server.highBid` behind the bidder's own accepted bid. Leaving
          // `lastSeenSeq` alone here means that failure mode instead just
          // waits for the next delta (or falls behind enough to trigger a
          // resync snapshot) -- never a silent, permanent divergence.
          // `ack.seq` is kept on the wire for debugging only; it is not a
          // resume-position input.
          set((s) => ({
            pending: s.pending.filter((p) => p.clientSeq !== msg.clientSeq),
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

    // Seeds the store from the HTTP `/snapshot` envelope (used for the SSR
    // first paint). Deliberately not routed through `applyServerMessage`'s
    // "snapshot" case: that case's message shape requires `youAre`, a real
    // field the server always sends over a live connection but which an
    // HTTP request -- having no connection, and therefore no participant
    // identity -- correctly has no value for. Faking a `youAre` here (or
    // widening the wire schema to make it optional) would misrepresent an
    // invariant the server actually satisfies on every socket snapshot.
    // Identity becomes known only once the socket's own "snapshot" message
    // arrives and goes through `applyServerMessage` normally.
    //
    // Guarded like the `delta` case above, for the same reason: once real
    // server state exists, a seed at or below `lastSeenSeq` must be a
    // no-op, not a regression. The reachable path is an SSR re-seed (e.g.
    // a `router.refresh()` whose HTTP refetch was issued before the socket
    // had applied deltas the refetch doesn't yet reflect) -- without this
    // guard, `server` would silently walk backwards and `lastSeenSeq`
    // would drop, and the seqs in between are never redelivered, since the
    // DO only replays on a fresh `hello`. The very first seed against a
    // brand-new store is never blocked: `server` is still `null` then,
    // regardless of what `seq` is.
    //
    // Deliberately does NOT touch the real, measured `clockOffsetMs` --
    // only `observeClock` may set that one, and only from an actual round
    // trip. It DOES seed `provisionalOffsetMs` from `serverTime -
    // Date.now()`, same as `clockOffsetMs` itself used to: see that
    // field's doc comment for why this specific computation is safe here
    // (numeric use, same synchronous render pass) even though it would not
    // have been safe to display raw.
    seedFromSnapshot: (seq, serverTime, state) => {
      const current = get();
      if (current.server !== null && seq <= current.lastSeenSeq) return;
      set({
        server: state,
        lastSeenSeq: seq,
        pending: [],
        provisionalOffsetMs: serverTime - Date.now(),
      });
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
 *
 * Prefers the real, measured `clockOffsetMs` once one exists; falls back to
 * `provisionalOffsetMs` (seeded from the SSR snapshot's `serverTime`) until
 * then. That fallback is what keeps `Countdown`/`PriceChart` hydration
 * -consistent: `provisionalOffsetMs = serverTime - Date.now()` and this
 * read (`Date.now() + provisionalOffsetMs`) both happen within the same
 * synchronous render, on both the server render and the client's hydration
 * render, so the two `Date.now()` calls are microseconds apart and the
 * result reduces to `serverTime` either way -- the real SSR-to-hydration
 * latency cancels out of the *sum*, even though it would not cancel out of
 * `provisionalOffsetMs` read in isolation (which is exactly why `Latency`
 * must never display `provisionalOffsetMs`, only the real `clockOffsetMs`).
 * The window before either offset exists (a brand-new store, no seed and
 * no pong yet) falls back further to bare `Date.now()` (offset 0); that
 * window is intentionally short in practice since `connectRoom` pings
 * immediately on open rather than waiting for its 5s interval.
 */
export function selectServerNow(s: AuctionStoreState): number {
  return Date.now() + (s.clockOffsetMs ?? s.provisionalOffsetMs);
}

export function selectMsRemaining(s: AuctionStoreState): number {
  if (s.server === null) return 0;
  return Math.max(0, s.server.endsAtMs - selectServerNow(s));
}
