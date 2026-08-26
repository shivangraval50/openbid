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
  initialState: AuctionState;
  socketBaseUrl: string;
  nickname?: string;
}) {
  const store = useMemo(() => createAuctionStore(), []);
  const connRef = useRef<RoomConnection | null>(null);
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const [, forceTick] = useState(0);

  // Seed from the SSR snapshot so the first paint is already correct.
  // Deliberately NOT `applyServerMessage({ t: "snapshot", ... })`: that
  // wire message requires `youAre`, a real per-connection field the HTTP
  // `/snapshot` endpoint has no value for (no connection, no participant
  // identity). `seedFromSnapshot` sets `server`/`lastSeenSeq`/`pending`
  // exactly as that case does, but leaves `youAre` null -- true until the
  // socket's own snapshot arrives.
  useEffect(() => {
    store.getState().seedFromSnapshot(props.initialSeq, Date.now(), props.initialState);
  }, [store, props.initialSeq, props.initialState]);

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

  const server = useAuctionSelector(store, (s) => s.server);
  const displayPrice = useAuctionSelector(store, selectDisplayPrice);
  const pendingCount = useAuctionSelector(store, selectPendingCount);
  const lastReject = useAuctionSelector(store, (s) => s.lastReject);
  const msRemaining = useAuctionSelector(store, selectMsRemaining);
  const clockOffsetMs = useAuctionSelector(store, (s) => s.clockOffsetMs);
  const serverNow = useAuctionSelector(store, selectServerNow);

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
