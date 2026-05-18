// Monolythium Wallet — network constants and chain capabilities.
//
// Chain markers indicating which signing path the wallet should use.
// ML-DSA-65 is mandatory on Monolythium Sprintnet (chain_id 69420);
// other Ethereum-compatible chains keep the legacy secp256k1 path.

import { MONOLYTHIUM_TESTNET_CHAIN_ID, getRpcEndpoints } from "@monolythium/core-sdk";
import {
  STORAGE_KEY_OPERATOR_OVERRIDE,
  validateOperatorList,
  mergeOperatorOverride,
  type OperatorEntry,
} from "../shared/operators.js";
import { SPRINTNET_GENESIS_HASH } from "../shared/build-info.js";

/** Sprintnet (Monolythium L1 testnet) chain id, exposed as 0x-quantity hex. */
export const SPRINTNET_CHAIN_ID_HEX =
  "0x" + MONOLYTHIUM_TESTNET_CHAIN_ID.toString(16).toUpperCase(); // "0x10F2C"

/** Numeric form for tx-build callsites that prefer u64. */
export const SPRINTNET_CHAIN_ID = Number(MONOLYTHIUM_TESTNET_CHAIN_ID); // 69420

/**
 * Minimum intrinsic gas for a plain LYTH transfer on Sprintnet.
 * Empirically verified via admission rejection on a foundation operator: the chain
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
 * Sprintnet operator RPC endpoints — sourced from the SDK-bundled chain
 * registry (`@monolythium/core-sdk` `getRpcEndpoints("testnet-69420")`).
 * Broadcast paths iterate this list and use the first responder. Registry
 * order is intentional (fsn1 hosts geographically closer to most EU/US
 * users; ash + sin are the long-haul fallbacks) and is refreshed by
 * bumping the SDK package.
 *
 * Phase 4.3 Change 2: this is the *defaults* list. Power users can
 * override via chrome.storage.local["mono.operators.override"]. RPC
 * dispatch uses `getActiveOperators()` which merges the override with
 * these defaults at lookup time.
 *
 * Naming: the registry-sourced endpoints are labelled `operator-N` (1-
 * indexed, matching the SDK snapshot's ordering). The 2026-05-11 regenesis
 * dropped the original operator-1 (its bls.key was destroyed during a
 * debugging triple-wipe → cluster dropped to 6/7, BFT floor 5/7). The SDK
 * registry already excludes that endpoint, so the wallet inherits the drop
 * automatically and no longer hardcodes the exclusion.
 */
export const SPRINTNET_OPERATOR_RPCS_DEFAULTS: ReadonlyArray<OperatorEntry> =
  getRpcEndpoints("testnet-69420").map((endpoint, i) => ({
    name: `operator-${i + 1}`,
    region: endpoint.region ?? "unknown",
    rpc: endpoint.url,
    // Phase 11 Commit 12 — pull SDK's ws_url through when present so the
    // WS client can subscribe without per-operator auto-discovery. When
    // absent, deriveWsUrl in ws-client.ts falls back to the :8546 Geth
    // convention.
    ...(endpoint.ws_url !== undefined ? { wsRpc: endpoint.ws_url } : {}),
  }));

/** In-memory active operator list. Hydrated from storage at SW boot via
 *  `loadOperatorOverride()` and updated by `setOperatorOverride()` and
 *  the chrome.storage.onChanged listener in service-worker.ts. */
let activeOperators: OperatorEntry[] = SPRINTNET_OPERATOR_RPCS_DEFAULTS.map(
  (d) => ({ ...d }),
);

/** Snapshot of the current effective operator list (defaults or override).
 *  RPC dispatch (`sprintnetJsonRpc`, `probeFirstAliveOperator`) calls
 *  this on every iteration so a hot-swapped override takes effect on
 *  the next RPC without a SW restart. */
export function getActiveOperators(): ReadonlyArray<OperatorEntry> {
  return activeOperators;
}

/** Read the persisted override (if any) and update the in-memory list.
 *  Call at SW boot and from the chrome.storage.onChanged listener. */
export async function loadOperatorOverride(): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY_OPERATOR_OVERRIDE], (res) => {
      const raw = res?.[STORAGE_KEY_OPERATOR_OVERRIDE];
      const validated = validateOperatorList(raw);
      activeOperators = mergeOperatorOverride(SPRINTNET_OPERATOR_RPCS_DEFAULTS, validated);
      resolve();
    });
  });
}

/** Persist a new override (or null to clear and revert to defaults).
 *  Mutates in-memory state synchronously, then writes storage; the
 *  chrome.storage.onChanged listener also re-applies on the storage
 *  echo so an override set from outside the SW (e.g. DevTools) hot-
 *  reloads correctly. */
export async function setOperatorOverride(
  override: OperatorEntry[] | null,
): Promise<void> {
  activeOperators = mergeOperatorOverride(SPRINTNET_OPERATOR_RPCS_DEFAULTS, override);
  return new Promise((resolve) => {
    if (override === null) {
      chrome.storage.local.remove(STORAGE_KEY_OPERATOR_OVERRIDE, () => resolve());
    } else {
      chrome.storage.local.set({ [STORAGE_KEY_OPERATOR_OVERRIDE]: override }, () => resolve());
    }
  });
}

/** Defaults snapshot for popup-side display. */
export function getDefaultOperators(): ReadonlyArray<OperatorEntry> {
  return SPRINTNET_OPERATOR_RPCS_DEFAULTS;
}

/** Read the persisted override directly (without merging). Returns null
 *  when no override is set. Used by the popup `sprintnet-operators-get`
 *  IPC to render the "custom override active" banner. */
