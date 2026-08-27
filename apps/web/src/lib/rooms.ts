import { auctionStateSchema } from "@openbid/protocol";
import type { AuctionConfig, AuctionState } from "@openbid/auction-core";

export interface LobbyRoom {
  roomId: string;
  itemName: string;
  endsAtMs: number;
  status: "open" | "closed";
  highBid: number | null;
}

export interface RoomSnapshot {
  seq: number;
  serverTime: number;
  state: AuctionState;
}

export function roomsBaseUrl(): string {
  const url = process.env.ROOMS_BASE_URL;
  if (!url) throw new Error("ROOMS_BASE_URL is not set; see apps/web/.env.example");
  return url;
}

export async function listRooms(): Promise<LobbyRoom[]> {
  try {
    const res = await fetch(`${roomsBaseUrl()}/lobby/rooms`, { cache: "no-store" });
    if (!res.ok) return [];
    return ((await res.json()) as { rooms: LobbyRoom[] }).rooms;
  } catch {
    // The lobby being unreachable must degrade to an empty list, not a 500 page.
    return [];
  }
}

/**
 * Validates the Worker's `/snapshot` envelope. This value flows straight
 * into the client store and then into `reduce`, so a malformed response
 * must fail loudly (become `null`, same as a 404) rather than silently
 * corrupt client state.
 *
 * `state` is checked with `auctionStateSchema` from `@openbid/protocol`,
 * not merely asserted to be an object. This used to be a deliberately
 * shallow check, justified on the grounds that the full `AuctionState`
 * shape was auction-core's concern and not the HTTP client's -- but
 * `@openbid/protocol` now owns exactly that schema (it is what
 * `serverMessageSchema` validates a socket snapshot with), so that
 * reasoning no longer holds. The HTTP snapshot and the socket snapshot
 * carry the same payload into the same store; validating one and not the
 * other would leave `reduce` -- whose switch has no default case -- exposed
 * on whichever path was left loose.
 *
 * Returns the parsed envelope rather than a boolean type guard, because
 * `auctionStateSchema` applies defaults (a participant record with no
 * `persistent` flag comes back with `persistent: false`), and the caller
 * must use the normalised value, not the raw one.
 */
function parseSnapshotEnvelope(value: unknown): RoomSnapshot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.seq !== "number" || !Number.isInteger(v.seq) || v.seq < 0) return null;
  if (typeof v.serverTime !== "number") return null;
  const state = auctionStateSchema.safeParse(v.state);
  if (!state.success) return null;
  // Structural check that protocol's validated shape and auction-core's
  // internal `AuctionState` still agree -- the same guard `RoomDO` applies
  // to `AuctionConfig` and `replay.ts` applies to an archived row.
  const parsed: AuctionState = state.data;
  return { seq: v.seq, serverTime: v.serverTime, state: parsed };
}

export async function fetchSnapshot(roomId: string): Promise<RoomSnapshot | null> {
  const res = await fetch(`${roomsBaseUrl()}/rooms/${roomId}/snapshot`, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) return null;

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    // A 200 with a non-JSON body is malformed, not absent, but the caller
    // treats both the same way: fail closed, never crash the room page.
    return null;
  }

  return parseSnapshotEnvelope(body);
}

export async function initRoom(roomId: string, config: AuctionConfig): Promise<void> {
  const res = await fetch(`${roomsBaseUrl()}/rooms/${roomId}/init`, {
    method: "POST",
    body: JSON.stringify(config),
  });
  if (!res.ok) throw new Error(`failed to initialise room ${roomId}: ${res.status}`);
}

export async function registerRoom(
  roomId: string,
  itemName: string,
  endsAtMs: number
): Promise<void> {
  const res = await fetch(`${roomsBaseUrl()}/lobby/rooms`, {
    method: "POST",
    body: JSON.stringify({ roomId, itemName, endsAtMs }),
  });
  if (!res.ok) throw new Error(`failed to register room ${roomId}: ${res.status}`);
}
