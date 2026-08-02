// The loopback predicate — the runtime half of the P6-001 re-open.
//
// It must match the connect-src allowlist EXACTLY. A host the predicate accepts
// but the allowlist omits is the worst outcome available here: the wallet would
// accept the operator, persist it, dial it, and the browser would block the
// fetch — relocating an honest refusal into a silent failure. The coupling test
// at the bottom is what holds them together.

import { describe, expect, it } from "vitest";

import { LOOPBACK_SOURCES } from "../buildtime/csp.js";
import { isLoopbackRpc, isLoopbackWs } from "./loopback.js";

describe("isLoopbackRpc — accepts the approved forms", () => {
  it("accepts the three approved hosts over http, on the conventional port", () => {
    expect(isLoopbackRpc("http://localhost:8545")).toBe(true);
    expect(isLoopbackRpc("http://127.0.0.1:8545")).toBe(true);
    expect(isLoopbackRpc("http://[::1]:8545")).toBe(true);
  });

  it("accepts any port, and no port", () => {
    expect(isLoopbackRpc("http://localhost:1")).toBe(true);
    expect(isLoopbackRpc("http://127.0.0.1:65535")).toBe(true);
    expect(isLoopbackRpc("http://localhost")).toBe(true);
  });

  it("accepts a path and query — a node may serve RPC under a path", () => {
    expect(isLoopbackRpc("http://localhost:8545/rpc")).toBe(true);
  });
});

describe("isLoopbackRpc — rejects the near-misses", () => {
  // 127.0.0.2 IS loopback to the OS, but it is NOT in the connect-src set, so
  // accepting it would let a host through every runtime gate and be blocked by
  // the browser. The predicate tracks the allowlist, not the RFC.
  it("rejects other 127.0.0.0/8 addresses the allowlist does not carry", () => {
    expect(isLoopbackRpc("http://127.0.0.2:8545")).toBe(false);
    expect(isLoopbackRpc("http://127.1.2.3:8545")).toBe(false);
  });

  it("rejects the unspecified address", () => {
    expect(isLoopbackRpc("http://0.0.0.0:8545")).toBe(false);
    expect(isLoopbackRpc("http://[::]:8545")).toBe(false);
  });

  it("rejects link-local and private ranges", () => {
    expect(isLoopbackRpc("http://169.254.169.254:8545")).toBe(false);
    expect(isLoopbackRpc("http://10.0.0.1:8545")).toBe(false);
    expect(isLoopbackRpc("http://192.168.1.1:8545")).toBe(false);
    expect(isLoopbackRpc("http://172.16.0.1:8545")).toBe(false);
  });

  it("rejects https on loopback — a local node serves no TLS, and it is not allowlisted", () => {
    expect(isLoopbackRpc("https://localhost:8545")).toBe(false);
    expect(isLoopbackRpc("https://127.0.0.1:8545")).toBe(false);
  });

  it("rejects a remote host that merely CONTAINS a loopback name", () => {
    expect(isLoopbackRpc("http://localhost.evil.com:8545")).toBe(false);
    expect(isLoopbackRpc("http://evil-localhost.com:8545")).toBe(false);
    expect(isLoopbackRpc("http://mylocalhost:8545")).toBe(false);
  });

  it("rejects a remote host carrying a loopback name elsewhere in the URL", () => {
    expect(isLoopbackRpc("http://evil.com/?rpc=localhost")).toBe(false);
    expect(isLoopbackRpc("http://evil.com/localhost")).toBe(false);
    expect(isLoopbackRpc("http://evil.com#127.0.0.1")).toBe(false);
  });

  // The classic: credentials before the @ make the real host the SUFFIX.
  it("rejects a userinfo trick", () => {
    expect(isLoopbackRpc("http://localhost@evil.com:8545")).toBe(false);
    expect(isLoopbackRpc("http://127.0.0.1@evil.com/")).toBe(false);
  });

  it("rejects a remote host on a loopback-looking port", () => {
    expect(isLoopbackRpc("http://203.0.113.5:8545")).toBe(false);
  });

  it("rejects non-http schemes and unparseable input", () => {
    expect(isLoopbackRpc("ws://localhost:8546")).toBe(false);
    expect(isLoopbackRpc("file:///etc/passwd")).toBe(false);
    expect(isLoopbackRpc("not a url")).toBe(false);
    expect(isLoopbackRpc("")).toBe(false);
  });
});

describe("isLoopbackWs — the same rule for the subscription lane", () => {
  it("accepts ws on the approved hosts", () => {
    expect(isLoopbackWs("ws://localhost:8546")).toBe(true);
    expect(isLoopbackWs("ws://127.0.0.1:8546")).toBe(true);
    expect(isLoopbackWs("ws://[::1]:8546")).toBe(true);
  });

  it("rejects wss, remote hosts and http", () => {
    expect(isLoopbackWs("wss://localhost:8546")).toBe(false);
    expect(isLoopbackWs("ws://evil.com:8546")).toBe(false);
    expect(isLoopbackWs("http://localhost:8545")).toBe(false);
  });
});

// The coupling that prevents the worst outcome: a host accepted at runtime but
// blocked by the browser.
describe("predicate ≡ allowlist", () => {
  it("every host the predicate accepts is covered by an approved connect-src source", () => {
    const httpSources = LOOPBACK_SOURCES.filter((s) => s.startsWith("http://"));
    for (const url of [
      "http://localhost:8545",
      "http://127.0.0.1:8545",
      "http://[::1]:8545",
    ]) {
      expect(isLoopbackRpc(url)).toBe(true);
      const origin = new URL(url).origin;
      const host = origin.replace(/^http:\/\//, "").replace(/:\d+$/, "");
      expect(httpSources).toContain(`http://${host}:*`);
    }
  });

  it("the allowlist carries no host the predicate would reject", () => {
    for (const source of LOOPBACK_SOURCES) {
      const probe = source.replace(":*", ":8545");
      const ok = probe.startsWith("ws://")
        ? isLoopbackWs(probe)
        : isLoopbackRpc(probe);
      expect(ok, `${source} is allowlisted but the predicate rejects it`).toBe(true);
    }
  });
});
