import { describe, it, expect } from "vitest";
import { ZodError } from "zod";
import { parseClientMessage, parseServerMessage, encode } from "./index.js";

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

describe("encode", () => {
  it("round-trips through the parser", () => {
    const original = { t: "ping", clientTime: 1000 } as const;
    expect(parseClientMessage(encode(original))).toEqual(original);
  });
});
