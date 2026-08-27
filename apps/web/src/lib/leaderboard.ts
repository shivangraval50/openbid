import { neon } from "@neondatabase/serverless";

export interface BidderRow {
  nickname: string;
  wins: number;
  overpay: number;
}

/**
 * Wins descending, then lowest total overpay above the starting price.
 *
 * The spec ranks by "wins, tie-broken by total budget surplus", but the
 * archive (packages/room-do/src/archive.ts) stores `starting_price` and
 * `winning_price` per completed auction, not each room's
 * `startingBudget` -- so a true "surplus below budget" isn't computable
 * from what's stored. This ranks by the lowest total *overpay above the
 * starting price* instead (SUM(winning_price - starting_price)): same
 * ordering intent -- reward bidders who won cheaply relative to the
 * item, not ones who happened to have a bigger budget -- computable from
 * the columns that actually exist. This is the one place this task
 * refines the spec's definition to match the stored data.
 *
 * Returns a new array; never mutates its input, so callers (e.g.
 * `topBidders`, which passes a freshly-fetched row array) can't be
 * surprised by an in-place sort.
 */
export function rankBidders(rows: BidderRow[]): BidderRow[] {
  return [...rows].sort((a, b) => b.wins - a.wins || a.overpay - b.overpay);
}

/**
 * Reads the leaderboard from Neon.
 *
 * `WHERE ... AND winner_persistent` is what makes this the *signed-in*
 * ranking the spec describes. Without it, the `GROUP BY winner_nickname`
 * merges guest wins into whatever row shares their nickname -- and since
 * `openbid_guest` is set `httpOnly: false` (`proxy.ts`), a guest can
 * simply set it to a real GitHub login and deposit their wins in that
 * user's row. `auth.ts`'s login-over-display-name work closed the
 * collision between two signed-in "Alex"es; this closes the one between
 * a guest and anybody.
 *
 * `DATABASE_URL` is deliberately unset in tests, and may be unset in a
 * deployment; the leaderboard is a read-only nicety, so ANY failure here
 * -- missing config, a thrown client construction, a rejected query --
 * degrades to an empty list rather than ever surfacing as a 500 on the
 * leaderboard page.
 */
export async function topBidders(limit = 20): Promise<BidderRow[]> {
  const url = process.env.DATABASE_URL;
  if (!url) return [];

  try {
    const sql = neon(url);
    const rows = (await sql`
      SELECT winner_nickname                                          AS nickname,
             COUNT(*)::int                                            AS wins,
             COALESCE(SUM(winning_price - starting_price), 0)::float  AS overpay
      FROM completed_auctions
      WHERE winner_nickname IS NOT NULL
        AND winner_persistent
      GROUP BY winner_nickname
      ORDER BY wins DESC
      LIMIT ${limit}
    `) as BidderRow[];
    return rankBidders(rows);
  } catch {
    return [];
  }
}
