// ─────────────────────────────────────────────────────────────────────────────
// Unit-domain drift guard — the single place every lythoshi-denominated bound is
// pinned to the decimals SOURCE OF TRUTH (`LYTHOSHI_PER_LYTH` from
// @monolythium/core-sdk). Each constant is asserted as an explicit multiple of
// LYTHOSHI_PER_LYTH, so a future decimals change (or a stale hand-typed literal)
// makes one of these assertions FAIL and forces a deliberate, reviewed update.
//
// This is the guard that was MISSING when MAX_PLAUSIBLE_BALANCE_LYTHOSHI stayed
// at the 8-decimal-era 2e16 through the 8→18-decimal migration — it silently
// dropped every real balance and stranded the balance UI on "loading". Pinning
// every lythoshi constant here against LYTHOSHI_PER_LYTH would have caught it.
//
// INTENTIONALLY EXCLUDED (NOT lythoshi — do not add them here): execution-unit
// COUNTS (MAX_EXECUTION_UNIT_LIMIT, TESTNET_TRANSFER_EXECUTION_UNIT_LIMIT_HEX),
// basis-points, chain ids, nonces, block heights. Those are decimal-agnostic and
// do not scale with the decimal domain.
//
// (Existing per-constant pins in balance-consensus.test.ts and networks.test.ts
// remain; this file consolidates the invariant against the decimals source.)
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from "vitest";
import { LYTHOSHI_PER_LYTH } from "@monolythium/core-sdk";
import { MAX_PLAUSIBLE_BALANCE_LYTHOSHI } from "./tx-mldsa.js";
import {
  MAX_EXECUTION_UNIT_PRICE_LYTHOSHI,
  MEMPOOL_PRIORITY_TIP_FLOOR_LYTHOSHI,
} from "../shared/operator-bounds.js";
import { MOCK_REWARD_PRINCIPAL_LYTHOSHI } from "./staking-client.js";
import {
  DEFAULT_PASSKEY_LIMIT_LYTHOSHI,
  MIN_PASSKEY_LIMIT_LYTHOSHI,
  MAX_PASSKEY_LIMIT_LYTHOSHI,
  DEFAULT_PASSKEY_DAILY_CAP_LYTHOSHI,
} from "../shared/passkey.js";

describe("unit-domain constants pinned to LYTHOSHI_PER_LYTH (18-decimal drift guard)", () => {
  it("LYTHOSHI_PER_LYTH is the 18-decimal source of truth (1 LYTH = 10^18 lythoshi)", () => {
    expect(LYTHOSHI_PER_LYTH).toBe(10n ** 18n);
  });

  it("balance ceiling = 2× the 10^26 genesis supply (200,000,000 LYTH)", () => {
    expect(MAX_PLAUSIBLE_BALANCE_LYTHOSHI).toBe(200_000_000n * LYTHOSHI_PER_LYTH);
  });

  it("passkey limits are exact LYTH multiples", () => {
    expect(DEFAULT_PASSKEY_LIMIT_LYTHOSHI).toBe(100n * LYTHOSHI_PER_LYTH);
    expect(MIN_PASSKEY_LIMIT_LYTHOSHI).toBe(1n * LYTHOSHI_PER_LYTH);
    expect(MAX_PASSKEY_LIMIT_LYTHOSHI).toBe(10_000n * LYTHOSHI_PER_LYTH);
    expect(DEFAULT_PASSKEY_DAILY_CAP_LYTHOSHI).toBe(500n * LYTHOSHI_PER_LYTH);
  });

  it("mock staking reward principal is an exact LYTH multiple", () => {
    expect(MOCK_REWARD_PRINCIPAL_LYTHOSHI).toBe(100n * LYTHOSHI_PER_LYTH);
  });

  it("execution-unit PRICE ceiling is pinned to the 18-decimal domain", () => {
    // A per-unit price ceiling (lythoshi/execution-unit), not a whole-LYTH
    // amount. Pinned both as its literal and relative to LYTHOSHI_PER_LYTH so a
    // decimals change breaks this assertion and forces review. The EXACT value
    // is a de-trust backstop and a pending fee-policy decision (see the
    // VALUE-DECISION note in networks.ts) — it must stay far above the realistic
    // ~1e9–1e10 lythoshi/unit price; today it is 0.001 LYTH/unit.
    expect(MAX_EXECUTION_UNIT_PRICE_LYTHOSHI).toBe(1_000_000_000_000_000n); // 1e15
    expect(MAX_EXECUTION_UNIT_PRICE_LYTHOSHI).toBe(LYTHOSHI_PER_LYTH / 1000n); // 0.001 LYTH/unit @ 18 dec
    // Never-too-low invariant: a wide margin above the realistic ~1e10 price so
    // it can never clamp a legitimate fee.
    expect(MAX_EXECUTION_UNIT_PRICE_LYTHOSHI).toBeGreaterThan(10_000n * 10_000_000_000n); // > 1e4 × 1e10
  });

  it("mempool priority-tip floor is 1 gwei pinned to the 18-decimal domain", () => {
    // The chain's per-execution-unit priority-tip admission floor (-32047 below
    // it). A per-unit lythoshi price, so pinned both as its literal and relative
    // to LYTHOSHI_PER_LYTH. 1e9 == 1 gwei == 10^18 / 10^9. The single source of
    // truth shared by the Send submit clamp and the native-fee-display headline
    // clamp; if the chain's floor moves, this assertion forces a reviewed update.
    expect(MEMPOOL_PRIORITY_TIP_FLOOR_LYTHOSHI).toBe(1_000_000_000n); // 1e9
    expect(MEMPOOL_PRIORITY_TIP_FLOOR_LYTHOSHI).toBe(LYTHOSHI_PER_LYTH / 1_000_000_000n); // 1 gwei @ 18 dec
    // The floor sits far below the price ceiling — they bound opposite ends.
    expect(MEMPOOL_PRIORITY_TIP_FLOOR_LYTHOSHI).toBeLessThan(MAX_EXECUTION_UNIT_PRICE_LYTHOSHI);
  });
});
