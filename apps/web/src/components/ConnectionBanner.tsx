import type { ConnStatus } from "@/lib/socket";

const MESSAGES: Record<ConnStatus, string | null> = {
  connecting: "Connecting…",
  open: null,
  reconnecting: "Reconnecting — prices may be a moment behind.",
  closed: "Disconnected.",
};

export function ConnectionBanner({ status }: { status: ConnStatus }) {
  const message = MESSAGES[status];
  if (message === null) return null;
  return <p role="status">{message}</p>;
}
