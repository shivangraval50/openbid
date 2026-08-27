import { DurableObject } from "cloudflare:workers";
import {
  lobbyPriceSchema,
  lobbyRegisterSchema,
  type LobbyPrice,
  type LobbyRegister,
} from "@openbid/protocol";

// A `type` alias, not an `interface`: `SqlStorage#exec`'s generic is
// constrained to `Record<string, SqlStorageValue>`, and only a type alias
// (not a named interface) gets TypeScript's implicit index-signature
// comparison against that constraint — matching the inline object-literal
// types every `exec<...>()` call elsewhere in this package already uses.
type Row = {
  room_id: string;
  item_name: string;
  ends_at_ms: number;
  status: string;
  high_bid: number | null;
};

/**
 * The lobby's room registry, plus a cached view of each room's live price.
 * Neon holds only *completed* auctions (see the spec), so a live room list
 * cannot be a Postgres table — this Durable Object is the whole registry.
 *
 * Deliberately a singleton: the Worker router always addresses it via
 * `idFromName("global")`, never per-room. It is a cache and a directory,
 * never an authority — it stores exactly what `RoomDO` tells it and never
 * evaluates an auction rule of its own.
 */
export class LobbyDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        room_id    TEXT PRIMARY KEY,
        item_name  TEXT    NOT NULL,
        ends_at_ms INTEGER NOT NULL,
        status     TEXT    NOT NULL DEFAULT 'open',
        high_bid   REAL
      );
    `);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sql = this.ctx.storage.sql;

    if (request.method === "GET" && url.pathname === "/lobby/rooms") {
      const rooms = sql
        .exec<Row>("SELECT * FROM rooms ORDER BY ends_at_ms ASC")
        .toArray()
        .map((row) => ({
          roomId: row.room_id,
          itemName: row.item_name,
          endsAtMs: row.ends_at_ms,
          status: row.status === "closed" ? ("closed" as const) : ("open" as const),
          highBid: row.high_bid,
        }));
      return Response.json({ rooms });
    }

    if (request.method === "POST" && url.pathname === "/lobby/rooms") {
      let parsed: LobbyRegister;
      try {
        parsed = lobbyRegisterSchema.parse(await request.json());
      } catch {
        return new Response("invalid lobby room registration", { status: 400 });
      }
      sql.exec(
        `INSERT INTO rooms (room_id, item_name, ends_at_ms) VALUES (?, ?, ?)
         ON CONFLICT(room_id) DO UPDATE SET item_name = ?, ends_at_ms = ?`,
        parsed.roomId,
        parsed.itemName,
        parsed.endsAtMs,
        parsed.itemName,
        parsed.endsAtMs
      );
      return new Response(null, { status: 201 });
    }

    const priceMatch = /^\/lobby\/rooms\/([A-Za-z0-9_-]+)\/price$/.exec(url.pathname);
    if (request.method === "POST" && priceMatch !== null) {
      let parsed: LobbyPrice;
      try {
        parsed = lobbyPriceSchema.parse(await request.json());
      } catch {
        return new Response("invalid lobby price update", { status: 400 });
      }
      const cursor = sql.exec(
        "UPDATE rooms SET high_bid = ?, status = ? WHERE room_id = ?",
        parsed.highBid,
        parsed.status,
        priceMatch[1]!
      );
      // `rowsWritten === 0` means the WHERE clause matched nothing — the
      // room was never registered (or was registered under a different
      // id). Without this check, a live, biddable room that never made it
      // into the registry is indistinguishable from a successful update:
      // both return 204 and the room stays invisible in the lobby with no
      // signal anywhere. `notifyLobby` (the only production caller) never
      // looks at this response — see its doc comment — so surfacing 404
      // here is purely for observability, not a mechanism either side
      // relies on for correctness.
      if (cursor.rowsWritten === 0) {
        return new Response("no such room", { status: 404 });
      }
      return new Response(null, { status: 204 });
    }

    return new Response("not found", { status: 404 });
  }
}
