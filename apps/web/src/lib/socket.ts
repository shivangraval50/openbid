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
  /**
   * Whether `nickname` is a signed-in GitHub `login` rather than a guest
   * cookie value -- `resolveIdentity()`'s own flag, forwarded down. Required,
   * not optional-with-a-default: an omitted flag would silently rank a
   * signed-in user's wins as a guest's, which is exactly the kind of quiet
   * drop an optional parameter invites.
   */
  persistent: boolean;
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
          persistent: opts.persistent,
        })
      );
      // Ping immediately, rather than waiting for the first 5s interval
      // tick, so the clock-offset correction lands within one round trip
      // of connecting. Auction timing must never run on the untrusted
      // local clock for longer than that -- and it otherwise would, for
      // the first 5+ seconds of every single connection (and for the rest
      // of the session if pongs never arrive at all).
      ws?.send(encode({ t: "ping", clientTime: Date.now() }));
      pingTimer = setInterval(() => {
        ws?.send(encode({ t: "ping", clientTime: Date.now() }));
      }, 5_000);
    };

    ws.onmessage = (event) => {
      // `parseServerMessage` throws a ZodError on a malformed frame, and an
      // exception escaping `onmessage` is unhandled -- asymmetric with the
      // DO's own inbound path, which wraps `parseClientMessage` in a
      // try/catch and closes with 1003 rather than letting a throw tear down
      // every socket on the room. Now that `snapshot.state` and
      // `delta.event` are validated rather than passed through as
      // `z.unknown()`, this is also the handler for a payload that fails
      // that validation.
      //
      // Dropped, not closed: unlike the DO, this side is not the authority,
      // and closing would put the client into a reconnect loop over a frame
      // it cannot influence. A dropped delta leaves `lastSeenSeq` where it
      // was, so the DO's resume-on-`hello` replay hands it back on the next
      // reconnect -- the gap is recoverable, a thrown-away store is not.
      let msg;
      try {
        msg = parseServerMessage(String(event.data));
      } catch {
        return;
      }
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
