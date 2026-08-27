import { notFound } from "next/navigation";
import { resolveIdentity } from "@/identity";
import { fetchSnapshot } from "@/lib/rooms";
import { LiveRoom } from "./LiveRoom";
import styles from "./room.module.css";

export const dynamic = "force-dynamic";

export default async function RoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const snapshot = await fetchSnapshot(id);
  if (snapshot === null) notFound();

  // Resolves signed-in session first, then the guest cookie (generating
  // one if absent) -- see identity.ts. Every participant connecting as
  // "guest" (LiveRoom's fallback default) was a wiring gap, not a design
  // choice: this is what closes it.
  const identity = await resolveIdentity();

  return (
    // The room's own layout lives in LiveRoom, which renders the header (lot
    // name plus connection pill), the instrument panel and the bid panel as
    // this <main>'s three flex children. The heading text is passed down
    // rather than rendered here so that the lot name and the connection
    // status can share one row -- and so that the heading survives even on
    // LiveRoom's `server === null` fallback branch.
    <main className={styles.room}>
      {/* First paint shows real auction state, before any socket opens. */}
      <LiveRoom
        itemName={snapshot.state.config.itemName}
        roomId={id}
        initialSeq={snapshot.seq}
        initialServerTime={snapshot.serverTime}
        initialState={snapshot.state}
        socketBaseUrl={process.env.NEXT_PUBLIC_ROOMS_BASE_URL ?? ""}
        nickname={identity.nickname}
        // Forwarded all the way to the `hello`, and from there onto the
        // room's `joined` event, the winner's Participant record and
        // finally `completed_auctions.winner_persistent` -- which is what
        // the leaderboard filters on. Dropping it here would silently
        // demote every signed-in win to a guest's.
        persistent={identity.persistent}
      />
    </main>
  );
}
