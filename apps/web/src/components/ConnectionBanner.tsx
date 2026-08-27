import type { ConnStatus } from "@/lib/socket";
import styles from "./ConnectionBanner.module.css";

const MESSAGES: Record<ConnStatus, string | null> = {
  connecting: "Connecting…",
  open: null,
  reconnecting: "Reconnecting — prices may be a moment behind.",
  closed: "Disconnected.",
};

const TONE: Record<ConnStatus, string> = {
  connecting: styles.connecting,
  open: "",
  reconnecting: styles.reconnecting,
  closed: styles.closed,
};

export function ConnectionBanner({ status }: { status: ConnStatus }) {
  const message = MESSAGES[status];
  if (message === null) return null;
  return (
    <p role="status" className={`${styles.banner} ${TONE[status]}`}>
      <span className={styles.dot} aria-hidden="true" />
      {message}
    </p>
  );
}
