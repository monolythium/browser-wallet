// Display-only presentation for operator list entries.
//
// The chain registry carries no per-endpoint name, so `networks.ts` numbers the
// registry-sourced endpoints `operator-1`, `operator-2`, … That number is a
// list position — an implementation detail of the wallet's own mirroring, not
// something a user can act on. For the endpoint the pinned registry publishes
// as official, the wallet substitutes a descriptive label instead.
//
// The label is deliberately descriptive and NOT an operatorship claim. The
// registry does carry `provider: "monolythium-foundation"`, but the wallet does
// not assert who runs an endpoint — it only states that this host is the RPC
// gateway the pinned registry publishes as official. In a wallet whose posture
// is built on not trusting a single operator's word, that is the ceiling.
//
// Display only: the stored `name`, the operator's identity (dedup keys on
// `rpc`), the dispatch order, and everything persisted are untouched. The
// operator-override form binds its input to the raw stored name and must keep
// doing so, or saving would write this label into the user's override.

import { getRpcEndpoints } from "@monolythium/core-sdk";

/**
 * Label shown for the pinned official gateway when the wallet has no real
 * name for it.
 */
export const PINNED_GATEWAY_LABEL = "Monolythium RPC";

/**
 * Wallet-minted placeholder names. `networks.ts` numbers registry endpoints
 * `operator-N` (1-indexed); a real registry name or a user-chosen name never
 * matches, which is what makes the fallback non-destructive.
 */
const PLACEHOLDER_NAME = /^operator-\d+$/i;

/** Lower-cased host (with port) of a URL, or null when unparseable. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Hosts the pinned SDK registry publishes at `tier: "official"`. Derived from
 * the registry at module load rather than hardcoded, so if a registry bump
 * moves the gateway the label follows it with no wallet edit — and a
 * `community`-tier endpoint is never labelled.
 */
const OFFICIAL_GATEWAY_HOSTS: ReadonlySet<string> = new Set(
  getRpcEndpoints("testnet-69420")
    .filter((endpoint) => endpoint.tier === "official")
    .map((endpoint) => hostOf(endpoint.url))
    .filter((host): host is string => host !== null),
);

/**
 * The name to display for an operator. Returns `name` unchanged unless it is a
 * wallet-minted placeholder AND the endpoint is a pinned official gateway
 * host, in which case the descriptive label is substituted.
 *
 * Both conditions are required, which is what protects a user-added operator:
 * the user names their own entries, so the name is not a placeholder and
 * survives even when they point at the official host.
 */
export function operatorDisplayName(name: string, rpc: string): string {
  const trimmed = name.trim();
  // A real name — registry-supplied or user-chosen — always wins.
  if (trimmed.length > 0 && !PLACEHOLDER_NAME.test(trimmed)) return name;
  const host = hostOf(rpc);
  if (host === null || !OFFICIAL_GATEWAY_HOSTS.has(host)) return name;
  return PINNED_GATEWAY_LABEL;
}
