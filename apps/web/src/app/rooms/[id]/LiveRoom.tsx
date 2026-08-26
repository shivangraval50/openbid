"use client";

import type { AuctionState } from "@openbid/auction-core";

// Placeholder only: exists so `next build` and this task's tests can run.
// Task 14 replaces this body with the real socket-driven client surface
// (seeding the store from the SSR snapshot via a dedicated
// `seedFromSnapshot` action, not by fabricating a wire message).
export function LiveRoom(props: {
  roomId: string;
  initialSeq: number;
  initialState: AuctionState;
  socketBaseUrl: string;
}) {
  return <p>Connecting to {props.roomId}…</p>;
}
