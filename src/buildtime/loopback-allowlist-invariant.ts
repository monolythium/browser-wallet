// Loopback allowlist invariant — the bound on the P6-001 re-open.
//
// WHAT WAS RE-OPENED, AND HOW FAR. P6-001 shipped a strict `connect-src`
// allowlist because without one a popup XSS could `fetch` the decrypted seed to
// any host on the internet. That finding was re-opened ONCE and NARROWLY, to let
// a user point the wallet at a node on their own machine. The approval was for
// LOOPBACK. Remote hosts, an `https:` widening and any wildcard were declined —
// see _dev-notes/browser-wallet/2026-08-02_loopback-optin-audit-note.md.
//
// WHY A GUARD AND NOT A COMMENT. The exception is one line in csp.ts. Nothing
// about a text note stops the next person who needs "just one more host" from
// editing it, and the reviewer of that diff would see a plausible one-line
// change with no way to know a scope limit ever existed. This module is what
// makes the limit checkable: the generated directive is asserted, every build.
//
// WHAT IT DOES NOT DO. It bounds the ALLOWLIST. It is not a runtime control and
// it does not make the opt-in a security boundary — the loopback entries ship to
// every user whether or not anyone turns the toggle on. It says only that the
// set of origins the browser will permit stays what was approved.
//
// SCOPE, stated plainly because a half-understood gate is worse than none:
//   - It reads the `connect-src` directive of a GENERATED string, so editing
//     the emitted manifest by hand is outside it (the popup-only invariant
//     covers manifest text; this covers what csp.ts produces).
//   - `permittedNonLoopback` is supplied by the caller. The companion test
//     rebuilds it from the SDK registry and the two static hosts, so a NEW
//     static host in csp.ts fails here until it is acknowledged. That is
//     deliberate: silent growth of the allowlist is the thing being prevented.
//   - It matches source expressions textually. It does not evaluate CSP
//     semantics, and a host that resolves to loopback by other means (a hosts
//     file entry for a non-loopback name) is not visible to it.

/**
 * The only loopback source expressions the re-open approved.
 *
 * Three hosts, because a user types `localhost` while a node may bind only
 * `127.0.0.1` or only `[::1]`; the wallet stores and dials what was entered
 * rather than normalising, so all three must be permitted or a correctly-running
 * node is unreachable for a reason the user cannot diagnose.
 *
 * `http:`/`ws:` only — a local node does not serve TLS, so an `https:` form
 * would be useless here and is not approved. Port wildcards, because a node runs
 * where its owner puts it and pinning a port would buy nothing: anyone able to
 * bind a loopback port can bind the pinned one.
 */
export const APPROVED_LOOPBACK_SOURCES: readonly string[] = Object.freeze([
  "http://localhost:*",
  "http://127.0.0.1:*",
  "http://[::1]:*",
  "ws://localhost:*",
  "ws://127.0.0.1:*",
  "ws://[::1]:*",
]);

/** A `connect-src` source expression that is not permitted, and why. */
export interface AllowlistViolation {
  /** The offending source expression, verbatim. */
  token: string;
  /** Why it is not permitted. */
  reason: string;
}

/** A bare scheme source: `https:`, `http:`, `ws:`, `data:` … */
const SCHEME_SOURCE = /^[a-zA-Z][a-zA-Z0-9+.-]*:$/;

/** The loopback hosts, for telling a non-loopback `http:` apart from a
 *  near-miss on the frozen set. */
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"] as const;

function looksLoopback(token: string): boolean {
  const afterScheme = token.replace(/^[a-z]+:\/\//i, "");
  return LOOPBACK_HOSTS.some(
    (h) => afterScheme === h || afterScheme.startsWith(`${h}:`),
  );
}

/** The `connect-src` source expressions of a CSP string, or [] when absent. */
function connectSrcTokens(csp: string): string[] {
  const directive = csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.toLowerCase().startsWith("connect-src"));
  if (directive === undefined) return [];
  return directive
    .split(/\s+/)
    .slice(1)
    .filter((t) => t.length > 0);
}

/**
 * Every `connect-src` source expression that is neither a permitted
 * non-loopback origin nor an exact member of {@link APPROVED_LOOPBACK_SOURCES}.
 *
 * `'self'` is always permitted. Everything else must match exactly — a
 * near-miss like `http://localhost` (no port wildcard) is reported, because the
 * frozen set is the record of what was approved and "close enough" is how a
 * scope limit erodes.
 */
export function findAllowlistViolations(
  csp: string,
  permittedNonLoopback: readonly string[],
): AllowlistViolation[] {
  const permitted = new Set(permittedNonLoopback);
  const approved = new Set(APPROVED_LOOPBACK_SOURCES);
  const violations: AllowlistViolation[] = [];

  for (const token of connectSrcTokens(csp)) {
    if (token === "'self'") continue;
    if (approved.has(token)) continue;
    if (permitted.has(token)) continue;

    if (SCHEME_SOURCE.test(token)) {
      violations.push({
        token,
        reason:
          "bare scheme source — matches any host, which is the containment P6-001 exists to provide",
      });
      continue;
    }
    if (token.includes("*") && !approved.has(token)) {
      violations.push({
        token,
        reason:
          "wildcard host — only the approved loopback port wildcards may contain '*'",
      });
      continue;
    }
    if (looksLoopback(token)) {
      violations.push({
        token,
        reason: `loopback host but not an exact member of the approved set (${APPROVED_LOOPBACK_SOURCES.join(", ")})`,
      });
      continue;
    }
    if (/^(http|ws):\/\//i.test(token)) {
      violations.push({
        token,
        reason:
          "non-loopback http/ws origin — the re-open approved loopback only; remote hosts were declined",
      });
      continue;
    }
    violations.push({
      token,
      reason: "not a permitted origin and not an approved loopback source",
    });
  }
  return violations;
}

/**
 * Throw unless the directive contains only permitted origins and approved
 * loopback sources. The message names every offending token and why, so a
 * failure is actionable without opening the audit note.
 */
export function assertLoopbackAllowlist(
  csp: string,
  permittedNonLoopback: readonly string[],
): void {
  const found = findAllowlistViolations(csp, permittedNonLoopback);
  if (found.length === 0) return;
  throw new Error(
    `Loopback allowlist invariant violated in ${found.length} place(s).\n` +
      `The P6-001 re-open approved LOOPBACK ONLY — no remote host, no https widening, no wildcard.\n` +
      found.map((v) => `  connect-src "${v.token}" — ${v.reason}`).join("\n"),
  );
}
