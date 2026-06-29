import { describe, expect, it } from "vitest";
import { getRpcEndpoints } from "@monolythium/core-sdk";

import { buildExtensionCsp, applyHardenedCsp } from "./csp.js";

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

  it("includes EVERY fleet endpoint as both an http RPC and a ws origin", () => {
    expect(endpoints.length).toBeGreaterThanOrEqual(1);
    for (const ep of endpoints) {
      const u = new URL(ep.url);
      expect(csp).toContain(u.origin); // http://<ip>:8545
      const host = escapeRegExp(u.hostname);
      expect(csp).toMatch(new RegExp(`wss?://${host}:`)); // ws://<ip>:8546
    }
  });

  it("contains NO wildcard and no bare scheme-source (containment intact)", () => {
    const connect = csp.split("connect-src ")[1] ?? "";
    expect(connect).not.toContain("*");
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
