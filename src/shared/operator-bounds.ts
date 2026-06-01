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
