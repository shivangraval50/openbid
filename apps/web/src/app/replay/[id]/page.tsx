import { notFound } from "next/navigation";
import type { AuctionConfig } from "@openbid/auction-core";
import { fetchArchivedAuction } from "@/lib/replay";
import { Scrubber } from "./Scrubber";
import styles from "./replay.module.css";

export const dynamic = "force-dynamic";

export default async function ReplayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const archived = await fetchArchivedAuction(id);
  if (archived === null) notFound();

  // The archive stores the log and the economics (item name, starting
  // price), not the room's live config -- and replay only needs the
  // fields the reducer actually reads. This config is deliberately
  // permissive: zero `minIncrement`, an effectively infinite budget, and
  // an effectively infinite deadline. That is safe, not a bug, because
  // `replayTo` (apps/web/src/lib/replay.ts) folds the archived log
  // through `reduce` alone and NEVER calls `validateBid` -- and
  // `minIncrement`, `startingBudget`, and `endsAtMs` are only ever read
  // by `validateBid`. Every event in the log already passed validation
  // once, at the moment it was accepted live, so these values cannot
  // change the replayed outcome no matter what they're set to here.
  const config: AuctionConfig = {
    itemName: archived.itemName,
    startingPrice: archived.startingPrice,
    minIncrement: 0,
    startingBudget: Number.MAX_SAFE_INTEGER,
    antiSnipeWindowMs: 0,
    antiSnipeExtensionMs: 0,
    endsAtMs: Number.MAX_SAFE_INTEGER,
  };

  return (
    <main className={styles.page}>
      <div className={styles.head}>
        {/* Heading copy unchanged, verbatim. */}
        <h1 className={styles.title}>Replay — {archived.itemName}</h1>
      </div>
      <Scrubber config={config} events={archived.bidLog} />
    </main>
  );
}
