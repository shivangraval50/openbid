import { encode, parseServerMessage, type ClientMessage } from "@openbid/protocol";
import type { AuctionStore } from "@openbid/store";

export type ConnStatus = "connecting" | "open" | "reconnecting" | "closed";

export function backoffMs(attempt: number): number {
  return Math.min(30_000, 500 * 2 ** attempt);
}

export interface RoomConnection {
  send(msg: ClientMessage): void;
  close(): void;
}

export function connectRoom(opts: {
  url: string;
  nickname: string;
  store: AuctionStore;
  onStatus(status: ConnStatus): void;
}): RoomConnection {
  let ws: WebSocket | null = null;
  let attempt = 0;
  let disposed = false;
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  function open(): void {
    if (disposed) return;
    opts.onStatus(attempt === 0 ? "connecting" : "reconnecting");

    ws = new WebSocket(opts.url);

    ws.onopen = () => {
      attempt = 0;
      opts.onStatus("open");
      // Resume from what we already have; the DO replays only the gap.
      // `lastSeenSeq` is read fresh here (not captured at connect time) so
      // a reconnect always resumes from the highest seq genuinely applied
      // via a delta -- never from a seq an ack merely acknowledged.
      ws?.send(
        encode({
          t: "hello",
          lastSeenSeq: opts.store.getState().lastSeenSeq,
          nickname: opts.nickname,
        })
      );
      pingTimer = setInterval(() => {
        ws?.send(encode({ t: "ping", clientTime: Date.now() }));
      }, 5_000);
    };

    ws.onmessage = (event) => {
      const msg = parseServerMessage(String(event.data));
      if (msg.t === "pong") {
        // Only the client knows receipt time, so the offset is derived here.
        opts.store.getState().observeClock(msg.clientTime, msg.serverTime, Date.now());
        return;
      }
      opts.store.getState().applyServerMessage(msg);
    };

    ws.onclose = () => {
      if (pingTimer !== null) clearInterval(pingTimer);
      if (disposed) {
        opts.onStatus("closed");
        return;
      }
      const delay = backoffMs(attempt);
      attempt += 1;
      opts.onStatus("reconnecting");
      setTimeout(open, delay);
    };

    ws.onerror = () => ws?.close();
  }

  open();

  return {
    send(msg) {
      if (ws !== null && ws.readyState === WebSocket.OPEN) ws.send(encode(msg));
    },
    close() {
      disposed = true;
      if (pingTimer !== null) clearInterval(pingTimer);
      ws?.close();
    },
  };
}
