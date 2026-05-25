// Regression-catchers for the Sprintnet operator defaults shape.
//
// `SPRINTNET_OPERATOR_RPCS_DEFAULTS` is sourced from the SDK-bundled
// chain registry. The wallet should mirror whatever the SDK ships
// instead of pinning a stale endpoint count locally.
//
// Labels follow the `operator-N` convention (1-indexed off the SDK
// list). The SDK registry doesn't carry a stable per-endpoint id, so the
// wallet renumbers from 1 for display purposes.
//
// The IP-exclusion assertion is the forcing function: if the original
// operator's key is regenerated and the SDK registry re-adds 192.0.2.7
// without paired chain-side re-attestation, this test fails — making
// the re-addition a deliberate, reviewed action rather than a silent
// regression.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SPRINTNET_OPERATOR_RPCS_DEFAULTS,
  clearGenesisCache,
  snapshotGenesisCache,
  verifyOperatorGenesis,
} from "./networks.js";
import { SPRINTNET_GENESIS_HASH } from "../shared/build-info.js";

describe("SPRINTNET_OPERATOR_RPCS_DEFAULTS", () => {
  it("has at least one SDK-sourced endpoint", () => {
    expect(SPRINTNET_OPERATOR_RPCS_DEFAULTS.length).toBeGreaterThanOrEqual(1);
    for (const entry of SPRINTNET_OPERATOR_RPCS_DEFAULTS) {
      expect(entry.rpc).toMatch(/^https?:\/\//);
    }
  });

  it("places operator-1 at position 0 (1-indexed off the SDK registry)", () => {
    expect(SPRINTNET_OPERATOR_RPCS_DEFAULTS[0]?.name).toBe("operator-1");
  });

  it("contains no entry pointing at the dropped operator's old IP (192.0.2.7)", () => {
    for (const entry of SPRINTNET_OPERATOR_RPCS_DEFAULTS) {
      expect(entry.rpc).not.toContain("192.0.2.7");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 6 GAP #11 — genesis-hash pin
// ─────────────────────────────────────────────────────────────────────────────

describe("verifyOperatorGenesis (GAP #11 — orphan-fork defense)", () => {
  const originalFetch = globalThis.fetch;
  const RPC = "http://test-operator.invalid:8545";

  beforeEach(() => {
    clearGenesisCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function installFetch(handler: () => Promise<unknown>) {
    globalThis.fetch = vi.fn(async () => {
      const body = await handler();
      return {
        ok: true,
        status: 200,
        json: async () => body,
      } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  it("returns true when block 0's hash matches SPRINTNET_GENESIS_HASH", async () => {
    installFetch(async () => ({
      jsonrpc: "2.0",
      id: 1,
      result: { hash: SPRINTNET_GENESIS_HASH },
    }));
    const ok = await verifyOperatorGenesis(RPC);
    expect(ok).toBe(true);
    expect(snapshotGenesisCache().get(RPC)?.ok).toBe(true);
    expect(snapshotGenesisCache().get(RPC)?.observed).toBe(
      SPRINTNET_GENESIS_HASH,
    );
  });

  it("returns false on a hash mismatch and caches that result", async () => {
    const forked =
      "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    installFetch(async () => ({
      jsonrpc: "2.0",
      id: 1,
      result: { hash: forked },
    }));
    const ok = await verifyOperatorGenesis(RPC);
    expect(ok).toBe(false);
    expect(snapshotGenesisCache().get(RPC)?.ok).toBe(false);
    expect(snapshotGenesisCache().get(RPC)?.observed).toBe(forked);
  });

  it("returns false on a malformed response (no result.hash)", async () => {
    installFetch(async () => ({ jsonrpc: "2.0", id: 1, result: null }));
    expect(await verifyOperatorGenesis(RPC)).toBe(false);
    expect(snapshotGenesisCache().get(RPC)?.observed).toBeNull();
  });

  it("returns false on transport failure (fetch throws)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("network unreachable");
    }) as unknown as typeof fetch;
    expect(await verifyOperatorGenesis(RPC)).toBe(false);
    expect(snapshotGenesisCache().get(RPC)?.observed).toBeNull();
  });

  it("uses cached result on subsequent calls (forever-cache)", async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        result: { hash: SPRINTNET_GENESIS_HASH },
      }),
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    expect(await verifyOperatorGenesis(RPC)).toBe(true);
    expect(await verifyOperatorGenesis(RPC)).toBe(true);
    expect(await verifyOperatorGenesis(RPC)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("clearGenesisCache(rpc) drops the entry and forces a re-probe", async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        result: { hash: SPRINTNET_GENESIS_HASH },
      }),
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await verifyOperatorGenesis(RPC);
    clearGenesisCache(RPC);
    await verifyOperatorGenesis(RPC);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("clearGenesisCache() (no arg) drops the entire cache", async () => {
    installFetch(async () => ({
      jsonrpc: "2.0",
      id: 1,
      result: { hash: SPRINTNET_GENESIS_HASH },
    }));
    await verifyOperatorGenesis(RPC);
    expect(snapshotGenesisCache().size).toBeGreaterThan(0);
    clearGenesisCache();
    expect(snapshotGenesisCache().size).toBe(0);
  });

  it("treats observed hash case-insensitively (chain returns mixed-case)", async () => {
    installFetch(async () => ({
      jsonrpc: "2.0",
      id: 1,
      result: { hash: SPRINTNET_GENESIS_HASH.toUpperCase() },
    }));
    expect(await verifyOperatorGenesis(RPC)).toBe(true);
  });
});
