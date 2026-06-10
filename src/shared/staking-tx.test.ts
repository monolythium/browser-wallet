// staking-tx encoder tests.
//
// Pins three properties:
//   1. The wallet's calldata equals the SDK encoders byte-for-byte
//      and carries the chain-canonical selector — drift would silently
//      misroute a delegate tx into a non-existent precompile method.
//   2. Calldata follows standard Solidity ABI (32-byte big-endian words),
//      matching the mono-core abi.rs uint32/uint16 signatures.
//   3. The non-custodial percent ⇄ bps + effective-weight helpers round-trip
//      cleanly, including the truncation regime around the 1-bp boundary.

import { describe, expect, it } from "vitest";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  encodeDelegateCalldata,
  encodeUndelegateCalldata,
  encodeRedelegateCalldata,
  encodeClaimCalldata,
} from "@monolythium/core-sdk";
import {
  DELEGATION_PRECOMPILE,
  bpsToPercent,
  effectiveWeightWei,
  encodeClaimRewards,
  encodeDelegate,
  encodeRedelegate,
  encodeUndelegate,
  percentToBps,
} from "./staking-tx.js";

const enc = new TextEncoder();
function computeSelector(signature: string): string {
  const bytes = keccak_256(enc.encode(signature));
  let hex = "0x";
  for (let i = 0; i < 4; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

// ─────────────────────────────────────────────────────────────────────────────
// Precompile address
// ─────────────────────────────────────────────────────────────────────────────

describe("DELEGATION_PRECOMPILE", () => {
  it("is the Law §5.4 / §7.6 address (0x100A)", () => {
    expect(DELEGATION_PRECOMPILE).toBe(
      "0x000000000000000000000000000000000000100A",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// encodeDelegate / encodeUndelegate / encodeRedelegate
// ─────────────────────────────────────────────────────────────────────────────

// Golden vectors: the wallet's encoders must equal the SDK encoders
// byte-for-byte, and carry the chain-canonical selector (keccak256 of
// the mono-core `abi.rs` signature). Regression guard against the selector
// drift — the wallet previously emitted `delegate(uint256,uint256)`
// (0xd9a34952), which the live 0x100a precompile rejected as an unknown
// selector. These vectors confirm we now emit the chain-canonical
// `delegate(uint32,uint16)` (0x662337de) via SDK 0.3.9.

describe("encodeDelegate", () => {
  it("equals the SDK encoder + carries the chain delegate(uint32,uint16) selector", () => {
    const data = encodeDelegate(1, 2500);
    expect(data).toBe(encodeDelegateCalldata(1, 2500));
    expect(data.startsWith(computeSelector("delegate(uint32,uint16)"))).toBe(true);
    expect(data.startsWith("0x662337de")).toBe(true);
    // selector + cluster word + weightBps word.
    expect(data).toHaveLength(2 + 8 + 64 + 64);
    expect(data.slice(10, 10 + 64)).toBe("0".repeat(63) + "1"); // cluster
    expect(data.slice(10 + 64)).toBe("0".repeat(61) + "9c4"); // 2500 = 0x9c4
  });
});

describe("encodeUndelegate", () => {
  it("equals the SDK encoder + carries the chain undelegate(uint32) selector (full-row, 1 arg)", () => {
    const data = encodeUndelegate(3);
    expect(data).toBe(encodeUndelegateCalldata(3));
    expect(data.startsWith(computeSelector("undelegate(uint32)"))).toBe(true);
    expect(data.startsWith("0x914f3ca8")).toBe(true);
    // selector + single cluster word (no weight arg).
    expect(data).toHaveLength(2 + 8 + 64);
  });
});

describe("encodeRedelegate", () => {
  it("equals the SDK encoder + carries the chain redelegate(uint32,uint32,uint16) selector", () => {
    const data = encodeRedelegate(1, 2, 1500);
    expect(data).toBe(encodeRedelegateCalldata(1, 2, 1500));
    expect(data.startsWith(computeSelector("redelegate(uint32,uint32,uint16)"))).toBe(true);
    expect(data.startsWith("0xa06ac18f")).toBe(true);
    expect(data).toHaveLength(2 + 8 + 64 * 3);
  });
});

describe("encodeClaimRewards", () => {
  it("equals the SDK claim() encoder + carries the chain claim() selector", () => {
    expect(encodeClaimRewards()).toBe(encodeClaimCalldata());
    expect(encodeClaimRewards().startsWith(computeSelector("claim()"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// percentToBps / bpsToPercent / effectiveWeightWei (non-custodial)
// ─────────────────────────────────────────────────────────────────────────────

const ONE_LYTH = 10n ** 18n;

describe("percentToBps", () => {
  it("returns 0 for non-positive / non-finite input", () => {
    expect(percentToBps(0)).toBe(0);
    expect(percentToBps(-1)).toBe(0);
    expect(percentToBps(Number.NaN)).toBe(0);
  });

  it("maps whole + fractional percents to bps", () => {
    expect(percentToBps(25)).toBe(2500);
    expect(percentToBps(33.34)).toBe(3334);
    expect(percentToBps(100)).toBe(10_000);
  });

  it("clamps above 100% to 10000 bps", () => {
    expect(percentToBps(150)).toBe(10_000);
  });

  it("round-trips with bpsToPercent", () => {
    expect(bpsToPercent(percentToBps(25))).toBe(25);
    expect(bpsToPercent(percentToBps(33.34))).toBe(33.34);
    expect(bpsToPercent(0)).toBe(0);
  });
});

describe("effectiveWeightWei", () => {
  it("computes floor(balance × bps / 10000) of the LIVE balance", () => {
    const balance = 100n * ONE_LYTH;
    expect(effectiveWeightWei(2500, balance)).toBe(25n * ONE_LYTH);
    expect(effectiveWeightWei(3334, balance)).toBe(3334n * ONE_LYTH / 100n);
  });

  it("returns 0 for non-positive inputs", () => {
    expect(effectiveWeightWei(0, 100n * ONE_LYTH)).toBe(0n);
    expect(effectiveWeightWei(-1, 100n * ONE_LYTH)).toBe(0n);
    expect(effectiveWeightWei(5000, 0n)).toBe(0n);
  });

  it("returns the full balance for >= 10000 bps", () => {
    expect(effectiveWeightWei(10_000, 100n * ONE_LYTH)).toBe(100n * ONE_LYTH);
    expect(effectiveWeightWei(15_000, 100n * ONE_LYTH)).toBe(100n * ONE_LYTH);
  });
});
