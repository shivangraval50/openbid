import { describe, it, expect } from "vitest";
import { ZodError } from "zod";
import {
  auctionConfigSchema,
  auctionEventSchema,
  archivedAuctionSchema,
  lobbyRegisterSchema,
  lobbyPriceSchema,
  parseClientMessage,
  parseServerMessage,
  encode,
} from "./index.js";

describe("parseClientMessage", () => {
  it("accepts a bid", () => {
    const msg = parseClientMessage(JSON.stringify({ t: "bid", clientSeq: 7, amount: 120 }));
    expect(msg).toEqual({ t: "bid", clientSeq: 7, amount: 120 });
  });

  it("accepts a hello", () => {
    const msg = parseClientMessage(JSON.stringify({ t: "hello", lastSeenSeq: 0, nickname: "ada" }));
    expect(msg.t).toBe("hello");
  });

  it("rejects an unknown message type", () => {
    expect(() => parseClientMessage(JSON.stringify({ t: "nope" }))).toThrow();
  });

  it("rejects a bid with a non-numeric amount", () => {
    expect(() => parseClientMessage(JSON.stringify({ t: "bid", clientSeq: 1, amount: "120" }))).toThrow();
  });

  it("rejects a negative bid amount", () => {
    expect(() => parseClientMessage(JSON.stringify({ t: "bid", clientSeq: 1, amount: -5 }))).toThrow();
  });

  it("rejects malformed JSON", () => {
    expect(() => parseClientMessage("{{{")).toThrow(ZodError);
  });

  it("rejects well-formed JSON but invalid message shape", () => {
    expect(() => parseClientMessage(JSON.stringify({ foo: "bar" }))).toThrow(ZodError);
  });
});

describe("parseServerMessage", () => {
  it("accepts a reject with a known reason", () => {
    const msg = parseServerMessage(JSON.stringify({ t: "reject", clientSeq: 3, reason: "TOO_LOW" }));
    expect(msg).toEqual({ t: "reject", clientSeq: 3, reason: "TOO_LOW" });
  });

  it("rejects an unknown reject reason", () => {
    expect(() =>
      parseServerMessage(JSON.stringify({ t: "reject", clientSeq: 3, reason: "BECAUSE" }))
    ).toThrow(ZodError);
  });

  it("rejects malformed JSON", () => {
    expect(() => parseServerMessage("{{{")).toThrow(ZodError);
  });
});

describe("auctionConfigSchema", () => {
  const valid = {
    itemName: "A rare compiler",
    startingPrice: 100,
    minIncrement: 10,
    startingBudget: 500,
    antiSnipeWindowMs: 10_000,
    antiSnipeExtensionMs: 15_000,
    endsAtMs: Date.now() + 600_000,
  };

  it("accepts a well-formed config", () => {
    expect(auctionConfigSchema.parse(valid)).toEqual(valid);
  });

  it("rejects an empty body", () => {
    expect(() => auctionConfigSchema.parse({})).toThrow(ZodError);
  });

  it("rejects a config missing a required field", () => {
    const { endsAtMs, ...rest } = valid;
    expect(() => auctionConfigSchema.parse(rest)).toThrow(ZodError);
  });
});

describe("lobbyRegisterSchema", () => {
  const valid = { roomId: "alpha", itemName: "A rare compiler", endsAtMs: Date.now() + 600_000 };

  it("accepts a well-formed registration", () => {
    expect(lobbyRegisterSchema.parse(valid)).toEqual(valid);
  });

  it("rejects an empty body", () => {
    expect(() => lobbyRegisterSchema.parse({})).toThrow(ZodError);
  });

  it("rejects an empty roomId", () => {
    expect(() => lobbyRegisterSchema.parse({ ...valid, roomId: "" })).toThrow(ZodError);
  });

  it("rejects a non-numeric endsAtMs", () => {
    expect(() => lobbyRegisterSchema.parse({ ...valid, endsAtMs: "soon" })).toThrow(ZodError);
  });
});

describe("lobbyPriceSchema", () => {
  it("accepts a null highBid with an open status", () => {
    expect(lobbyPriceSchema.parse({ highBid: null, status: "open" })).toEqual({
      highBid: null,
      status: "open",
    });
  });

  it("accepts a numeric highBid with a closed status", () => {
    expect(lobbyPriceSchema.parse({ highBid: 250, status: "closed" })).toEqual({
      highBid: 250,
      status: "closed",
    });
  });

  it("rejects an unknown status", () => {
    expect(() => lobbyPriceSchema.parse({ highBid: 100, status: "pending" })).toThrow(ZodError);
  });

  it("rejects a negative highBid", () => {
    expect(() => lobbyPriceSchema.parse({ highBid: -5, status: "open" })).toThrow(ZodError);
  });
});

