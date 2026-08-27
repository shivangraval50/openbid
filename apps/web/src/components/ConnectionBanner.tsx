import type { ConnStatus } from "@/lib/socket";
import { cx } from "@/cx";
import styles from "./ConnectionBanner.module.css";

const MESSAGES: Record<ConnStatus, string | null> = {
  connecting: "Connecting…",
  open: null,
  reconnecting: "Reconnecting — prices may be a moment behind.",
  closed: "Disconnected.",
};

// `string | undefined`, not `string`: a CSS-module lookup is typed through an
// index signature and this repo compiles with `noUncheckedIndexedAccess`.
// `cx` below drops the undefined case instead of rendering it as a class.
const TONE: Record<ConnStatus, string | undefined> = {
  connecting: styles.connecting,
  open: "",
  reconnecting: styles.reconnecting,
  closed: styles.closed,
};

export function ConnectionBanner({ status }: { status: ConnStatus }) {
  const message = MESSAGES[status];
  if (message === null) return null;
  return (
    <p role="status" className={cx(styles.banner, TONE[status])}>
      <span className={styles.dot} aria-hidden="true" />
      {message}
    </p>
  );
}
