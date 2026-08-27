import { z } from "zod";

export const PROTOCOL_VERSION = 1;

// Shared with apps/web's identity.ts, which truncates every nickname it
// resolves -- a signed-in user's GitHub login, and the client-writable
// `openbid_guest` cookie value -- to this same limit before it can ever
// reach a "hello". Imported from here rather than duplicated as a bare
// literal, so that truncation and this wire-level cap cannot silently
// drift apart: if they did, an over-long nickname would fail the `hello`
// schema below, `RoomDO` would close the socket with 1003, and the
// client's own reconnect would resend it forever.
export const NICKNAME_MAX_LENGTH = 32;

export const rejectReasonSchema = z.enum([
  "TOO_LOW",
  "AUCTION_CLOSED",
  "RATE_LIMITED",
  "INSUFFICIENT_BUDGET",
]);
export type RejectReason = z.infer<typeof rejectReasonSchema>;

const seq = z.number().int().nonnegative();
const money = z.number().finite().positive();

// The shape of `POST /rooms/:id/init`'s body. This is a real cross-boundary
// contract (the web app produces it, room-do validates it), which is what
// this package is for. Declared structurally, without importing
// `@openbid/auction-core`, exactly like `RejectReason` above: room-do assigns
// the parsed result where auction-core's `AuctionConfig` is expected, so a
// mismatch between the two independently-declared shapes is a type error in
// room-do's typecheck, not a runtime surprise.
export const auctionConfigSchema = z.object({
  itemName: z.string().min(1),
  startingPrice: money,
  minIncrement: money,
  startingBudget: money,
  antiSnipeWindowMs: z.number().finite(),
  antiSnipeExtensionMs: z.number().finite(),
  endsAtMs: z.number().finite(),
});
export type AuctionConfig = z.infer<typeof auctionConfigSchema>;

// The shape of `POST /lobby/rooms`'s body. Also a real cross-boundary
// contract — Task 13's web app produces this when a room is created — so it
// gets the same treatment as `auctionConfigSchema` above rather than a cast.
export const lobbyRegisterSchema = z.object({
  roomId: z.string().min(1),
  itemName: z.string().min(1),
  endsAtMs: z.number().finite(),
});
export type LobbyRegister = z.infer<typeof lobbyRegisterSchema>;

// The shape of `POST /lobby/rooms/:roomId/price`'s body. Only `RoomDO`'s own
// notifier ever produces this one, but it crosses the same Worker-request
// boundary as the two contracts above, so it is validated the same way
// rather than trusted because the caller happens to be in-repo.
export const lobbyPriceSchema = z.object({
  highBid: money.nullable(),
  status: z.enum(["open", "closed"]),
});
export type LobbyPrice = z.infer<typeof lobbyPriceSchema>;

// Structurally mirrors `@openbid/auction-core`'s `AuctionEvent` union,
// without importing auction-core -- same reasoning, and same guard
// pattern, as `auctionConfigSchema` above (room-do assigns the parsed
// result where auction-core's `AuctionEvent` is expected, so a mismatch
// between the two independently-declared shapes is a type error at that
// assignment, not a runtime surprise).
//
// This schema exists for Task 16's replay path specifically: Neon's
// `completed_auctions.bid_log` column is `jsonb` with no schema of its
// own, and it is the one input capable of making the replay/determinism
// test lie -- feed `reduce` a malformed log (wrong `type`, a stringified
// number, a missing field) and replay would fold garbage and still
// "match" a comparison built the same way. `reduce`'s switch has no
// default case, so an unrecognised `type` reaching it is a silent bug,
// not a caught error. It is declared here, in `@openbid/protocol`, and
// not in `@openbid/auction-core`, because auction-core is deliberately
// the pure rules layer with zero dependencies (no `zod`), while this
// package already owns every other cross-boundary/external-input shape
// in the repo (`auctionConfigSchema`, `lobbyRegisterSchema`, the wire
// message schemas) and already depends on zod for exactly that job. A
// Neon row is exactly such a boundary: external, untyped at rest, and
// read back by `apps/web`, which already depends on both packages.
export const auctionEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("joined"),
    participantId: z.string().min(1),
    nickname: z.string().min(1),
    atMs: z.number().finite(),
  }),
  z.object({
    type: z.literal("bidPlaced"),
    participantId: z.string().min(1),
    amount: z.number().finite(),
    atMs: z.number().finite(),
    newEndsAtMs: z.number().finite(),
  }),
  z.object({
    type: z.literal("closed"),
    atMs: z.number().finite(),
    winner: z.object({ participantId: z.string().min(1), amount: z.number().finite() }).nullable(),
  }),
]);
export type AuctionEvent = z.infer<typeof auctionEventSchema>;

