// W-1 — the block-height parser behind the "only a HIGHER head is progress"
// predicate.
//
// The liveness check used to be a string inequality on the block hex, so any
// change scored as progress. Comparing heights instead needs a parse that is
// total: the poll's transport validates only `typeof result === "string"`
// (service-worker readChainBlock), so a malformed value genuinely reaches the
// popup and `BigInt("garbage")` would throw inside the tick.

import { describe, expect, it } from "vitest";

import { isWellFormedBlockNumberHex, parseBlockHeight } from "./block-height.js";

describe("isWellFormedBlockNumberHex", () => {
  it("accepts a real head, zero, and the u64 ceiling", () => {
    expect(isWellFormedBlockNumberHex("0x3547a")).toBe(true);
    expect(isWellFormedBlockNumberHex("0x0")).toBe(true);
    expect(isWellFormedBlockNumberHex("0xffffffffffffffff")).toBe(true); // 16 digits
  });

  it("rejects malformed and oversized strings", () => {
    expect(isWellFormedBlockNumberHex("0x")).toBe(false);
    expect(isWellFormedBlockNumberHex("0xZZZ")).toBe(false);
    expect(isWellFormedBlockNumberHex("3547a")).toBe(false); // no 0x
    expect(isWellFormedBlockNumberHex("0x00000000000000000")).toBe(false); // 17
  });

  it("rejects non-strings — the transport only checks typeof string", () => {
    expect(isWellFormedBlockNumberHex(null)).toBe(false);
    expect(isWellFormedBlockNumberHex(undefined)).toBe(false);
    expect(isWellFormedBlockNumberHex(218234)).toBe(false);
    expect(isWellFormedBlockNumberHex({})).toBe(false);
  });
});

describe("parseBlockHeight", () => {
  it("parses a head to its numeric height", () => {
    expect(parseBlockHeight("0x3547a")).toBe(218234n);
  });

  it("treats 0x0 as a real reading of zero, not a sentinel", () => {
    expect(parseBlockHeight("0x0")).toBe(0n);
  });

  // The case a string comparison gets wrong: same height, different text.
  it("ignores leading zeros — the same height, which !== called a change", () => {
    expect(parseBlockHeight("0x0003547a")).toBe(parseBlockHeight("0x3547a"));
  });

  it("returns null for anything it cannot parse, rather than throwing", () => {
    expect(parseBlockHeight("0x")).toBeNull();
    expect(parseBlockHeight("0xZZZ")).toBeNull();
    expect(parseBlockHeight(null)).toBeNull();
    expect(parseBlockHeight(undefined)).toBeNull();
    expect(parseBlockHeight({})).toBeNull();
  });
});
