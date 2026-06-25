// Hardened-build dial-set filters — the brick-preventers for the strict
// `connect-src` allowlist (P6-001).
//
// COUPLING INVARIANT: in a hardened build the set the service worker DIALS must
// equal the set the allowlist ENUMERATES. The allowlist (src/build/csp.ts) is
// generated from `getRpcEndpoints("testnet-69420")`; the SW dial-set below
// narrows to the same source (the built-in fleet + the built-in chain). Both
// derive from one place, so they cannot diverge.
//
// These are pure helpers so the prod/dev branch is unit-tested and the SW +
// networks wiring stays a one-liner. The build flag lives in build-mode.ts.
import { mergeOperatorOverride, type OperatorEntry } from "./operators.js";

/**
 * The operators the SW will dial.
 *
 * Hardened → ALWAYS the allowlisted defaults. The stored override REPLACES the
 * fleet (`mergeOperatorOverride` returns the override alone, not defaults +
 * override), so honoring it under the strict CSP would point every RPC at a
 * non-allowlisted host and brick the wallet. `loadOperatorOverride` runs at
 * every boot regardless of the runtime DEVELOPER_MODE flag, so the guard must
 * live here, not behind a UI gate.
 *
 * Dev → the stored override (or defaults), exactly as before.
 */
export function hardenedOperators(
  defaults: ReadonlyArray<OperatorEntry>,
  override: OperatorEntry[] | null,
  hardened: boolean,
): OperatorEntry[] {
  return hardened
    ? defaults.map((d) => ({ ...d }))
    : mergeOperatorOverride(defaults, override);
}

/**
 * The chains the SW will dial.
 *
 * Hardened → ONLY the built-in chain(s). Stored custom chains are ignored (not
 * deleted from storage), so nothing is silently CSP-blocked — and because
 * `lookupChain` reads this registry, `loadActiveChainId`'s existing
 * lookup-miss guard automatically reverts the active chain to the built-in
 * default when the stored active chain was a custom one.
 *
 * Dev → built-in + user chains, exactly as before.
 */
export function hardenedChains<T>(
  builtin: Record<string, T>,
  user: Record<string, T>,
  hardened: boolean,
): Record<string, T> {
  return hardened ? { ...builtin } : { ...builtin, ...user };
}
