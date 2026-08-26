"use client";

import { useSyncExternalStore } from "react";
import type { AuctionStore, AuctionStoreState } from "@openbid/store";

export function useAuctionSelector<T>(
  store: AuctionStore,
  selector: (s: AuctionStoreState) => T
): T {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
    () => selector(store.getState())
  );
}