// The shape of a row `apps/web`'s replay path reads back from Neon's
// `completed_auctions` table (see `packages/room-do/src/archive.ts` for
// the insert side). A real cross-boundary contract from an external
// system into the app, gated the same way as the schemas above, with
// `bidLog` validated element-by-element via `auctionEventSchema` rather
// than trusted as `unknown[]` -- see that schema's comment for why.
//
// `startingPrice`/`winningPrice` use `z.coerce.number()`, not plain
// `z.number()`, because `starting_price`/`winning_price` are `NUMERIC` in
// `packages/room-do/schema.sql`, and Neon's serverless driver returns
// `NUMERIC`/`DECIMAL` columns as JS strings by default (avoiding silent
// float-precision loss on arbitrary-precision values) -- there is no
// column-level way to make it hand back a JS number instead. The read
// query in `apps/web/src/lib/replay.ts` also casts both columns with
// `::float`, matching `leaderboard.ts`'s existing precedent on this same
// table, but the coercion here is the layer that survives someone later
// removing that cast. `.finite()` still rejects genuine garbage: coercing
// a non-numeric string (e.g. `"abc"`) produces `NaN`, which `.finite()`
// rejects same as it always did.
export const archivedAuctionSchema = z.object({
  itemName: z.string().min(1),
  startingPrice: z.coerce.number().finite(),
  winningPrice: z.coerce.number().finite().nullable(),
  winnerNickname: z.string().min(1).nullable(),
  bidLog: z.array(auctionEventSchema),
});
export type ArchivedAuction = z.infer<typeof archivedAuctionSchema>;

export const clientMessageSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello"), lastSeenSeq: seq, nickname: z.string().min(1).max(NICKNAME_MAX_LENGTH) }),
  z.object({ t: z.literal("bid"), clientSeq: seq, amount: money }),
  z.object({ t: z.literal("ping"), clientTime: z.number().finite() }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const serverMessageSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("snapshot"),
    seq,
    serverTime: z.number(),
    state: z.unknown(),
    // Per-connection view metadata (which participant this socket is), not
    // part of the auction state itself — kept as a sibling field so
    // consumers never have to cast `state` to smuggle it back out.
    youAre: z.string(),
  }),
  z.object({ t: z.literal("delta"), seq, serverTime: z.number(), event: z.unknown() }),
  z.object({ t: z.literal("ack"), clientSeq: seq, seq }),
  z.object({ t: z.literal("reject"), clientSeq: seq, reason: rejectReasonSchema }),
  z.object({ t: z.literal("pong"), clientTime: z.number(), serverTime: z.number() }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

const jsonEnvelope = z.string().transform((raw, ctx): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid JSON" });
    return z.NEVER;
  }
});

const clientEnvelopeSchema = jsonEnvelope.pipe(clientMessageSchema);
const serverEnvelopeSchema = jsonEnvelope.pipe(serverMessageSchema);

export function parseClientMessage(raw: string): ClientMessage {
  return clientEnvelopeSchema.parse(raw);
}

export function parseServerMessage(raw: string): ServerMessage {
  return serverEnvelopeSchema.parse(raw);
}

export function encode(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}
