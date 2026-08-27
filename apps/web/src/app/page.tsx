import Link from "next/link";
import { createRoom } from "@/actions/rooms";
import { listRooms } from "@/lib/rooms";
import { cx } from "@/cx";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

export default async function LobbyPage() {
  const rooms = await listRooms();

  return (
    <main className={styles.page}>
      <div className={styles.masthead}>
        <h1 className={styles.title}>openbid</h1>
        <p className={styles.tagline}>
          A live multi-user auction, authoritative on the server.
        </p>
      </div>

      <section className={styles.card} aria-label="Open a new auction">
        <form action={createRoom} className={styles.createForm}>
          <label htmlFor="itemName" className={styles.fieldLabel}>
            Lot name
          </label>
          <div className={styles.controlRow}>
            <input
              id="itemName"
              name="itemName"
              required
              maxLength={80}
              className={styles.textInput}
              placeholder="A rare compiler"
              autoComplete="off"
            />
            <button type="submit" className={styles.submit}>
              Open an auction
            </button>
          </div>
        </form>
      </section>

      <section aria-labelledby="lots-heading">
        <div className={styles.sectionHead}>
          <h2 id="lots-heading" className={styles.sectionTitle}>
            Open lots
          </h2>
          {rooms.length > 0 ? (
            <span className={styles.count}>{rooms.length}</span>
          ) : null}
        </div>
        {rooms.length === 0 ? (
          <p className={styles.empty}>No auctions yet. Open one above.</p>
        ) : (
          <ul className={styles.lots}>
            {rooms.map((room) => (
              <li key={room.roomId} className={styles.lotRow}>
                <Link href={`/rooms/${room.roomId}`} className={styles.lotLink}>
                  <span className={styles.lotName}>{room.itemName}</span>
                  <span className={styles.lotMeta}>
                    {room.highBid === null ? (
                      <span className={styles.lotPriceNone}>no bids</span>
                    ) : (
                      <span className={styles.lotPrice}>
                        <span className={styles.unit}>current</span>
                        {room.highBid}
                      </span>
                    )}
                    <span
                      className={cx(
                        styles.status,
                        room.status === "open" ? styles.statusOpen : styles.statusClosed
                      )}
                    >
                      <span className={styles.statusDot} aria-hidden="true" />
                      {room.status}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
