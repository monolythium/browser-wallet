// Address-format helpers shared between the SW (chain-side RPC) and
// the popup (rendering). The single canonical conversion we ship today:
//
//   userAddressForNativeRpc(addr) — accepts wallet-internal 0x hex
//   addresses and converts them to the bech32m form
//   (`mono1...`) the chain validates on parameters of every
//   wallet-keyed lyth_* read (verified 2026-05-27 against operator
//   probe: `lyth_pendingRewards("0x...") -> {error: -32602 wallet
//   must be mono bech32m}`).
//
// The chain accepts only the bech32m form on params like:
//   - lyth_pendingRewards(wallet, block?)
//   - lyth_redemptionQueue(wallet, block?)
//   - lyth_getDelegations(wallet, block?)
//   - lyth_getDelegationHistory(wallet, limit?, cursor?)
//   - lyth_getTransactionCount(address)
//
// The conversion is one-way (0x -> bech32m) and idempotent for
// already-bech32m input. Callers passing already-bech32m inputs
// (e.g. UI surfaces that resolved a name registry hit) pass through
// unchanged.

import { addressToTypedBech32 } from "@monolythium/core-sdk";

/** Convert a wallet's account address (typically 0x hex from the
 *  popup's account list) to the typed bech32m form chain validates
 *  for wallet-keyed RPC reads. Passes through any input that is not
 *  prefixed with `0x` / `0X` — already-bech32m strings stay verbatim. */
export function userAddressForNativeRpc(address: string): string {
  return address.startsWith("0x") || address.startsWith("0X")
    ? addressToTypedBech32("user", address)
    : address;
}
