import { getRpcEndpoints } from "@monolythium/core-sdk";

/**
 * First-paint RPC used before the service worker returns the chain list.
 * Keep this SDK-derived so the popup can never briefly dial a pre-regenesis
 * operator while the canonical registry is already on the new network.
 */
export const TESTNET_FALLBACK_RPC =
  getRpcEndpoints("testnet-69420")[0]?.url ?? "https://rpc.monolythium.com";
