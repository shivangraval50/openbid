import { neon } from "@neondatabase/serverless";

export interface SettlementRecord {
  roomId: string;
  itemName: string;
  startingPrice: number;
  winnerNickname: string | null;
  winningPrice: number | null;
  closedAtMs: number;
  bidLog: unknown[];
}

/**
 * Writes one completed auction to Neon. Throws on any failure — a missing
 * or empty `databaseUrl`, a network error, a Postgres outage — so the
 * caller can leave the record in the outbox rather than lose it. A
 * Postgres outage must never be able to lose a settlement or block a live
 * room; this function is only ever called from the outbox drain, after the
 * room has already closed and broadcast on its own.
 *
 * `databaseUrl` is `string | undefined` rather than always `string`
 * because production supplies it as a Workers *secret*
 * (`wrangler secret put DATABASE_URL`), not a `[vars]` entry — a plaintext
 * `[vars]` value of the same name would silently take precedence over the
 * secret on every deploy, permanently breaking archiving with no error and
 * no failing test. With no `[vars]` entry, an unset secret surfaces as
 * `undefined`, which this function treats exactly like an empty string.
 *
 * `ON CONFLICT (room_id) DO NOTHING` makes the write idempotent, which is
 * what lets the outbox retry the same record blindly on every alarm without
 * risking a duplicate row.
 */
export async function archiveSettlement(
  databaseUrl: string | undefined,
  record: SettlementRecord
): Promise<void> {
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error("DATABASE_URL is not configured");
  }
  const sql = neon(databaseUrl);

  await sql`
    INSERT INTO completed_auctions
      (room_id, item_name, starting_price, winner_nickname, winning_price, closed_at, bid_log)
    VALUES
      (${record.roomId}, ${record.itemName}, ${record.startingPrice},
       ${record.winnerNickname}, ${record.winningPrice},
       to_timestamp(${record.closedAtMs} / 1000.0), ${JSON.stringify(record.bidLog)}::jsonb)
    ON CONFLICT (room_id) DO NOTHING
  `;
}
