import { z } from "zod";

export const PROTOCOL_VERSION = 1;

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

export const clientMessageSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello"), lastSeenSeq: seq, nickname: z.string().min(1).max(32) }),
  z.object({ t: z.literal("bid"), clientSeq: seq, amount: money }),
  z.object({ t: z.literal("ping"), clientTime: z.number().finite() }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const serverMessageSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("snapshot"), seq, serverTime: z.number(), state: z.unknown() }),
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
