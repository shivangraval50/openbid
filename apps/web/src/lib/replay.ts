import { neon } from "@neondatabase/serverless";
import { archivedAuctionSchema, type ArchivedAuction as ProtocolArchivedAuction } from "@openbid/protocol";
import {
  initialState,
  reduce,
  type AuctionConfig,
  type AuctionEvent,
  type AuctionState,
} from "@openbid/auction-core";

/**
 * Fold the first `upTo` events. This is the same `reduce` the live socket
 * path uses -- the point of the validate/reduce split (Task 3): replay
 * never calls `validateBid`, because every event in the log already
 * passed it once, when it was accepted live. That is also why this
 * function is safe to call with a deliberately permissive `AuctionConfig`
 * (see the replay page) -- `minIncrement`, `startingBudget`, and
 * `endsAtMs` are only ever read by `validateBid`, never by `reduce`.
 *
 * Pure: no clock reads, no I/O, no mutation of `events` or of the state
 * threaded through the fold. `Array.prototype.slice` and `.reduce` both
 * clamp/no-op safely on out-of-range indices and empty arrays, which is
 * what gives the scrub-position clamping at both ends for free.
 */
export function replayTo(
  config: AuctionConfig,
  events: readonly AuctionEvent[],
  upTo: number
): AuctionState {
  const clamped = Math.max(0, Math.min(upTo, events.length));
  return events
    .slice(0, clamped)
    .reduce((state, event) => reduce(state, event), initialState(config));
}

export interface ArchivedAuction {
  itemName: string;
  startingPrice: number;
  winningPrice: number | null;
  winnerNickname: string | null;
  bidLog: AuctionEvent[];
}

/**
 * Reads one completed auction back from Neon for the replay page.
 * `DATABASE_URL` is deliberately unset in tests and may be unset in a
 * deployment, so a missing config degrades to `null` -- the replay page
 * treats that identically to "no such room" (`notFound()`), never a 500.
 *
 * The row is validated with `archivedAuctionSchema` (`@openbid/protocol`)
 * before it is trusted, not merely cast. `bidLog` is the one field
 * capable of making the replay/determinism test lie: it is Neon `jsonb`
 * with no schema of its own, and `reduce`'s switch has no default case,
 * so an unrecognised event `type` or a stringified numeric field reaching
 * it would be a silent bug, not a caught error, and a comparison built
 * on top of that fold would pass without proving anything. A row that
 * fails validation is treated exactly like a missing row: `null`.
 */
export async function fetchArchivedAuction(roomId: string): Promise<ArchivedAuction | null> {
  const url = process.env.DATABASE_URL;
  if (!url) return null;

  try {
    const sql = neon(url);
    const rows = await sql`
      SELECT item_name       AS "itemName",
             starting_price  AS "startingPrice",
             winning_price   AS "winningPrice",
             winner_nickname AS "winnerNickname",
             bid_log         AS "bidLog"
      FROM completed_auctions
      WHERE room_id = ${roomId}
      LIMIT 1
    `;
    const row = (rows as unknown[])[0];
    if (row === undefined) return null;

    const parsed: ProtocolArchivedAuction = archivedAuctionSchema.parse(row);
    // Structural check that protocol's validated wire shape and
    // auction-core's internal `AuctionEvent`/`ArchivedAuction` types
    // still agree, the same guard RoomDO applies to `AuctionConfig`.
    const archived: ArchivedAuction = parsed;
    return archived;
  } catch {
    return null;
  }
}