describe("encode", () => {
  it("round-trips through the parser", () => {
    const original = { t: "ping", clientTime: 1000 } as const;
    expect(parseClientMessage(encode(original))).toEqual(original);
  });
});

describe("auctionEventSchema", () => {
  it("accepts a well-formed joined event", () => {
    const event = { type: "joined", participantId: "ada", nickname: "ada", atMs: 0 };
    expect(auctionEventSchema.parse(event)).toEqual(event);
  });

  it("accepts a well-formed bidPlaced event", () => {
    const event = {
      type: "bidPlaced",
      participantId: "ada",
      amount: 100,
      atMs: 10,
      newEndsAtMs: 20_000,
    };
    expect(auctionEventSchema.parse(event)).toEqual(event);
  });

  it("accepts a well-formed closed event with a winner", () => {
    const event = { type: "closed", atMs: 30, winner: { participantId: "ada", amount: 100 } };
    expect(auctionEventSchema.parse(event)).toEqual(event);
  });

  it("accepts a well-formed closed event with no winner", () => {
    const event = { type: "closed", atMs: 30, winner: null };
    expect(auctionEventSchema.parse(event)).toEqual(event);
  });

  // This is the exact hazard Task 16's replay path exists to guard
  // against: an event object whose `type` isn't one `reduce` recognises
  // (a typo, a future event kind the archive hasn't caught up to yet).
  // `reduce`'s switch has no default case, so feeding it straight through
  // would be a silent no-op or a type-level lie, not a caught error.
  it("rejects an event with an unrecognised type", () => {
    const event = { type: "bidRetracted", participantId: "ada", atMs: 0 };
    expect(() => auctionEventSchema.parse(event)).toThrow(ZodError);
  });

  // A bid amount that arrived as a string (e.g. a jsonb round-trip quirk,
  // or a hand-edited row) must be rejected here rather than flow into
  // `reduce`, which trusts `event.amount` is already a number and would
  // otherwise poison every derived `highBid.amount` comparison downstream.
  it("rejects a bidPlaced event whose amount is not a number", () => {
    const event = {
      type: "bidPlaced",
      participantId: "ada",
      amount: "100",
      atMs: 10,
      newEndsAtMs: 20_000,
    };
    expect(() => auctionEventSchema.parse(event)).toThrow(ZodError);
  });

  it("rejects a joined event missing a required field", () => {
    const event = { type: "joined", participantId: "ada", atMs: 0 };
    expect(() => auctionEventSchema.parse(event)).toThrow(ZodError);
  });
});

describe("archivedAuctionSchema", () => {
  const valid = {
    itemName: "A rare compiler",
    startingPrice: 100,
    winningPrice: 400,
    winnerNickname: "ada",
    bidLog: [
      { type: "joined", participantId: "ada", nickname: "ada", atMs: 0 },
      { type: "bidPlaced", participantId: "ada", amount: 100, atMs: 10, newEndsAtMs: 20_000 },
      { type: "closed", atMs: 30, winner: { participantId: "ada", amount: 100 } },
    ],
  };

  it("accepts a well-formed archived auction", () => {
    expect(archivedAuctionSchema.parse(valid)).toEqual(valid);
  });

  it("accepts an unsold auction with null winner fields", () => {
    const unsold = { ...valid, winningPrice: null, winnerNickname: null, bidLog: [] };
    expect(archivedAuctionSchema.parse(unsold)).toEqual(unsold);
  });

  // The requirement this pins: a bid log that is not even an array (the
  // shape Neon's jsonb column would return if the archive write ever put
  // something other than a JSON array in that column) must be rejected
  // here, before it ever reaches `reduce.slice(...)` in replay.ts. A
  // schema that only validated the auction's scalar fields and passed
  // `bidLog` through with `z.unknown()` or `z.array(z.unknown())` would
  // let this through and fail this test.
  it("rejects an archived auction whose bidLog is not an array", () => {
    const malformed = { ...valid, bidLog: "not-an-array" };
    expect(() => archivedAuctionSchema.parse(malformed)).toThrow(ZodError);
  });

  // A bid log that IS an array, but contains one entry that is not a
  // recognised event (here, a plain string instead of an object with a
  // `type`), must fail the same way. This is the case a shallow
  // `Array.isArray(bidLog)` check -- without validating each element --
  // would miss entirely.
  it("rejects an archived auction whose bidLog contains a malformed entry", () => {
    const malformed = { ...valid, bidLog: [...valid.bidLog, "not-an-event"] };
    expect(() => archivedAuctionSchema.parse(malformed)).toThrow(ZodError);
  });

  it("rejects an archived auction missing itemName", () => {
    const { itemName, ...rest } = valid;
    expect(() => archivedAuctionSchema.parse(rest)).toThrow(ZodError);
  });
});
