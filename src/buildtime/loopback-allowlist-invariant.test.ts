// The static assertion that bounds the P6-001 loopback exception.
//
// P6-001 shipped a strict `connect-src` allowlist so that a popup XSS could not
// exfiltrate the seed to an arbitrary host. That finding was re-opened, once and
// narrowly, to permit a node on the user's OWN MACHINE — approval was for
// loopback and explicitly NOT for remote hosts.
//
// Nothing in a text warning stops the next edit from adding "just one more
// host". This is what does: the generated directive is asserted to contain no
// non-loopback `http:`/`ws:` origin, no scheme source and no wildcard host, and
// every loopback entry must be an exact member of a frozen set.
//
// The analyser is pinned against synthetic sources FIRST — including the three
// widenings it exists to reject — so it is known to FAIL when it should, rather
// than merely observed passing against today's tree.

import { describe, expect, it } from "vitest";

import { getRpcEndpoints } from "@monolythium/core-sdk";

import { buildExtensionCsp } from "./csp";
import {
  APPROVED_LOOPBACK_SOURCES,
  assertLoopbackAllowlist,
  findAllowlistViolations,
} from "./loopback-allowlist-invariant";

/** The non-loopback origins the wallet legitimately reaches, rebuilt here from
 *  the real sources. A new static host added to csp.ts without a matching change
 *  here trips the guard — which is the bounding property, not a nuisance. */
function permitted(): string[] {
  const registry = getRpcEndpoints("testnet-69420").flatMap((e) => [
    new URL(e.url).origin,
    new URL(e.ws_url ?? e.url).origin,
  ]);
  return [...registry, "https://registry.npmjs.org", "https://raw.githubusercontent.com"];
}

describe("APPROVED_LOOPBACK_SOURCES — the frozen set", () => {
  it("is exactly the six approved forms: http + ws, three loopback hosts, any port", () => {
    expect([...APPROVED_LOOPBACK_SOURCES].sort()).toEqual(
      [
        "http://127.0.0.1:*",
        "http://[::1]:*",
        "http://localhost:*",
        "ws://127.0.0.1:*",
        "ws://[::1]:*",
        "ws://localhost:*",
      ].sort(),
    );
  });

  it("contains no https/wss form — a local node does not serve TLS", () => {
    for (const s of APPROVED_LOOPBACK_SOURCES) {
      expect(s.startsWith("https:")).toBe(false);
      expect(s.startsWith("wss:")).toBe(false);
    }
  });
});

describe("findAllowlistViolations — what the analyser rejects", () => {
  const base = "script-src 'self'; object-src 'self'; connect-src 'self' ";

  it("accepts the permitted origins plus the approved loopback set", () => {
    const csp = base + [...permitted(), ...APPROVED_LOOPBACK_SOURCES].join(" ");
    expect(findAllowlistViolations(csp, permitted())).toEqual([]);
  });

  // MUTATION 1 — the one the approval explicitly declined.
  it("REJECTS a non-loopback http origin, naming the token", () => {
    const csp = base + permitted().join(" ") + " http://10.0.0.5:8545";
    const found = findAllowlistViolations(csp, permitted());
    expect(found).toHaveLength(1);
    expect(found[0]!.token).toBe("http://10.0.0.5:8545");
    expect(found[0]!.reason).toMatch(/loopback/i);
  });

  // MUTATION 2 — the widening the feasibility pass costed and refused.
  it("REJECTS a bare scheme source", () => {
    const found = findAllowlistViolations(base + "https:", permitted());
    expect(found).toHaveLength(1);
    expect(found[0]!.reason).toMatch(/scheme source/i);
  });

  // MUTATION 3 — a near-miss on the frozen set.
  it("REJECTS a loopback host without the port wildcard", () => {
    const found = findAllowlistViolations(base + "http://localhost", permitted());
    expect(found).toHaveLength(1);
    expect(found[0]!.reason).toMatch(/exact/i);
  });

  it("REJECTS a wildcard host", () => {
    const found = findAllowlistViolations(base + "http://*:8545", permitted());
    expect(found).toHaveLength(1);
    expect(found[0]!.reason).toMatch(/wildcard/i);
  });

  it("REJECTS a remote host that merely looks loopback", () => {
    const found = findAllowlistViolations(
      base + "http://localhost.evil.com:8545",
      permitted(),
    );
    expect(found).toHaveLength(1);
  });

  it("REJECTS an unlisted https origin", () => {
    const found = findAllowlistViolations(base + "https://evil.example", permitted());
    expect(found).toHaveLength(1);
  });

  it("ignores directives other than connect-src", () => {
    expect(
      findAllowlistViolations("script-src 'self' http://10.0.0.5", permitted()),
    ).toEqual([]);
  });
});

describe("assertLoopbackAllowlist — how a failure reads", () => {
  it("throws naming the token and the reason", () => {
    const csp =
      "connect-src 'self' " + permitted().join(" ") + " http://10.0.0.5:8545";
    expect(() => assertLoopbackAllowlist(csp, permitted())).toThrow(/10\.0\.0\.5/);
    expect(() => assertLoopbackAllowlist(csp, permitted())).toThrow(/loopback/i);
  });

  it("passes silently on a clean directive", () => {
    const csp = "connect-src 'self' " + permitted().join(" ");
    expect(() => assertLoopbackAllowlist(csp, permitted())).not.toThrow();
  });
});

describe("the real generated directive", () => {
  it("carries no non-loopback http/ws origin, no scheme source, no wildcard", () => {
    const csp = buildExtensionCsp(getRpcEndpoints("testnet-69420"));
    assertLoopbackAllowlist(csp, permitted());
  });

  it("never narrows or drops the load-bearing entries", () => {
    const csp = buildExtensionCsp(getRpcEndpoints("testnet-69420"));
    for (const origin of permitted()) expect(csp).toContain(origin);
    expect(csp).toContain("'self'");
  });
});
