import { DurableObject } from "cloudflare:workers";
import {
  initialState,
  reduce,
  validateBid,
  type AuctionConfig,
  type AuctionState,
} from "@openbid/auction-core";
import { encode, parseClientMessage, type ServerMessage } from "@openbid/protocol";
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
    ws.send(encode(msg));
  }

  private broadcast(msg: ServerMessage): void {
    const payload = encode(msg);
    for (const ws of this.ctx.getWebSockets()) ws.send(payload);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname.endsWith("/init")) {
      const config = (await request.json()) as AuctionConfig;
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
        const participantId = crypto.randomUUID();
        ws.serializeAttachment({ participantId, nickname: msg.nickname } satisfies Attachment);

        const joinEvent = {
          type: "joined" as const,
          participantId,
          nickname: msg.nickname,
          atMs: Date.now(),
        };
        const joinSeq = appendEvent(this.ctx.storage.sql, joinEvent);
        this.cached = reduce(state, joinEvent);

        this.send(ws, {
          t: "snapshot",
          seq: joinSeq,
          serverTime: Date.now(),
          state: { ...this.cached, youAre: participantId },
        });
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

  override async webSocketClose(): Promise<void> {
    // Participants persist in the event log; nothing to clean up.
  }
}