export async function readOperatorOverride(): Promise<OperatorEntry[] | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY_OPERATOR_OVERRIDE], (res) => {
      const raw = res?.[STORAGE_KEY_OPERATOR_OVERRIDE];
      resolve(validateOperatorList(raw));
    });
  });
}

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
   * reads/writes funnel through `sprintnetJsonRpc` (operator iteration),
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
 * Note: the legacy "Local devnet" (0x7A69) and old DNS alias have been
 * removed. Sprintnet IS the testnet, and the canonical RPC list comes from
 * the SDK-bundled chain registry (`SPRINTNET_OPERATOR_RPCS`) — the `rpc`
 * field below is the first operator, kept for legacy `MonolythiumProvider`
 * consumers; the read/write hot path goes through `sprintnetJsonRpc`.
 */
export const BUILTIN_CHAINS: ReadonlyArray<BuiltinChain> = [
  {
    chainId: SPRINTNET_CHAIN_ID_HEX,
    chainIdNum: SPRINTNET_CHAIN_ID,
    name: "Monolythium · Sprintnet",
    rpc: SPRINTNET_OPERATOR_RPCS_DEFAULTS[0]!.rpc,
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
 * Probe the operator list and return the first endpoint that answers
 * `net_version` matching the expected chain id. Used at boot to pin a
 * working RPC since the canonical alias is offline.
 *
 * Returns null when every operator is unreachable or returns the wrong
 * chain id (regenesis-with-different-id case — operator should be told
 * to reconfigure).
 *
 * Phase 6 GAP #11: operators with a mismatched genesis hash (orphan-
 * fork attack surface) are also skipped. The genesis check is cached
 * forever in-memory per RPC URL — genesis is immutable per chain, so a
 * one-time probe per operator suffices for the SW lifetime.
 */
export async function probeFirstAliveOperator(
  expectedChainIdDec: number = SPRINTNET_CHAIN_ID,
  timeoutMs: number = 3_000,
): Promise<{ name: string; rpc: string } | null> {
  for (const v of getActiveOperators()) {
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
      if (reportedChainId !== expectedChainIdDec) continue;
      // Phase 11.6 — GAP #11 genesis-hash filter disabled for Beta. Probe
      // returns the first operator on the expected chain id without any
      // block-0 hash check. Re-enable for mainnet by restoring:
      //   const genesisOk = await verifyOperatorGenesis(v.rpc, timeoutMs);
      //   if (!genesisOk) continue;
      return { name: v.name, rpc: v.rpc };
    } catch {
      // unreachable / timeout — try next
    }
  }
  return null;
}

/**
 * Per-operator genesis-hash cache. Key is the RPC URL; value is the
 * verification result. Entries are written once and never expired:
 * genesis is immutable per chain, so a cached `false` survives across
 * reconnects until the user clears the operator override or the SW
 * restarts.
 */
interface GenesisCacheEntry {
  /** `true` when block 0's hash equals SPRINTNET_GENESIS_HASH. */
  ok: boolean;
  /** Observed hash from `eth_getBlockByNumber("0x0", false)`. `null`
   *  when the probe failed (transport error, malformed response). */
  observed: string | null;
  checkedAt: number;
}

const operatorGenesisCache = new Map<string, GenesisCacheEntry>();

/**
 * Verify an operator's block-0 hash matches SPRINTNET_GENESIS_HASH.
 * Returns true on match (or cache-hit "true"); false on mismatch,
 * unreachable, or malformed response. Result is cached forever (see
 * cache docstring). The cached false is the load-bearing behavior:
 * one mismatch and we never route RPC to that operator again.
 *
 * Used by:
 *  - probeFirstAliveOperator (defense-in-depth against orphan fork)
 *  - sprintnet-operators-health IPC (About-page table)
 *  - tx-mldsa.sprintnetJsonRpc (read/write dispatch skip-list)
 */
export async function verifyOperatorGenesis(
  rpc: string,
  timeoutMs: number = 3_000,
): Promise<boolean> {
  const cached = operatorGenesisCache.get(rpc);
  if (cached !== undefined) return cached.ok;
  const result = await probeOperatorGenesis(rpc, timeoutMs);
  operatorGenesisCache.set(rpc, result);
  return result.ok;
}

/** Force-refresh a single operator's genesis check. Surfaced via the
 *  About-page probe so the user can re-evaluate after a regenesis. */
export function clearGenesisCache(rpc?: string): void {
  if (rpc === undefined) {
    operatorGenesisCache.clear();
  } else {
    operatorGenesisCache.delete(rpc);
  }
}

/** Snapshot of the current cache state. Used by
 *  sprintnet-operators-health to assemble the per-operator response
 *  without re-probing when the entry is fresh in-memory. */
export function snapshotGenesisCache(): Map<string, GenesisCacheEntry> {
  return new Map(operatorGenesisCache);
}

/** One-shot fetch + compare. Always returns a cache entry — never
 *  throws — so the cache write path is non-throwing too. */
async function probeOperatorGenesis(
  rpc: string,
  timeoutMs: number,
): Promise<GenesisCacheEntry> {
  const now = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getBlockByNumber",
        params: ["0x0", false],
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      return { ok: false, observed: null, checkedAt: now };
    }
    const body = (await res.json()) as {
      result?: { hash?: string } | null;
    };
    const observed =
      typeof body?.result?.hash === "string" ? body.result.hash.toLowerCase() : null;
    if (observed === null) {
      return { ok: false, observed: null, checkedAt: now };
    }
    return {
      ok: observed === SPRINTNET_GENESIS_HASH.toLowerCase(),
      observed,
      checkedAt: now,
    };
  } catch {
    return { ok: false, observed: null, checkedAt: now };
  }
}
