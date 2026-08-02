// Loopback host predicate — the runtime half of the P6-001 re-open.
//
// A user may point the wallet at a node on their OWN MACHINE. Remote hosts were
// asked about and declined, so everything else is refused — see
// _dev-notes/browser-wallet/2026-08-02_loopback-optin-audit-note.md.
//
// THIS MUST MATCH `buildtime/csp.ts` LOOPBACK_SOURCES EXACTLY. A host this
// accepts but the allowlist omits is the worst outcome available: the wallet
// would accept the operator, persist it, dial it, and the browser would block
// the fetch — turning an honest refusal into a silent failure with no error a
// user could act on. `shared/loopback.test.ts` asserts the coupling in both
// directions.
//
// Note what that means for 127.0.0.2: it IS loopback to the operating system,
// and it is still REJECTED here, because it is not in the allowlist. The
// predicate tracks what the browser will permit, not what the RFC calls
// loopback. Widening one without the other is the bug this comment exists to
// prevent.
//
// This is not a security boundary. The allowlist ships to every user regardless
// of the opt-in; this decides only whether the WALLET will dial a host.

/** The exact hosts the allowlist carries. `URL.hostname` returns IPv6 literals
 *  WITH their brackets, which is the form used here and in the CSP source. */
const APPROVED_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

/**
 * True when `url` is one of the approved loopback hosts over the given scheme.
 *
 * Parsed with `URL`, never string-matched: a substring test would accept
 * `http://localhost.evil.com` and `http://evil.com/?rpc=localhost`, and a
 * prefix test would accept the userinfo trick `http://localhost@evil.com`
 * whose real host is the suffix. `URL.hostname` is the authority's host after
 * any credentials, which is the only field that decides where a request goes.
 */
function isApprovedLoopback(url: string, scheme: "http:" | "ws:"): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== scheme) return false;
  return APPROVED_HOSTS.has(parsed.hostname.toLowerCase());
}

/** True when `rpc` is an approved loopback RPC endpoint (`http:` only — a node
 *  on this machine serves no TLS, and no `https:` loopback form is
 *  allowlisted). Any port, any path. */
export function isLoopbackRpc(rpc: string): boolean {
  return isApprovedLoopback(rpc, "http:");
}

/** True when `wsRpc` is an approved loopback WebSocket endpoint (`ws:` only).
 *  The subscription lane is governed by `connect-src` alone — `host_permissions`
 *  does not gate WebSocket — so it needs the same check as the RPC lane. */
export function isLoopbackWs(wsRpc: string): boolean {
  return isApprovedLoopback(wsRpc, "ws:");
}
