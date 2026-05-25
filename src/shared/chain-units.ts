// Chain-unit compensation for the V4-LIVE-0008 wei-on-wire / lythoshi-internal
// regime.
//
// The Sprintnet operator binary in production as of 2026-05-25 is commit
// `5aead0f0` (V4-LIVE-0008 live-compat branch off `5bf1b55`, 2026-05-18).
// Per its commit message it carries ONLY the strict-catchup repair and
// intentionally does NOT include the lythoshi-rescaling commits that
// landed on mono-core master after that date (`d0f80129`, `03c425f5`,
// `99175896`, `a2a9e1fc`, `9483d033`, etc.). Operators therefore continue
// to report `eth_getBalance` results, `eth_feeHistory` base fees, and
// every other numeric field in 18-decimal wei.
//
// The wallet's internal numeric domain was refactored to 8-decimal
// lythoshi per whitepaper §23.1 (1 LYTH = 10^8 lythoshi; lythoshi is the
// canonical atomic unit). Display helpers (`formatLyth`, `formatNativeLythAmount`)
// assume their input is in lythoshi.
//
// Result: the chain returns 10^17 wei for a 0.1 LYTH balance; the wallet
// passes that through to `formatNativeLythAmount` which divides by 10^8
// (lythoshi-per-LYTH) and renders `1,000,000,000`. The 10^10 over-display
// factor is the wei-vs-lythoshi unit ratio.
//
// This module is the single shared chokepoint that converts between the
// chain wire (legacy wei) and wallet internal (lythoshi) representations.
//
// MIGRATION: when operators upgrade to a runtime past `a2a9e1fc` (indexer
// native balances to lythoshi width) AND the runtime balance/fee reporting
// follows suit, flip `CHAIN_RETURNS_LEGACY_WEI` to `false`. All boundary
// helpers below short-circuit to identity; no other wallet code changes.

/**
 * Conversion factor between 18-decimal wei and 8-decimal lythoshi.
 * 1 lythoshi = 10^10 wei. 1 LYTH = 10^8 lythoshi = 10^18 wei.
 */
export const WEI_PER_LYTHOSHI = 10_000_000_000n;

/**
 * When `true`, chain numeric fields (balance, base fee, gas price) are
 * interpreted as 18-decimal wei magnitudes and divided by
 * `WEI_PER_LYTHOSHI` before being handed to wallet-internal callers that
 * expect lythoshi. When `false`, no transformation is applied — the
 * runtime is assumed to be on the lythoshi-native path.
 *
 * Set true while Sprintnet operators run the V4-LIVE-0008 (commit
 * `5aead0f0`) line. Flip to false in lockstep with the operator binary
 * upgrade past the lythoshi-rescaling commits.
 */
export const CHAIN_RETURNS_LEGACY_WEI = true;

/**
 * Coerce a chain-returned bigint magnitude into wallet-internal
 * lythoshi-magnitude. When the chain is in lythoshi-native mode the
 * input is returned unchanged.
 */
export function chainAmountToLythoshi(chainAmount: bigint): bigint {
  if (!CHAIN_RETURNS_LEGACY_WEI) return chainAmount;
  if (chainAmount <= 0n) return 0n;
  return chainAmount / WEI_PER_LYTHOSHI;
}

/**
 * Coerce a chain-returned `0x`-hex balance into wallet-internal lythoshi
 * `0x`-hex. Defensive: malformed input is returned unchanged so the
 * caller's existing parse failure mode is preserved.
 */
export function legacyChainBalanceHexToLythoshiHex(chainHex: string): string {
  if (!CHAIN_RETURNS_LEGACY_WEI) return chainHex;
  if (!/^0x[0-9a-fA-F]+$/.test(chainHex)) return chainHex;
  let chainAmount: bigint;
  try {
    chainAmount = BigInt(chainHex);
  } catch {
    return chainHex;
  }
  const lythoshi = chainAmountToLythoshi(chainAmount);
  return "0x" + lythoshi.toString(16);
}
