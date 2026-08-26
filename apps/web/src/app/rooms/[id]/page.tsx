import { notFound } from "next/navigation";
import { fetchSnapshot } from "@/lib/rooms";
import { LiveRoom } from "./LiveRoom";

export const dynamic = "force-dynamic";

export default async function RoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const snapshot = await fetchSnapshot(id);
  if (snapshot === null) notFound();

  return (
    <main>
      {/* First paint shows real auction state, before any socket opens. */}
      <h1>{snapshot.state.config.itemName}</h1>
      <LiveRoom
        roomId={id}
        initialSeq={snapshot.seq}
        initialState={snapshot.state}
        socketBaseUrl={process.env.NEXT_PUBLIC_ROOMS_BASE_URL ?? ""}
      />
    </main>
  );
}
