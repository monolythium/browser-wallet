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

/**
 * Where the opt-in is persisted.
 *
 * `chrome.storage.LOCAL`, under the `mono.` prefix, DELIBERATELY: the wallet
 * wipe is a default-deny prefix scan over that area (`wipeAllLocalWalletState`
 * — "any new `mono.*` family is wiped automatically, no key list to maintain"),
 * so a reset clears this by construction. The session area is cleared by an
 * ENUMERATED list, in two places, and that list was found incomplete as
 * recently as `004b654`; a flag that outlived a wipe would silently re-arm a
 * custom dial for the next owner of the profile.
 */
export const STORAGE_KEY_LOOPBACK_ALLOWED = "mono.loopback-rpc.enabled";

/** The exact hosts the allowlist carries, in the order the refusal message
 *  lists them. `URL.hostname` returns IPv6 literals WITH their brackets, which
 *  is the form used here and in the CSP source. Membership is what decides
 *  acceptance, so the order is presentation only — but keeping ONE list means a
 *  change to the accepted set moves the message with it. */
export const APPROVED_LOOPBACK_HOSTS = [
  "127.0.0.1",
  "[::1]",
  "localhost",
] as const;

/** The schemes the two predicates below accept. */
export const APPROVED_LOOPBACK_SCHEMES = ["http:", "ws:"] as const;

const APPROVED_HOSTS: ReadonlySet<string> = new Set(APPROVED_LOOPBACK_HOSTS);

/** Refusal when the host IS an allowed form but the opt-in is off. The toggle
 *  really is the blocker here, so naming it is the right advice. */
export const REFUSAL_TOGGLE_OFF =
  'This wallet only dials its built-in operators. To use a node on this computer, turn on "Allow a local node" above.';

/**
 * Refusal when the HOST itself is not an allowed form — shown whether the
 * opt-in is on or off, because turning it on would not help.
 *
 * Note what this deliberately does NOT say: it never tells the user their host
 * "isn't local". `127.0.0.2` is genuinely loopback and is still refused, because
 * the allowlist carries only `127.0.0.1` — CSP source expressions cannot express
 * a CIDR block. Listing the accepted forms is what that user actually needs.
 *
 * Built from the lists above rather than typed, so a change to the accepted set
 * cannot leave this message describing the old one. (The `:8545` in the example
 * is illustrative — a conventional RPC port, not a value the predicate reads.)
 */
export const REFUSAL_NOT_LOCAL =
  `Only a node on this computer can be added — not a server on the internet. ` +
  `Use ${APPROVED_LOOPBACK_HOSTS.slice(0, -1).join(", ")} or ${APPROVED_LOOPBACK_HOSTS.at(-1)} ` +
  `with ${APPROVED_LOOPBACK_SCHEMES.map((s) => `${s}//`).join(" or ")} — ` +
  `for example ${APPROVED_LOOPBACK_SCHEMES[0]}//${APPROVED_LOOPBACK_HOSTS[0]}:8545.`;

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
