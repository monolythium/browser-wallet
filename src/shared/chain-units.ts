// Chain-unit compensation for the historical V4-LIVE-0008 wei-on-wire /
// lythoshi-internal regime.
//
// HISTORY: the Sprintnet operator binary that ran in production through
// 2026-05-25 was commit `5aead0f0` (V4-LIVE-0008 live-compat branch off
// `5bf1b55`, 2026-05-18). Per its commit message it carried ONLY the
// strict-catchup repair and intentionally did NOT include the lythoshi-
// rescaling commits that landed on mono-core master after that date
// (`d0f80129`, `03c425f5`, `99175896`, `a2a9e1fc`, `9483d033`, etc.).
// While that binary was live, operators reported `eth_getBalance`
// results, `eth_feeHistory` base fees, and every other numeric field in
// 18-decimal wei, so this module divided every inbound chain magnitude by
// `WEI_PER_LYTHOSHI` to reach the wallet's lythoshi domain.
//
// CURRENT STATE (2026-05-29): operators have upgraded past the lythoshi-
// rescaling commits. The live binary is `dc919df8`, which is
// lythoshi-native: `eth_getBalance`, gas price, and the
// `lyth_executionUnitPrice` quote (whose fields are explicitly named
// `…Lythoshi`) all report 8-decimal lythoshi directly. Live evidence:
// `eth_getBalance` → `0x2540be400` = 10^10 lythoshi = 100 LYTH;
// `eth_gasPrice` → `0x7d0` = 2000 lythoshi. There is therefore no longer
// any wei-vs-lythoshi unit gap to compensate, and `CHAIN_RETURNS_LEGACY_WEI`
// is now `false`.
//
// The wallet's internal numeric domain is 8-decimal lythoshi per
// whitepaper §23.1 (1 LYTH = 10^8 lythoshi; lythoshi is the canonical
// atomic unit). Display helpers (`formatLyth`, `formatNativeLythAmount`)
// assume their input is in lythoshi — which now matches the chain wire
// 1:1.
//
// This module remains the single shared chokepoint between the chain wire
// and wallet-internal representations. With the flag `false` every helper
// below is an identity passthrough; the wei-compensation bodies are
// retained only so the wallet can be re-pointed at a legacy-wei operator
// line by flipping the flag back to `true`, with no other code changes.

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
 * Set `true` while Sprintnet operators ran the legacy V4-LIVE-0008
 * (commit `5aead0f0`) wei-on-wire line. Now `false`: operators have
 * upgraded to the lythoshi-native binary `dc919df8` (2026-05-29), which
 * reports balance, gas price, and `lyth_executionUnitPrice` fields in
 * 8-decimal lythoshi directly, so no inbound transformation is applied.
 */
export const CHAIN_RETURNS_LEGACY_WEI = false;

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
 * Coerce a chain-returned `0x`-hex value into wallet-internal lythoshi
 * `0x`-hex. The body is generic: any wei-magnitude hex (balance, fee
 * field, base price) round-trips through the same division. Defensive:
 * malformed input is returned unchanged so the caller's existing parse
 * failure mode is preserved.
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

/**
 * Wire shape for the `wallet-fee-suggestion` IPC reply at the popup
 * boundary. Mirrors `FeeSuggestion` (`popup/bg.ts`) without importing
 * across the boundary.
 *
 * Magnitude contract: the popup `FeeSuggestion` is documented as
 * lythoshi-per-execution-unit. The SW handler however returns
 * chain-wire wei magnitudes because `wallet-send-tx` /
 * `wallet-multisig-execute` need wei on the wire (V4-LIVE-0008
 * operators expect wei). The popup-side boundary applies this helper
 * to honour the lythoshi contract for display + intra-popup math.
 */
export interface LegacyChainFeeSuggestionFields {
  maxPriorityFeePerGas: string;
  maxFeePerGas: string;
  baseFeePerGas: string;
}

/**
 * Convert the wei-magnitude fee fields returned by the service-worker
 * `wallet-fee-suggestion` IPC into lythoshi-magnitude, matching the
 * popup `FeeSuggestion` documented contract. Pass-through when the
 * chain is in lythoshi-native mode. Non-fee fields (`gasLimit`,
 * `structuredFee`) are preserved unchanged.
 */
export function legacyChainFeeSuggestionWeiToLythoshi<
  T extends LegacyChainFeeSuggestionFields,
>(fee: T): T {
  if (!CHAIN_RETURNS_LEGACY_WEI) return fee;
  return {
    ...fee,
    maxPriorityFeePerGas: legacyChainBalanceHexToLythoshiHex(fee.maxPriorityFeePerGas),
    maxFeePerGas: legacyChainBalanceHexToLythoshiHex(fee.maxFeePerGas),
    baseFeePerGas: legacyChainBalanceHexToLythoshiHex(fee.baseFeePerGas),
  };
}
