import { describe, expect, it } from "vitest";
import { getRpcEndpoints } from "@monolythium/core-sdk";

import { buildExtensionCsp, applyHardenedCsp, LOOPBACK_SOURCES } from "./csp.js";

/** The `connect-src` source expressions of a CSP string. */
function connectTokens(csp: string): string[] {
  return (csp.split("connect-src ")[1] ?? "")
    .split(";")[0]!
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

describe("buildExtensionCsp — strict prod connect-src (P6-001 drift guard)", () => {
  const endpoints = getRpcEndpoints("testnet-69420");
  const csp = buildExtensionCsp(endpoints);

  it("re-states the MV3 script/object defaults, then connect-src", () => {
    expect(
      csp.startsWith("script-src 'self'; object-src 'self'; connect-src "),
    ).toBe(true);
  });

  it("includes 'self' + the two static runtime hosts", () => {
    expect(csp).toContain("'self'");
    expect(csp).toContain("https://registry.npmjs.org");
    expect(csp).toContain("https://raw.githubusercontent.com");
  });

  it("includes EVERY fleet endpoint as both an RPC and its derived WS origin", () => {
    expect(endpoints.length).toBeGreaterThanOrEqual(1);
    for (const ep of endpoints) {
      const u = new URL(ep.url);
      expect(csp).toContain(u.origin);
      const wsPort = u.port === "8545" ? "8546" : u.port;
      const wsOrigin = ep.ws_url
        ? new URL(ep.ws_url).origin
        : `${u.protocol === "https:" ? "wss:" : "ws:"}//${u.hostname}${wsPort ? `:${wsPort}` : ""}`;
      expect(csp).toContain(wsOrigin);
    }
  });

  it("ships only encrypted RPC and WebSocket origins for the live SDK defaults", () => {
    expect(endpoints).toEqual([
      expect.objectContaining({
        url: "https://rpc.monolythium.com",
        ws_url: "wss://rpc.monolythium.com/ws",
      }),
    ]);
    // Was: no `http://` or `ws://` anywhere in connect-src. The directive now
    // carries loopback plaintext by design (a local node serves no TLS), so the
    // assertion narrows to what it was always about — no plaintext origin
    // reachable OFF this machine. Strictly stronger than a substring ban:
    // every plaintext token must be an approved loopback source.
    for (const token of connectTokens(csp)) {
      if (!/^(http|ws):\/\//.test(token)) continue;
      expect(LOOPBACK_SOURCES).toContain(token);
    }
  });

  it("permits the approved loopback sources, and only those", () => {
    for (const source of LOOPBACK_SOURCES) expect(csp).toContain(source);
    // No TLS form: a node on this machine does not serve https/wss, so those
    // were not approved and must not appear.
    expect(csp).not.toContain("https://localhost");
    expect(csp).not.toContain("wss://localhost");
    expect(csp).not.toContain("https://127.0.0.1");
  });

  it("contains no wildcard HOST and no bare scheme-source (containment intact)", () => {
    const connect = csp.split("connect-src ")[1] ?? "";
    // Was: no "*" at all. The approved loopback sources carry a PORT wildcard
    // (a node runs where its owner puts it), so the ban narrows to a wildcard
    // HOST — `http://*` / `http://*:8545` — which is the form that would match
    // arbitrary hosts and void the containment. A port wildcard on a fixed
    // loopback host matches nothing off this machine.
    expect(connect).not.toMatch(/(^|\s)[a-z]+:\/\/\*/);
    for (const token of connectTokens(csp)) {
      if (!token.includes("*")) continue;
      expect(LOOPBACK_SOURCES).toContain(token);
    }
    expect(connect).not.toMatch(/(^|\s)https?:(\s|$)/);
    expect(connect).not.toMatch(/(^|\s)wss?:(\s|$)/);
  });
});

describe("buildExtensionCsp — ws derivation mirrors deriveWsUrl", () => {
  it("http://host:8545 → ws://host:8546 (no ws_url)", () => {
    const csp = buildExtensionCsp([{ url: "http://203.0.113.5:8545" }]);
    expect(csp).toContain("http://203.0.113.5:8545");
    expect(csp).toContain("ws://203.0.113.5:8546");
  });

  it("https://host:8545 → wss://host:8546 (O1 forward-compat)", () => {
    const csp = buildExtensionCsp([{ url: "https://rpc.example.com:8545" }]);
    expect(csp).toContain("https://rpc.example.com:8545");
    expect(csp).toContain("wss://rpc.example.com:8546");
  });

  it("honors an explicit ws_url", () => {
    const csp = buildExtensionCsp([
      { url: "http://h.example.com:8545", ws_url: "ws://h.example.com:9000/ws" },
    ]);
    expect(csp).toContain("ws://h.example.com:9000");
  });
});

describe("applyHardenedCsp — prod injects, dev leaves CSP unset", () => {
  const bareManifest = JSON.stringify({ manifest_version: 3, name: "x" });
  const endpoints = getRpcEndpoints("testnet-69420");

  it("PRODUCTION → sets content_security_policy.extension_pages", () => {
    const out = applyHardenedCsp(bareManifest, endpoints, true);
    const m = JSON.parse(out) as {
      content_security_policy?: { extension_pages?: string };
    };
    expect(m.content_security_policy?.extension_pages).toContain(
      "connect-src 'self'",
    );
    expect(m.content_security_policy?.extension_pages).toContain(
      "https://registry.npmjs.org",
    );
  });

  it("DEV → returns the manifest unchanged (no CSP)", () => {
    const out = applyHardenedCsp(bareManifest, endpoints, false);
    expect(out).toBe(bareManifest);
    expect(JSON.parse(out).content_security_policy).toBeUndefined();
  });
});
