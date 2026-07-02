import { describe, expect, it } from "vitest";
import {
  lastKnownBalanceKey,
  makeLastKnownBalance,
  parseLastKnownBalance,
  selectSeedBalanceHex,
} from "./last-known-balance";

const ADDR = "0x" + "a".repeat(40);
const OTHER = "0x" + "b".repeat(40);
const CHAIN = "0x10F2C";
const OTHER_CHAIN = "0x1";

describe("lastKnownBalanceKey", () => {
  it("is per-(addr, chain) and namespaced", () => {
    expect(lastKnownBalanceKey(ADDR, CHAIN)).toBe(`mono.balance.${ADDR}.${CHAIN}`);
    // Distinct scopes never collide.
    expect(lastKnownBalanceKey(ADDR, CHAIN)).not.toBe(
      lastKnownBalanceKey(OTHER, CHAIN),
    );
    expect(lastKnownBalanceKey(ADDR, CHAIN)).not.toBe(
      lastKnownBalanceKey(ADDR, OTHER_CHAIN),
    );
  });
});

describe("makeLastKnownBalance + parseLastKnownBalance round-trip", () => {
  it("round-trips a well-formed record", () => {
    const rec = makeLastKnownBalance("0x1bc16d674ec80000", ADDR, CHAIN, 1_700_000_000_000);
    expect(parseLastKnownBalance(rec)).toEqual(rec);
  });
  it("rejects malformed / absent shapes (→ null, never a fabricated value)", () => {
    expect(parseLastKnownBalance(null)).toBeNull();
    expect(parseLastKnownBalance(undefined)).toBeNull();
    expect(parseLastKnownBalance("nope")).toBeNull();
    expect(parseLastKnownBalance({})).toBeNull();
    // Non-hex balance is rejected (no synthesized fallback).
    expect(
      parseLastKnownBalance({ balanceHex: "1000", addr: ADDR, chainId: CHAIN, ts: 1 }),
    ).toBeNull();
    expect(
      parseLastKnownBalance({ balanceHex: "0xZZ", addr: ADDR, chainId: CHAIN, ts: 1 }),
    ).toBeNull();
    // Missing / wrong-typed fields.
    expect(
      parseLastKnownBalance({ balanceHex: "0x1", addr: ADDR, chainId: CHAIN }),
    ).toBeNull();
    expect(
      parseLastKnownBalance({ balanceHex: "0x1", addr: 1, chainId: CHAIN, ts: 1 }),
    ).toBeNull();
  });
});

describe("selectSeedBalanceHex — addr/chain matching (NO-MOCK guard)", () => {
  const rec = makeLastKnownBalance("0x1bc16d674ec80000", ADDR, CHAIN, 1_700_000_000_000);

  it("returns the balanceHex when addr + chain match", () => {
    expect(selectSeedBalanceHex(rec, ADDR, CHAIN)).toBe("0x1bc16d674ec80000");
  });

  it("IGNORES (→ null) a record for a different address", () => {
    expect(selectSeedBalanceHex(rec, OTHER, CHAIN)).toBeNull();
  });

  it("IGNORES (→ null) a record for a different chain", () => {
    expect(selectSeedBalanceHex(rec, ADDR, OTHER_CHAIN)).toBeNull();
  });

  it("returns null when there is no persisted record (→ C1 skeleton)", () => {
    expect(selectSeedBalanceHex(undefined, ADDR, CHAIN)).toBeNull();
    expect(selectSeedBalanceHex(null, ADDR, CHAIN)).toBeNull();
  });

  it("returns null for a malformed record (→ C1 skeleton, never a fabricated number)", () => {
    expect(
      selectSeedBalanceHex(
        { balanceHex: "0xZZ", addr: ADDR, chainId: CHAIN, ts: 1 },
        ADDR,
        CHAIN,
      ),
    ).toBeNull();
  });
});
