// Monolythium Wallet — network constants and chain capabilities.
//
// Chain markers indicating which signing path the wallet should use.
// ML-DSA-65 is mandatory on Monolythium Sprintnet (chain_id 69420);
// other Ethereum-compatible chains keep the legacy secp256k1 path.

import { MONOLYTHIUM_TESTNET_CHAIN_ID } from "@monolythium/core-sdk";

/** Sprintnet (Monolythium L1 testnet) chain id, exposed as 0x-quantity hex. */
export const SPRINTNET_CHAIN_ID_HEX =
  "0x" + MONOLYTHIUM_TESTNET_CHAIN_ID.toString(16).toUpperCase(); // "0x10F2C"

/** Numeric form for tx-build callsites that prefer u64. */
export const SPRINTNET_CHAIN_ID = Number(MONOLYTHIUM_TESTNET_CHAIN_ID); // 69420

/**
 * Minimum intrinsic gas for a plain LYTH transfer on Sprintnet.
 * Empirically verified via admission rejection at val-1: the chain
 * enforces a floor of 24309 (presumably ML-DSA-65 verify + envelope
 * decrypt + state proof overhead). 30000 = 0x7530 leaves headroom.
 * If the floor moves above this, the wallet needs a bump.
 *
 * Note: `eth_estimateGas` is NOT trustworthy for Sprintnet — it returns
 * the EVM execution gas only (~21000) and ignores the mempool intrinsic
 * floor. The Sprintnet code paths must hardcode this constant instead
 * of estimating.
 */
export const SPRINTNET_TRANSFER_GAS_LIMIT_HEX = "0x7530"; // 30000

/**
 * Sprintnet validator RPC endpoints — published by Nayiem 2026-04-29.
 * The hardcoded `node-tnt.monolythium.xyz` alias resolves to NXDOMAIN as
 * of audit; broadcast paths must iterate this list and use the first
 * responder. Order is intentional — fsn1 hosts are geographically closer
 * to most EU/US users; ash + sin are the long-haul fallbacks.
 */
export const SPRINTNET_VALIDATOR_RPCS: ReadonlyArray<{
  name: string;
  region: string;
  rpc: string;
}> = [
  { name: "val-1", region: "fsn1", rpc: "http://192.0.2.7:8545" },
  { name: "val-2", region: "fsn1", rpc: "http://192.0.2.1:8545" },
  { name: "val-3", region: "nbg1", rpc: "http://192.0.2.2:8545" },
  { name: "val-4", region: "hel1", rpc: "http://192.0.2.3:8545" },
  { name: "val-5", region: "hel1", rpc: "http://192.0.2.4:8545" },
  { name: "val-6", region: "ash",  rpc: "http://192.0.2.5:8545" },
  { name: "val-7", region: "sin",  rpc: "http://192.0.2.6:8545" },
];

/**
 * Built-in chain registry entry. The chain-list IPC merges these with
 * user-added chains from chrome.storage; the popup's Networks screen
 * splits them into "Official" and "Custom" sections per `official`.
 *
 * Shape is a superset of what `service-worker.ts:NetInfo` carries — the
 * extra `official` field surfaces on the chain-list IPC reply so the
 * popup can render the badge without a second lookup.
 */
export interface BuiltinChain {
  chainId: string;
  chainIdNum: number;
  name: string;
  /** Single RPC URL for legacy `MonolythiumProvider` consumers. Sprintnet
   * reads/writes funnel through `sprintnetJsonRpc` (validator iteration),
   * not through this URL — it's here only to satisfy callers that still
   * ask for one. */
  rpc: string;
  blockExplorer?: string;
  nativeCurrency?: { name: string; symbol: string; decimals: number };
  /** True for Foundation-attested official chains (Sprintnet today). */
  official: boolean;
}

/**
 * Built-in chains shipped with the wallet. v4.0 ships exactly one —
 * Sprintnet (chain_id 69420). All other chains are user-added at
 * runtime via `wallet_addEthereumChain`.
 *
 * Note: the legacy "Local devnet" (0x7A69) and "LythiumDAG-BFT Testnet"
 * with the NXDOMAIN `node-tnt.monolythium.xyz` alias have been removed.
 * Sprintnet IS the testnet, and the canonical RPC is the validator
 * fallback list (`SPRINTNET_VALIDATOR_RPCS`) — the `rpc` field below
 * is the first validator, kept for legacy `MonolythiumProvider`
 * consumers; the read/write hot path goes through `sprintnetJsonRpc`.
 */
export const BUILTIN_CHAINS: ReadonlyArray<BuiltinChain> = [
  {
    chainId: SPRINTNET_CHAIN_ID_HEX,
    chainIdNum: SPRINTNET_CHAIN_ID,
    name: "Monolythium · Sprintnet",
    rpc: SPRINTNET_VALIDATOR_RPCS[0]!.rpc,
    nativeCurrency: { name: "Monolythium LYTH", symbol: "LYTH", decimals: 18 },
    official: true,
  },
];

/**
 * Returns true when the chain id requires the ML-DSA-65 native envelope.
 * Sprintnet refuses RLP+secp256k1 raw txs at the decoder layer per Law §2.1.
 *
 * Today this is "is it Sprintnet"; once mainnet is live this expands to
 * "any Monolythium-protocol chain id" — keep this predicate single-source
 * so the routing in service-worker.ts touches one constant.
 */
export function chainRequiresMlDsa(chainIdHex: string): boolean {
  return chainIdHex.toUpperCase() === SPRINTNET_CHAIN_ID_HEX.toUpperCase();
}

/**
 * Probe the validator list and return the first endpoint that answers
 * `net_version` matching the expected chain id. Used at boot to pin a
 * working RPC since the canonical alias is offline.
 *
 * Returns null when every validator is unreachable or returns the wrong
 * chain id (regenesis-with-different-id case — operator should be told
 * to reconfigure).
 */
export async function probeFirstAliveValidator(
  expectedChainIdDec: number = SPRINTNET_CHAIN_ID,
  timeoutMs: number = 3_000,
): Promise<{ name: string; rpc: string } | null> {
  for (const v of SPRINTNET_VALIDATOR_RPCS) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(v.rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "net_version",
          params: [],
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const body = (await res.json()) as { result?: string };
      const reportedChainId = Number(body?.result ?? 0);
      if (reportedChainId === expectedChainIdDec) {
        return { name: v.name, rpc: v.rpc };
      }
    } catch {
      // unreachable / timeout — try next
    }
  }
  return null;
}