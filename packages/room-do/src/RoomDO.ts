import { DurableObject } from "cloudflare:workers";
import {
  initialState,
  reduce,
  validateBid,
  type AuctionConfig,
  type AuctionState,
} from "@openbid/auction-core";
import {
  auctionConfigSchema,
  encode,
  parseClientMessage,
  type AuctionConfig as ProtocolAuctionConfig,
  type ServerMessage,
} from "@openbid/protocol";
import {
  appendEvent,
  currentSeq,
  getMeta,
  initSchema,
  putMeta,
  readEventsSince,
} from "./sql.js";

interface Attachment {
  participantId: string;
  nickname: string;
}

/** Above this many missed events, a reconnecting client gets a fresh
 * snapshot instead of a long replay. */
export const SNAPSHOT_THRESHOLD = 500;

/**
 * Decide whether a `hello` should be answered with a replay of the events
 * the client missed, versus a snapshot alone.
 *
 * `lastSeenSeq === 0` means "I have not seen anything yet" — a brand-new
 * joiner, not a resuming one — and is always answered with a snapshot only,
 * never a replay (a replay of "everything since the beginning" is exactly
 * what the snapshot already is, just less efficiently). Otherwise, replay
 * when the gap between what the client has seen and the current sequence is
 * at most `threshold`; a wider gap gets a snapshot instead.
 *
 * Pure transport bookkeeping — no auction rule lives here.
 */
export function shouldReplay(lastSeenSeq: number, latestSeq: number, threshold: number): boolean {
  if (lastSeenSeq <= 0) return false;
  return latestSeq - lastSeenSeq <= threshold;
}

