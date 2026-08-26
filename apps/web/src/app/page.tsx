import Link from "next/link";
import { createRoom } from "@/actions/rooms";
import { listRooms } from "@/lib/rooms";

export const dynamic = "force-dynamic";

export default async function LobbyPage() {
  const rooms = await listRooms();

  return (
    <main>
      <h1>openbid</h1>

      <form action={createRoom}>
        <label htmlFor="itemName">Lot name</label>
        <input id="itemName" name="itemName" required maxLength={80} />
        <button type="submit">Open an auction</button>
      </form>

      <h2>Open lots</h2>
      {rooms.length === 0 ? (
        <p>No auctions yet. Open one above.</p>
      ) : (
        <ul>
          {rooms.map((room) => (
            <li key={room.roomId}>
              <Link href={`/rooms/${room.roomId}`}>{room.itemName}</Link>
              <span>{room.highBid === null ? "no bids" : `current ${room.highBid}`}</span>
              <span>{room.status}</span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
