// Operator de-trust rails (audit X2).
//
// A single sane-upper-bound primitive shared by the two operator-read
// de-trust fixes:
//   - Item C / T4-03 — balance ceiling: an operator-reported balance above
//     the bound can only come from a lying/buggy operator, so the entry is
//     DROPPED (isWithinSaneBound === false) rather than allowed to win the
//     MAX-consensus reduce.
//   - Item D / T4-04 — fee ceiling: an operator- or popup-supplied execution-
//     unit price above the bound is CLAMPED (clampToSaneBound) before it is
//     signed into a transaction.
//
// These are de-trust backstops against absurd values, NOT economic claims:
// the bounds are deliberately generous so a legitimate (even unusually high)
// value is never blocked, while a physically-impossible value is caught.

/** True when `value` is a non-negative quantity at or below the inclusive
 *  bound. Used by the balance ceiling to decide whether to keep an operator's
 *  reported balance. */
export function isWithinSaneBound(value: bigint, maxInclusive: bigint): boolean {
  return value >= 0n && value <= maxInclusive;
}

/** Clamp `value` into `[0, maxInclusive]`. Used by the fee ceiling so an
 *  inflated operator/popup price cannot be signed verbatim. */
export function clampToSaneBound(value: bigint, maxInclusive: bigint): bigint {
  if (value < 0n) return 0n;
  return value > maxInclusive ? maxInclusive : value;
}

/**
 * T4-04 (Item D) — absolute sane upper bound on an operator-reported (or
 * popup-supplied) per-execution-unit PRICE. A de-trust BACKSTOP, not an
 * economic claim: the wallet signs the fee the user saw (T4-04 b1), but a
 * malicious/MITM operator (or a tampered popup) could still supply an absurd
 * `maxFeePerGas`; `clampToSaneBound` caps it here so a single unit can never be
 * priced above this line. Paired with the balance ceiling (Item C) via the
 * shared `isWithinSaneBound` helper.
 *
 * Lives in this shared module (next to `clampToSaneBound`, the single source of
 * truth) so both the background clamp sites and the popup display can import the
 * one constant without the popup pulling in the background RPC graph.
 *
 * UNIT NOTE: lythoshi-per-execution-unit, 18-decimal domain (1 LYTH = 10^18
 * lythoshi = LYTHOSHI_PER_LYTH). The realistic price is ~1e9–1e10 lythoshi/unit
 * (idle testnet; the Send page shows ~1e9), so 1e15 sits ~1e5–1e6× above real.
 * It therefore NEVER clamps a legitimate price — the dangerous direction would
 * be a too-LOW ceiling that clamps a real high price down and underprices/stalls
 * the tx — while bounding the worst-case malicious-induced fee to
 * 1e15 × 30000 units = 3e19 lythoshi = 30 LYTH per transfer (and that fee is
 * shown to the user via display==signed). The value MUST track the 18-decimal
 * domain: at the prior 8-decimal scale 1e15 read as ~10,000,000 LYTH/unit; at 18
 * decimals it means 0.001 LYTH/unit — still a safe loose ceiling, but the
 * magnitude intent changed, so the stale comment was corrected.
 *
 * VALUE-DECISION (needs-decision — deliberately NOT changed here): 1e15 is
 * loose-but-safe. Tightening toward realistic-peak-price × margin (e.g. 1e12–
 * 1e13 → ~0.03–0.3 LYTH max fee) would shrink the malicious-overpay window, but
 * is only safe if it stays comfortably above the network's realistic PEAK price
 * under congestion — which the wallet cannot observe (a fee-policy call). Kept
 * loose-but-safe pending that decision; never lower it below a wide margin over
 * the real ~1e9–1e10 price.
 */
export const MAX_EXECUTION_UNIT_PRICE_LYTHOSHI = 1_000_000_000_000_000n; // 1e15 lythoshi/unit (18-dec; loose-but-safe — see VALUE-DECISION)
