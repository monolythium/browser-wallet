import { describe, expect, it } from "vitest";
import {
  SENT_ADDRESSES_CAP,
  sentAddressesKey,
  parseSentAddresses,
  addToSentList,
  isSentAddress,
} from "./sent-addresses.js";

describe("sent-addresses", () => {
  it("builds a per-(vault, chain) key", () => {
    expect(sentAddressesKey("0xabc", "0x10f2c")).toBe(
      "mono.sent-addrs.0xabc.0x10f2c",
    );
  });

  it("parses tolerantly (malformed → empty)", () => {
    expect(parseSentAddresses({ addrs: ["0xa", "0xb"] })).toEqual(["0xa", "0xb"]);
    expect(parseSentAddresses(null)).toEqual([]);
    expect(parseSentAddresses({ addrs: "nope" })).toEqual([]);
    expect(parseSentAddresses({ addrs: [1, "0xb", null] })).toEqual(["0xb"]);
  });

  it("adds newest-first, dedupes case-insensitively, and caps", () => {
    expect(addToSentList([], "0xAbC")).toEqual(["0xabc"]);
    expect(addToSentList(["0xabc"], "0xABC")).toEqual(["0xabc"]);
    expect(addToSentList(["0xold"], "0xnew")).toEqual(["0xnew", "0xold"]);
    const big = Array.from({ length: SENT_ADDRESSES_CAP }, (_, i) => `0x${i}`);
    expect(addToSentList(big, "0xbrandnew")).toHaveLength(SENT_ADDRESSES_CAP);
    expect(addToSentList(big, "0xbrandnew")[0]).toBe("0xbrandnew");
  });

  it("isSentAddress is case-insensitive", () => {
    expect(isSentAddress(["0xabc"], "0xABC")).toBe(true);
    expect(isSentAddress(["0xabc"], "0xdef")).toBe(false);
  });
});
