import { topBidders, type BidderRow } from "@/lib/leaderboard";
import styles from "./leaderboard.module.css";

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
    <main className={styles.page}>
      <div className={styles.head}>
        <h1 className={styles.title}>Leaderboard</h1>
        <p className={styles.subtitle}>Bidders ranked by auctions won.</p>
      </div>
      {bidders.length === 0 ? (
        <p className={styles.empty}>No completed auctions yet.</p>
      ) : (
        <ol className={styles.board}>
          {bidders.map((b, index) => (
            <li
              key={b.nickname}
              className={`${styles.row} ${index < 3 ? styles.rowLeading : ""}`}
            >
              <span className={styles.rank} aria-hidden="true">
                {index + 1}
              </span>
              <span className={styles.name}>{b.nickname}</span>
              <span className={styles.wins}>
                <span className={styles.winsCount}>{b.wins}</span>
                <span className={styles.winsUnit}>{b.wins === 1 ? "win" : "wins"}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
