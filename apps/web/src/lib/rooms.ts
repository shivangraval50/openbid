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
 * Structural check on the Worker's `/snapshot` envelope. This value flows
 * straight into the client store and then into `reduce`, so a malformed
 * response must fail loudly (become `null`, same as a 404) rather than
 * silently corrupt client state. Deliberately shallow: it does not
 * validate the full `AuctionState` shape (that is `auction-core`'s
 * concern, not the HTTP client's), only that the envelope this module
 * itself promises — a non-negative integer `seq`, a numeric `serverTime`,
 * and a present `state` — actually holds.
 */
function isValidSnapshotEnvelope(value: unknown): value is RoomSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.seq !== "number" || !Number.isInteger(v.seq) || v.seq < 0) return false;
  if (typeof v.serverTime !== "number") return false;
  if (typeof v.state !== "object" || v.state === null) return false;
  return true;
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

  if (!isValidSnapshotEnvelope(body)) return null;
  return body;
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
