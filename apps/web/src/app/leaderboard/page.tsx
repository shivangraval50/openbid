import { topBidders, type BidderRow } from "@/lib/leaderboard";

export const dynamic = "force-dynamic";

/**
 * Defense in depth: `topBidders()` already guarantees it never rejects
 * (see leaderboard.ts's own try/catch around the Neon client and
 * query), but Requirement 4 -- "the leaderboard must never break the
 * page" -- is a promise about THIS PAGE, not merely about trusting
 * that guarantee to hold forever. A future edit to `topBidders` that
 * dropped its own try/catch would otherwise turn straight into an
 * error page here with nothing to catch it.
 */
async function fetchBiddersSafely(): Promise<BidderRow[]> {
  try {
    return await topBidders();
  } catch {
    return [];
  }
}

export default async function LeaderboardPage() {
  const bidders = await fetchBiddersSafely();

  return (
    <main>
      <h1>Leaderboard</h1>
      {bidders.length === 0 ? (
        <p>No completed auctions yet.</p>
      ) : (
        <ol>
          {bidders.map((b) => (
            <li key={b.nickname}>
              {b.nickname} — {b.wins} {b.wins === 1 ? "win" : "wins"}
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
