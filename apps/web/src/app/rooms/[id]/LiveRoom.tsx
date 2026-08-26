"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { minimumBid, type AuctionState } from "@openbid/auction-core";
import {
  createAuctionStore,
  selectDisplayPrice,
  selectMsRemaining,
  selectPendingCount,
  selectServerNow,
} from "@openbid/store";
import { connectRoom, type ConnStatus, type RoomConnection } from "@/lib/socket";
import { useAuctionSelector } from "@/hooks/useAuctionStore";
import { BidForm } from "@/components/BidForm";
import { ConnectionBanner } from "@/components/ConnectionBanner";
import { Countdown } from "@/components/Countdown";
import { PriceLadder } from "@/components/PriceLadder";
import { Latency } from "@/components/Latency";
import { PriceChart } from "@/components/PriceChart";

export function LiveRoom(props: {
  roomId: string;
  initialSeq: number;
  initialServerTime: number;
  initialState: AuctionState;
  socketBaseUrl: string;
  nickname?: string;
}) {
  // Seeded synchronously, during render, inside the same `useMemo` that
  // creates the store -- NOT in a `useEffect`. Effects never run during
  // server rendering, so seeding there would mean the server-rendered HTML
  // (the entire point of this task: a real, priced first paint before any
  // socket opens) contained no price at all, and the client's first paint
  // would show "Loading…" until hydration's effects caught up. Seeding
  // here means `useSyncExternalStore`'s `getServerSnapshot` path already
  // sees real state on the server, and the client's first render matches
  // it exactly.
  //
  // Deliberately NOT `applyServerMessage({ t: "snapshot", ... })`: that
  // wire message requires `youAre`, a real per-connection field the HTTP
  // `/snapshot` endpoint has no value for (no connection, no participant
  // identity). `seedFromSnapshot` sets `server`/`lastSeenSeq`/`pending`
  // exactly as that case does, but leaves `youAre` null -- true until the
  // socket's own snapshot arrives -- and derives a provisional clock offset
  // from `initialServerTime` so the very first countdown render is already
  // server-corrected rather than trusting the local clock by default.
  //
  // Only depends on `roomId`: this is a "seed once, at construction" store,
  // not one that re-seeds on every prop change. `seedFromSnapshot` also
  // carries its own monotonicity guard (a regressive seq is a no-op once
  // real server state exists), so even a future caller that does re-run
  // this can't walk applied state backwards.
  const store = useMemo(() => {
    const s = createAuctionStore();
    s.getState().seedFromSnapshot(props.initialSeq, props.initialServerTime, props.initialState);
    return s;
    // Deliberately keyed on `roomId` alone, not `initialSeq`/`initialState`:
    // this seeds once, at construction, for this room. It intentionally
    // does not react to those props changing on a later re-render (e.g. a
    // parent re-fetching the SSR snapshot) -- once the socket is live, the
    // store already holds newer, authoritative state, and `seedFromSnapshot`'s
    // own monotonicity guard would reject a stale reseed attempt anyway.
  }, [props.roomId]);

  const connRef = useRef<RoomConnection | null>(null);
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const [, forceTick] = useState(0);

  useEffect(() => {
    const url = `${props.socketBaseUrl.replace(/^http/, "ws")}/rooms/${props.roomId}/ws`;
    const conn = connectRoom({
      url,
      nickname: props.nickname ?? "guest",
      store,
      onStatus: setStatus,
    });
    connRef.current = conn;
    return () => conn.close();
  }, [props.roomId, props.socketBaseUrl, props.nickname, store]);

  // Re-render the countdown on a timer; the clock value itself comes from
  // the store's server-corrected offset, never from a local timestamp.
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, []);

  // Only *pure* state goes through `useAuctionSelector` (`useSyncExternalStore`
  // underneath). `selectMsRemaining`/`selectServerNow` call `Date.now()`
  // internally, so their result is different on almost every call --
  // violating `useSyncExternalStore`'s documented contract that
  // `getSnapshot` return a stable, cacheable value (React's own docs warn
  // this can produce an unnecessary extra render, or in dev mode a
  // "should be cached" console warning, when the store is checked for
  // tearing between render and commit). Computed directly from
  // `store.getState()` in the render body instead:
  // the existing 250ms `forceTick` already drives the re-render this needs,
  // so nothing is lost by not routing it through the subscription.
  const server = useAuctionSelector(store, (s) => s.server);
  const displayPrice = useAuctionSelector(store, selectDisplayPrice);
  const pendingCount = useAuctionSelector(store, selectPendingCount);
  const lastReject = useAuctionSelector(store, (s) => s.lastReject);
  const clockOffsetMs = useAuctionSelector(store, (s) => s.clockOffsetMs);
  const msRemaining = selectMsRemaining(store.getState());
  const serverNow = selectServerNow(store.getState());

  if (server === null) return <p>Loading…</p>;

  const closed = server.status === "closed" || msRemaining <= 0;

  return (
    <>
      <ConnectionBanner status={status} />
      <Countdown msRemaining={msRemaining} />
      <PriceLadder state={server} displayPrice={displayPrice} pendingCount={pendingCount} />
      <PriceChart price={displayPrice} serverNow={serverNow} />
      <Latency offsetMs={clockOffsetMs} />
      <BidForm
        minimum={minimumBid(server)}
        disabled={closed || status !== "open"}
        rejectReason={lastReject?.reason ?? null}
        onBid={(amount) => {
          const clientSeq = store.getState().placeOptimisticBid(amount);
          connRef.current?.send({ t: "bid", clientSeq, amount });
        }}
      />
      {closed ? (
        // Resolved by nickname, never by comparing `youAre` to
        // `winner.participantId`: a reconnecting client gets a *new*
        // participantId, so that comparison would tell a winner who
        // disconnected before close that they lost. No "you won" self
        // -indicator is rendered here for the same reason -- see the task
        // report for the open question on whether one belongs at all.
        <p data-testid="outcome">
          {server.winner === null
            ? "Closed with no bids."
            : `Won by ${server.participants[server.winner.participantId]?.nickname ?? "unknown"} at ${server.winner.amount}.`}
        </p>
      ) : null}
    </>
  );
}
