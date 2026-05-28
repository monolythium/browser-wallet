// Phase 7 commit 2 — staking-tx encoder tests.
//
// Pins three properties that matter for the chain-side gate:
//   1. Function selectors never drift (drift would silently misroute
//      a delegate tx into the wrong precompile method).
//   2. Calldata encoding follows standard Solidity ABI (32-byte
//      big-endian words, left-padded for uint256).
//   3. lythAmountToBps + bpsToLythAmountWei round-trip cleanly,
//      including the truncation regime around the 1-bp boundary.

import { describe, expect, it } from "vitest";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  encodeDelegateCalldata,
  encodeRedelegateCalldata,
  encodeClaimCalldata,
} from "@monolythium/core-sdk";
import {
  DELEGATION_PRECOMPILE,
  DELEGATION_SELECTORS,
  encodeClaimRewards,
  encodeDelegate,
  encodeRedelegate,
  encodeUint256,
  encodeUndelegate,
  bpsToLythAmountWei,
  lythAmountToBps,
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
// Selectors
// ─────────────────────────────────────────────────────────────────────────────

describe("DELEGATION_SELECTORS", () => {
  it("matches keccak256 of the canonical signature for delegate", () => {
    expect(DELEGATION_SELECTORS.delegate).toBe(
      computeSelector("delegate(uint256,uint256)"),
    );
  });

  it("matches keccak256 for undelegate", () => {
    expect(DELEGATION_SELECTORS.undelegate).toBe(
      computeSelector("undelegate(uint256,uint256)"),
    );
  });

  it("matches keccak256 for redelegate", () => {
    expect(DELEGATION_SELECTORS.redelegate).toBe(
      computeSelector("redelegate(uint256,uint256,uint256)"),
    );
  });

  it("matches keccak256 for claimRewards", () => {
    expect(DELEGATION_SELECTORS.claimRewards).toBe(computeSelector("claimRewards()"));
  });

  it("DELEGATION_PRECOMPILE is the Law §5.4 / §7.6 address", () => {
    expect(DELEGATION_PRECOMPILE).toBe(
      "0x000000000000000000000000000000000000100A",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// encodeUint256
// ─────────────────────────────────────────────────────────────────────────────

describe("encodeUint256", () => {
  it("left-pads small numbers to 32 bytes", () => {
    expect(encodeUint256(1)).toBe("0".repeat(63) + "1");
    expect(encodeUint256(255)).toBe("0".repeat(62) + "ff");
  });

  it("handles bigint inputs", () => {
    // 1_000_000 = 0xf4240 (5 hex chars), padded to 64 = 59 zeros + 5 hex.
    expect(encodeUint256(1_000_000n)).toBe("0".repeat(59) + "f4240");
  });

  it("handles 0x-hex string inputs", () => {
    expect(encodeUint256("0xdeadbeef")).toBe("0".repeat(56) + "deadbeef");
  });

  it("rejects negative numbers", () => {
    expect(() => encodeUint256(-1)).toThrow();
    expect(() => encodeUint256(-1n)).toThrow();
  });

  it("rejects non-integers", () => {
    expect(() => encodeUint256(1.5)).toThrow();
  });

  it("rejects values overflowing uint256", () => {
    expect(() => encodeUint256(1n << 256n)).toThrow();
  });

  it("accepts the maximum uint256", () => {
    const max = (1n << 256n) - 1n;
    expect(encodeUint256(max)).toBe("f".repeat(64));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// encodeDelegate / encodeUndelegate / encodeRedelegate
// ─────────────────────────────────────────────────────────────────────────────

// Golden vectors: the wallet's encoders must equal the SDK encoders
// byte-for-byte, and carry the chain-canonical selector (keccak256 of
// the mono-core `abi.rs` signature). This is the regression guard
// against the R20 drift — the wallet previously shipped
// `delegate(uint256,uint256)` (0xd9a34952) which the live precompile
// rejects as unknown-selector.

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
  it("uses the undelegate selector", () => {
    const data = encodeUndelegate(3, 500);
    expect(data.startsWith(DELEGATION_SELECTORS.undelegate)).toBe(true);
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
// lythAmountToBps / bpsToLythAmountWei
// ─────────────────────────────────────────────────────────────────────────────

const ONE_LYTH = 10n ** 18n;

describe("lythAmountToBps", () => {
  it("returns 0 when the balance is zero", () => {
    expect(lythAmountToBps(ONE_LYTH, 0n)).toBe(0);
  });

  it("returns 10000 (100%) when amount equals balance", () => {
    expect(lythAmountToBps(100n * ONE_LYTH, 100n * ONE_LYTH)).toBe(10_000);
  });

  it("returns 10000 when amount exceeds balance (caller's job to reject)", () => {
    expect(lythAmountToBps(101n * ONE_LYTH, 100n * ONE_LYTH)).toBe(10_000);
  });

  it("floors fractional bp values", () => {
    // 33.34 LYTH out of 100 LYTH = 3334 bps (0.3334 of total).
    expect(lythAmountToBps(33340000000000000000n, 100n * ONE_LYTH)).toBe(3334);
  });

  it("handles small amounts that floor to zero bps", () => {
    // 0.00001 LYTH out of 100 LYTH would be 0.001 bps → floors to 0.
    expect(lythAmountToBps(10n ** 13n, 100n * ONE_LYTH)).toBe(0);
  });
});

describe("bpsToLythAmountWei", () => {
  it("inverts lythAmountToBps cleanly for 25%", () => {
    const balance = 100n * ONE_LYTH;
    const bps = lythAmountToBps(25n * ONE_LYTH, balance);
    expect(bps).toBe(2500);
    expect(bpsToLythAmountWei(bps, balance)).toBe(25n * ONE_LYTH);
  });

  it("returns 0 for non-positive inputs", () => {
    expect(bpsToLythAmountWei(0, 100n * ONE_LYTH)).toBe(0n);
    expect(bpsToLythAmountWei(-1, 100n * ONE_LYTH)).toBe(0n);
  });

  it("returns the full balance for >= 10000 bps", () => {
    expect(bpsToLythAmountWei(10_000, 100n * ONE_LYTH)).toBe(100n * ONE_LYTH);
    expect(bpsToLythAmountWei(15_000, 100n * ONE_LYTH)).toBe(100n * ONE_LYTH);
  });

  it("returns 0 when the balance is zero", () => {
    expect(bpsToLythAmountWei(5000, 0n)).toBe(0n);
  });
});
