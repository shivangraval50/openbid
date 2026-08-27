"use server";

import { redirect } from "next/navigation";
import type { AuctionConfig } from "@openbid/auction-core";
import { initRoom, registerRoom } from "@/lib/rooms";

const DEFAULTS = {
  startingPrice: 100,
  minIncrement: 10,
  startingBudget: 1_000,
  antiSnipeWindowMs: 10_000,
  antiSnipeExtensionMs: 15_000,
  durationMs: 180_000,
} as const;

// registerRoom makes an already-live room visible in the lobby. LobbyDO's
// registration is an upsert keyed on room_id, so retrying it is always
// safe. Bounded retries absorb a transient blip; if every attempt still
// fails, the error is thrown (not swallowed) so the caller sees a real
// failure instead of a silent redirect into a room that is live and
// biddable but permanently invisible in the lobby.
const REGISTER_MAX_ATTEMPTS = 3;
const REGISTER_RETRY_DELAY_MS = 10;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function registerRoomWithRetry(
  roomId: string,
  itemName: string,
  endsAtMs: number
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= REGISTER_MAX_ATTEMPTS; attempt++) {
    try {
      await registerRoom(roomId, itemName, endsAtMs);
      return;
    } catch (err) {
      lastError = err;
      if (attempt < REGISTER_MAX_ATTEMPTS) await delay(REGISTER_RETRY_DELAY_MS);
    }
  }
  throw new Error(
    `room ${roomId} was initialised but could not be registered in the lobby after ` +
      `${REGISTER_MAX_ATTEMPTS} attempts and is now live but invisible; last error: ${String(lastError)}`
  );
}

export async function createRoom(formData: FormData): Promise<void> {
  const itemName = String(formData.get("itemName") ?? "").trim() || "Untitled lot";
  const roomId = crypto.randomUUID().slice(0, 8);
  const endsAtMs = Date.now() + DEFAULTS.durationMs;

  const config: AuctionConfig = {
    itemName,
    startingPrice: DEFAULTS.startingPrice,
    minIncrement: DEFAULTS.minIncrement,
    startingBudget: DEFAULTS.startingBudget,
    antiSnipeWindowMs: DEFAULTS.antiSnipeWindowMs,
    antiSnipeExtensionMs: DEFAULTS.antiSnipeExtensionMs,
    endsAtMs,
  };

  await initRoom(roomId, config);
  await registerRoomWithRetry(roomId, itemName, endsAtMs);
  redirect(`/rooms/${roomId}`);
}