export class RoomDO extends DurableObject {
  private cached: AuctionState | null = null;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    initSchema(this.ctx.storage.sql);
  }

  /** Rebuild state from the event log. Survives eviction with no extra bookkeeping. */
  private state(): AuctionState | null {
    if (this.cached !== null) return this.cached;
    const raw = getMeta(this.ctx.storage.sql, "config");
    if (raw === null) return null;
    const config = JSON.parse(raw) as AuctionConfig;
    const state = readEventsSince(this.ctx.storage.sql, 0).reduce(
      (acc, row) => reduce(acc, row.event),
      initialState(config)
    );
    this.cached = state;
    return state;
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(encode(msg));
    } catch {
      // The socket may already be closing. One dead peer must not blow up
      // the caller (in particular, must not blow up `broadcast`'s loop).
    }
  }

  private broadcast(msg: ServerMessage): void {
    const payload = encode(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // Same as `send`: a socket that's mid-close must not take the rest
        // of the room down with it.
      }
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname.endsWith("/init")) {
      const existingConfig = getMeta(this.ctx.storage.sql, "config");
      if (existingConfig !== null && currentSeq(this.ctx.storage.sql) > 0) {
        // Re-initialising a live room would fold the old event log over a
        // new config (rewriting budgets, discarding endsAtMs, etc). Once a
        // room has events, /init is no longer idempotent. Before any event
        // has landed it's still fine to allow (and expected to be safe to
        // retry), which is what the `> 0` check preserves.
        return new Response("room already has activity", { status: 409 });
      }

      let parsed: ProtocolAuctionConfig;
      try {
        parsed = auctionConfigSchema.parse(await request.json());
      } catch {
        return new Response("invalid auction config", { status: 400 });
      }
      // Structural check that protocol's wire contract and auction-core's
      // internal type still agree, the same guard `RejectReason` gets.
      const config: AuctionConfig = parsed;

      putMeta(this.ctx.storage.sql, "config", JSON.stringify(config));
      this.cached = null;
      return new Response(null, { status: 201 });
    }

    if (url.pathname.endsWith("/snapshot")) {
      const state = this.state();
      if (state === null) return new Response("no such room", { status: 404 });
      return Response.json({
        seq: currentSeq(this.ctx.storage.sql),
        serverTime: Date.now(),
        state,
      });
    }

    if (url.pathname.endsWith("/ws")) {
      if (this.state() === null) return new Response("no such room", { status: 404 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      // Hibernatable: an idle room consumes no duration billing.
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("not found", { status: 404 });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    let msg;
    try {
      msg = parseClientMessage(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      // A peer that cannot speak the protocol is not a peer. Do not throw —
      // an unhandled error here would tear down every socket on this room.
      ws.close(1003, "unsupported payload");
      return;
    }

    const state = this.state();
    if (state === null) {
      ws.close(1011, "room not initialised");
      return;
    }

    switch (msg.t) {
      case "ping": {
        this.send(ws, { t: "pong", clientTime: msg.clientTime, serverTime: Date.now() });
        return;
      }

      case "hello": {
        const existing = ws.deserializeAttachment() as Attachment | null;
        if (existing !== null) {
          // Already joined on this socket. Re-sending the snapshot is
          // enough — minting a second participant or appending another
          // `joined` event would orphan the first one forever (nothing
          // ever removes a participant) and burns a sequence number for
          // nothing.
          this.send(ws, {
            t: "snapshot",
            seq: currentSeq(this.ctx.storage.sql),
            serverTime: Date.now(),
            state: { ...state, youAre: existing.participantId },
          });
          return;
        }

        const participantId = crypto.randomUUID();
        ws.serializeAttachment({ participantId, nickname: msg.nickname } satisfies Attachment);

        const atMs = Date.now();

        // Resume: hand back exactly the events this client has not seen yet,
        // unless it is far enough behind that `shouldReplay` prefers a fresh
        // snapshot instead. This runs — and the decision is made — *before*
        // this socket's own `joined` event is appended below, specifically
        // so that event can never appear twice: once here (were it appended
        // first, its seq would always be > msg.lastSeenSeq, so it would
        // always land in the replay set) and again via the broadcast a few
        // lines down, which reaches every socket in the room including this
        // one. Deciding against the log's state as of *before* this hello
        // keeps the join a single, broadcast-only delivery.
        const preJoinSeq = currentSeq(this.ctx.storage.sql);
        if (shouldReplay(msg.lastSeenSeq, preJoinSeq, SNAPSHOT_THRESHOLD)) {
          for (const row of readEventsSince(this.ctx.storage.sql, msg.lastSeenSeq)) {
            this.send(ws, { t: "delta", seq: row.seq, serverTime: atMs, event: row.event });
          }
        }

        const joinEvent = {
          type: "joined" as const,
          participantId,
          nickname: msg.nickname,
          atMs,
        };
        const joinSeq = appendEvent(this.ctx.storage.sql, joinEvent);
        this.cached = reduce(state, joinEvent);

        this.send(ws, {
          t: "snapshot",
          seq: joinSeq,
          serverTime: atMs,
          state: { ...this.cached, youAre: participantId },
        });
        // Already-connected clients need to learn about the new participant
        // too, or their local state falls behind and their sequence stream
        // gets a hole at joinSeq. `reduce`'s "joined" case is idempotent for
        // an existing participant, so re-delivering this to the joiner (via
        // broadcast, in addition to the snapshot above) is harmless.
        this.broadcast({ t: "delta", seq: joinSeq, serverTime: atMs, event: joinEvent });
        return;
      }

      case "bid": {
        const attachment = ws.deserializeAttachment() as Attachment | null;
        if (attachment === null) {
          ws.close(1008, "hello required before bidding");
          return;
        }

        const atMs = Date.now();
        const decision = validateBid(state, {
          participantId: attachment.participantId,
          amount: msg.amount,
          atMs,
        });

        if (!decision.ok) {
          this.send(ws, { t: "reject", clientSeq: msg.clientSeq, reason: decision.reason });
          return;
        }

        const seq = appendEvent(this.ctx.storage.sql, decision.event);
        this.cached = reduce(state, decision.event);
        this.send(ws, { t: "ack", clientSeq: msg.clientSeq, seq });
        this.broadcast({ t: "delta", seq, serverTime: atMs, event: decision.event });
        return;
      }
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // Participants persist in the event log; nothing to clean up there.
    // Still call close() ourselves: with hibernatable WebSockets this
    // completes the closing handshake on our side even if the client-side
    // close already happened.
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }
}
