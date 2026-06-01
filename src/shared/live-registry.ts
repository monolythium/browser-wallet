// Live chain-registry fetcher.
//
// The wallet ships a build-time `SPRINTNET_GENESIS_HASH` pin used by
// `networks.ts` for the GAP #11 orphan-fork defense — that stays
// compile-time-anchored because it's a security decision (an operator
// returning a different block-0 hash is treated as untrusted and
// skipped). What we DO want dynamic is the *displayed* registry
// genesis: instead of showing the SDK-bundled snapshot of
// `TESTNET_69420.genesis_hash` (which lags every SDK rebuild), the
// About page can fetch the latest TOML from
// https://raw.githubusercontent.com/monolythium/chain-registry/master/chains/
// and surface that as the canonical "what the registry says today" value.
//
// Cache TTL is short on purpose — testnet regenesises in batches; a
// 5-minute window catches a fresh push without hammering the GitHub
// raw URL.

import {
  fetchChainInfoLatest,
  type ChainInfo,
} from "@monolythium/core-sdk";

const TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  fetchedAt: number;
  info: ChainInfo;
}

let cache: CacheEntry | null = null;
let inFlight: Promise<ChainInfo | null> | null = null;

/**
 * Returns the live `ChainInfo` for testnet-69420 from the public
 * GitHub chain-registry. Caches the result for 5 minutes. Returns
 * `null` if the network call fails — callers fall back to the
 * SDK-bundled value.
 */
export async function fetchLiveTestnetRegistry(): Promise<ChainInfo | null> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < TTL_MS) {
    return cache.info;
  }
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const info = await fetchChainInfoLatest("testnet-69420");
      cache = { fetchedAt: Date.now(), info };
      return info;
    } catch {
      return null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
