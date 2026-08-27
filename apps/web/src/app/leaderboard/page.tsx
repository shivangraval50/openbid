import { topBidders } from "@/lib/leaderboard";

export const dynamic = "force-dynamic";

export default async function LeaderboardPage() {
  const bidders = await topBidders();

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
