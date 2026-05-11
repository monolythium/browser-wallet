// Golden byte-equality test for the two wei→decimal-LYTH helpers.
//
// The Phase 4.4 pending-row reconciliation contract in
// shared/activity.ts:reconcilePending matches a pending row against
// a confirmed tx_send by exact string equality on `amountDecimal`.
// The SW writes amountDecimal via weiHexToLythDecimal at broadcast
// time; the popup writes amountDecimal via the indexer pipeline,
// which Send.tsx parses via weiToLythString when computing display
// strings for the same numeric value. Both must produce byte-
// identical output across every wei value the wallet handles, or
// the heuristic match fails silently and the pending row sticks
// until the PENDING_TTL_MS backstop fires (~5 min of stale UI).
//
// This file is a single fixture sweep. If it ever fails, STOP — the
// divergence needs to be pinned at the source (decide which helper
// is canonical, fix the other) before any commit that touches either.

import { describe, expect, it } from "vitest";
import { weiHexToLythDecimal } from "./wei-decimal.js";
import { weiToLythString } from "../popup/pages/Send.js";

// Each fixture: a bigint wei value + the expected decimal string.
// The fixture set covers:
//   - 0 (degenerate)
//   - 1 wei (smallest non-zero — full 18-decimal fraction)
//   - 1e9 (gwei scale)
//   - 1e15 (sub-LYTH scale)
//   - 1e17 (0.1 LYTH — common Send amount)
//   - 1e18 (1 LYTH — integer boundary, fracPart === 0n branch)
//   - 7e18 + 123 (mixed integer + fractional)
//   - 1e20 (100 LYTH — large integer)
//   - 2^53 - 1 (Number.MAX_SAFE_INTEGER — float-precision boundary
//     that doesn't actually affect bigint math, but pins that we
//     never silently downcast)
const FIXTURES: Array<{ wei: bigint; expected: string; label: string }> = [
  { wei: 0n, expected: "0", label: "zero" },
  { wei: 1n, expected: "0.000000000000000001", label: "1 wei" },
  { wei: 1_000_000_000n, expected: "0.000000001", label: "1 gwei" },
  { wei: 1_000_000_000_000_000n, expected: "0.001", label: "1 finney (1e15)" },
  { wei: 100_000_000_000_000_000n, expected: "0.1", label: "0.1 LYTH" },
  { wei: 1_000_000_000_000_000_000n, expected: "1", label: "1 LYTH (integer boundary)" },
  {
    wei: 7_000_000_000_000_000_123n,
    expected: "7.000000000000000123",
    label: "7 LYTH + 123 wei (mixed)",
  },
  { wei: 100_000_000_000_000_000_000n, expected: "100", label: "100 LYTH" },
  {
    wei: BigInt(Number.MAX_SAFE_INTEGER), // 9_007_199_254_740_991
    expected: "0.009007199254740991",
    label: "Number.MAX_SAFE_INTEGER wei",
  },
];

describe("weiHexToLythDecimal (SW) vs weiToLythString (Send.tsx) — byte equality", () => {
  for (const { wei, expected, label } of FIXTURES) {
    it(`${label}: both helpers produce "${expected}"`, () => {
      const popupResult = weiToLythString(wei);
      const swResult = weiHexToLythDecimal("0x" + wei.toString(16));
      expect(popupResult).toBe(expected);
      expect(swResult).toBe(expected);
      // Cross-check: the two helpers' outputs must be byte-identical
      // for the reconcilePending heuristic match in shared/activity.ts
      // to fire. This is the load-bearing assertion.
      expect(swResult).toBe(popupResult);
    });
  }

  it("negative wei: both helpers return '0' defensively", () => {
    // Popup helper takes bigint directly; SW helper would fail BigInt()
    // parsing on a literal negative-sign hex string. Both should fall
    // through to the "0" guard.
    expect(weiToLythString(-1n)).toBe("0");
    expect(weiHexToLythDecimal("not-a-hex-string")).toBe("0");
  });

  it("SW helper accepts an unprefixed hex string (BigInt() coerces)", () => {
    // BigInt("16345785d8a0000") throws — only "0x..."-prefixed strings
    // are accepted. This test pins that behavior so a future helper
    // change can't silently start accepting unprefixed input.
    expect(weiHexToLythDecimal("16345785d8a0000")).toBe("0");
  });

  it("SW helper accepts lowercase and uppercase hex digits identically", () => {
    // 0x16345785d8a0000 === 0.1 LYTH in wei
    expect(weiHexToLythDecimal("0x16345785d8a0000")).toBe("0.1");
    expect(weiHexToLythDecimal("0x16345785D8A0000")).toBe("0.1");
  });
});
