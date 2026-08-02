// Hardened-build dial-set filters — the brick-preventers for the strict
// `connect-src` allowlist (P6-001).
//
// COUPLING INVARIANT: in a hardened build the set the service worker DIALS must
// equal the set the allowlist ENUMERATES. The allowlist (src/buildtime/csp.ts) is
// generated from `getRpcEndpoints("testnet-69420")`; the SW dial-set below
// narrows to the same source (the built-in fleet + the built-in chain). Both
// derive from one place, so they cannot diverge.
//
// These are pure helpers so the prod/dev branch is unit-tested and the SW +
// networks wiring stays a one-liner. The build flag lives in build-mode.ts.
import { isLoopbackRpc, isLoopbackWs } from "./loopback.js";
import { mergeOperatorOverride, type OperatorEntry } from "./operators.js";

/** Origin of a URL string, or null if it doesn't parse. */
function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * The WS origin a default endpoint maps to — mirrors csp.ts `wsOrigin` and
 * ws-client `deriveWsUrl`: an explicit `wsRpc` wins; else port 8545 → 8546 and
 * scheme http → ws / https → wss. Used to bound a hardened override's optional
 * explicit `wsRpc` to the same allowlist the strict `connect-src` enumerates.
 */
function endpointWsOrigin(e: OperatorEntry): string | null {
  try {
    if (e.wsRpc !== undefined && e.wsRpc.length > 0) return new URL(e.wsRpc).origin;
    const u = new URL(e.rpc);
    const proto = u.protocol === "https:" ? "wss:" : "ws:";
    const port = u.port === "8545" ? "8546" : u.port;
    return `${proto}//${u.hostname}${port ? `:${port}` : ""}`;
  } catch {
    return null;
  }
}

/**
 * True when EVERY entry of `override` stays within the built-in fleet's
 * allowlisted origins — i.e. the override only REORDERS / PINS / SUBSETS the
 * defaults (matched by `rpc` origin, and by the explicit `wsRpc` origin when
 * present). Such an override dials only hosts the strict `connect-src` already
 * permits (csp.ts derives that allowlist from the SAME defaults), so it can
 * never be CSP-blocked. An entry pointing at ANY host outside the fleet makes
 * this false — honoring it would brick RPC under the CSP.
 */
export function overrideWithinFleet(
  defaults: ReadonlyArray<OperatorEntry>,
  override: OperatorEntry[],
): boolean {
  const allowedHttp = new Set(
    defaults.map((d) => safeOrigin(d.rpc)).filter((o): o is string => o !== null),
  );
  const allowedWs = new Set(
    defaults.map((d) => endpointWsOrigin(d)).filter((o): o is string => o !== null),
  );
  return override.every((o) => {
    const http = safeOrigin(o.rpc);
    if (http === null || !allowedHttp.has(http)) return false;
    // Only an EXPLICIT wsRpc can escape the fleet; a derived ws (no wsRpc) shares
    // the rpc host we just cleared, so it's implicitly allowlisted.
    if (o.wsRpc !== undefined) {
      const ws = safeOrigin(o.wsRpc);
      if (ws === null || !allowedWs.has(ws)) return false;
    }
    return true;
  });
}

/**
 * Whether a stored override may be DIALLED by a hardened build.
 *
 * Every entry must be either within the built-in fleet (a reorder / pin /
 * subset — already allowlisted) or, when the user has turned the loopback
 * opt-in on, an approved loopback address on this machine.
 *
 * `loopbackAllowed` reflects the user's opt-in, and it is NOT a security
 * boundary: the loopback `connect-src` entries ship to every user regardless.
 * What it decides is whether the WALLET will dial such a host — which is what
 * makes pointing the wallet somewhere new a deliberate act rather than one
 * pasted URL. Remote hosts are refused whatever it says: the P6-001 re-open
 * was for loopback and remote hosts were declined.
 *
 * An explicit `wsRpc` is checked too, or a loopback `rpc` would be a hole
 * through which a remote subscription endpoint could be smuggled.
 */
export function overrideDialable(
  defaults: ReadonlyArray<OperatorEntry>,
  override: OperatorEntry[],
  loopbackAllowed: boolean,
): boolean {
  return override.every((entry) => {
    if (overrideWithinFleet(defaults, [entry])) return true;
    if (!loopbackAllowed) return false;
    if (!isLoopbackRpc(entry.rpc)) return false;
    if (entry.wsRpc !== undefined && !isLoopbackWs(entry.wsRpc)) return false;
    return true;
  });
}

/**
 * The operators the SW will dial.
 *
 * Hardened → the stored override IS honored WHEN it stays within the built-in
 * fleet (reorder / pin / subset the allowlisted defaults — every host is
 * already in the strict `connect-src`, so it can't be CSP-blocked). This is
 * what the Operators "Use this operator" / Save flow needs to route around a
 * degraded default operator, and was previously dropped wholesale. An override
 * that carries ANY non-fleet host is rejected in full → fall back to the
 * allowlisted defaults (the original brick-prevention, now scoped to only the
 * genuinely-unsafe case, since such a host would be CSP-blocked → bricked).
 * `loadOperatorOverride` runs at every boot regardless of DEVELOPER_MODE, so
 * the guard must live here, not behind a UI gate.
 *
 * Dev → the stored override (or defaults), exactly as before.
 */
export function hardenedOperators(
  defaults: ReadonlyArray<OperatorEntry>,
  override: OperatorEntry[] | null,
  hardened: boolean,
  /** The user's loopback opt-in. Defaults to FALSE so any caller that has not
   *  been taught about it fails closed — a stored loopback override is not
   *  dialled unless the opt-in is explicitly threaded through. */
  loopbackAllowed = false,
): OperatorEntry[] {
  if (!hardened) return mergeOperatorOverride(defaults, override);
  if (override === null || override.length === 0) {
    return defaults.map((d) => ({ ...d }));
  }
  return overrideDialable(defaults, override, loopbackAllowed)
    ? override.map((o) => ({ ...o }))
    : defaults.map((d) => ({ ...d }));
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
