import { DurableObject } from "cloudflare:workers";
import {
  closeAuction,
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
import { newBucket, takeToken, type Bucket } from "./ratelimit.js";
import { archiveSettlement, type SettlementRecord } from "./archive.js";

interface Attachment {
  participantId: string;
  nickname: string;
  bucket: Bucket;
}

/**
 * The subset of the Worker's env this DO reads directly.
 *
 * `DATABASE_URL` is optional because it is supplied as a Workers *secret*
 * in production (`wrangler secret put DATABASE_URL`), not a `[vars]`
 * entry — see the comment in `wrangler.toml`. With no `[vars]` entry, an
 * unset secret surfaces as `undefined` rather than `""`; `archiveSettlement`
 * treats the two identically.
 *
 * `LOBBY` is always bound (see `wrangler.toml`): it is how this room pushes
 * its live price to the singleton `LobbyDO` registry so the lobby page never
 * has to fan out to every room to render.
 */
export interface RoomEnv {
  DATABASE_URL?: string;
  LOBBY: DurableObjectNamespace;
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
  private readonly roomEnv: RoomEnv;

  /**
   * Testability seam, not a public extension point: production always
   * archives via the real `archiveSettlement`. DATABASE_URL is
   * deliberately unset throughout this package's test environment (so the
   * failure path is exercised for real), which makes the success path —
   * a row actually disappearing after a successful write — otherwise
   * unreachable from any test. Tests reach into this private field via a
   * cast to install a fake that resolves instead of throwing.
   */
  private archiveFn: typeof archiveSettlement = archiveSettlement;

  constructor(ctx: DurableObjectState, env: RoomEnv) {
    super(ctx, env as never);
    this.roomEnv = env;
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

  /**
   * Best-effort push of this room's live price to the lobby cache. Called
   * after an accepted bid and after settlement — the only two events that
   * change what the lobby should show — and never anywhere on the reject
   * path, since a rejected bid changes nothing worth caching.
   *
   * Deliberately swallows every failure. The lobby is a convenience cache,
   * not part of this room's authority: a stale price there is acceptable, a
   * bid or an alarm firing that fails because the lobby happened to be
   * unreachable is not. Nothing here is awaited by, or allowed to affect,
   * the caller's own success/failure outcome.
   *
   * The resolved `Response` (including a `404` from `LobbyDO` when this
   * room was never registered — see its price-update handler) is
   * deliberately never inspected. `fetch` only rejects on a transport-level
   * failure, never on an HTTP error status, so an unregistered room's 404
   * is just a normal resolved value here that this method discards without
   * looking at — it is observability for whoever reads the lobby's logs,
   * not a signal this method, or its callers, ever act on.
   */
  private async notifyLobby(): Promise<void> {
    const state = this.cached;
    const roomId = getMeta(this.ctx.storage.sql, "roomId");
    if (state === null || roomId === null) return;

    try {
      const stub = this.roomEnv.LOBBY.get(this.roomEnv.LOBBY.idFromName("global"));
      await stub.fetch(`https://lobby/lobby/rooms/${roomId}/price`, {
        method: "POST",
        body: JSON.stringify({
          highBid: state.highBid?.amount ?? null,
          status: state.status,
        }),
      });
    } catch {
      // See the doc comment above: a lobby write problem must never
      // propagate into the bid path or the alarm handler.
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

      // Stored so the archive record is human-readable without having to
      // decode the Durable Object id.
      const roomId = url.pathname.split("/")[2] ?? "";
      putMeta(this.ctx.storage.sql, "roomId", roomId);
      putMeta(this.ctx.storage.sql, "config", JSON.stringify(config));
      this.cached = null;
      // The clock is server-owned: this alarm, not a client timer, is what
      // closes the auction.
      await this.ctx.storage.setAlarm(config.endsAtMs);
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
        ws.serializeAttachment({
          participantId,
          nickname: msg.nickname,
          bucket: newBucket(Date.now()),
        } satisfies Attachment);

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

        // Checked before validateBid, and unconditionally persisted back to
        // the attachment whether or not the bid is allowed: a flood must
        // cost no rule evaluation, and a token spent on a rejected bid must
        // still count against the bucket or the limit is not a limit.
        const limit = takeToken(attachment.bucket, atMs);
        ws.serializeAttachment({ ...attachment, bucket: limit.bucket } satisfies Attachment);
        if (!limit.allowed) {
          this.send(ws, { t: "reject", clientSeq: msg.clientSeq, reason: "RATE_LIMITED" });
          return;
        }

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
        // A bid inside the anti-snipe window pushes endsAtMs out; re-arm so
        // the alarm still fires at the (possibly new) real deadline instead
        // of the one that was current when the room was initialised.
        await this.ctx.storage.setAlarm(this.cached.endsAtMs);
        await this.notifyLobby();
        return;
      }
    }
  }

  /**
   * The server-owned clock: closes the auction once its deadline has
   * passed, otherwise re-arms for whatever the current deadline is (an
   * anti-snipe extension can move it out from under an alarm that was
   * scheduled before the extension landed). `closeAuction` from
   * `@openbid/auction-core` decides the winner — this method only appends
   * the resulting event, broadcasts it, and queues the archive; no winner
   * logic lives here.
   */
  override async alarm(): Promise<void> {
    const state = this.state();
    if (state === null) {
      // No config yet (should not happen in practice — nothing arms an
      // alarm before /init does), but there could still be outbox rows
      // left over from a prior life of this object id. Drain regardless.
      await this.drainOutbox();
      return;
    }

    if (state.status === "open") {
      if (Date.now() >= state.endsAtMs) {
        const closed = closeAuction(state, Date.now());
        if (closed !== null) {
          const seq = appendEvent(this.ctx.storage.sql, closed);
          this.cached = reduce(state, closed);
          this.broadcast({ t: "delta", seq, serverTime: Date.now(), event: closed });
          await this.notifyLobby();

          const winnerId = this.cached.winner?.participantId ?? null;
          const record: SettlementRecord = {
            roomId: getMeta(this.ctx.storage.sql, "roomId") ?? this.ctx.id.toString(),
            itemName: state.config.itemName,
            startingPrice: state.config.startingPrice,
            winnerNickname:
              winnerId === null ? null : this.cached.participants[winnerId]?.nickname ?? null,
            winningPrice: this.cached.winner?.amount ?? null,
            closedAtMs: Date.now(),
            bidLog: readEventsSince(this.ctx.storage.sql, 0).map((row) => row.event),
          };
          this.ctx.storage.sql.exec(
            "INSERT INTO outbox (payload) VALUES (?)",
            JSON.stringify(record)
          );
        }
      } else {
        // The deadline moved out from under this alarm (an anti-snipe
        // extension landed between when it was scheduled and when it
        // fired). Come back at the real deadline instead of closing early.
        await this.ctx.storage.setAlarm(state.endsAtMs);
      }
    }

    await this.drainOutbox();
  }

  /**
   * Best-effort archive to Neon. Anything that fails to write — a bad
   * DATABASE_URL, a network error, Postgres being down — stays queued and
   * is retried on the next alarm; a Neon outage must never be able to lose
   * a settlement or block a live room.
   */
  private async drainOutbox(): Promise<void> {
    const rows = this.ctx.storage.sql
      .exec<{ id: number; payload: string }>("SELECT id, payload FROM outbox ORDER BY id ASC")
      .toArray();
    if (rows.length === 0) return;

    let anyFailed = false;
    for (const row of rows) {
      try {
        await this.archiveFn(this.roomEnv.DATABASE_URL, JSON.parse(row.payload));
        this.ctx.storage.sql.exec("DELETE FROM outbox WHERE id = ?", row.id);
      } catch {
        anyFailed = true;
      }
    }

    if (anyFailed) {
      // A Durable Object has exactly one alarm. If the auction is still
      // open, that alarm *is* the expiry clock, and this retry must never
      // push it later than it already is — doing so would mean the
      // auction can never close on time. Setting an *earlier* alarm is
      // always safe: when it fires, `alarm()` above sees the auction is
      // still open and re-arms for the real deadline, so the expiry
      // guarantee survives even if this races ahead of it. Once the room
      // is closed there is no expiry alarm to protect, so this simply
      // schedules the next retry.
      const retryAt = Date.now() + 60_000;
      const existing = await this.ctx.storage.getAlarm();
      if (existing === null || retryAt < existing) {
        await this.ctx.storage.setAlarm(retryAt);
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
