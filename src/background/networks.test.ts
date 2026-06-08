// Regression-catchers for the testnet operator defaults shape.
//
// `TESTNET_OPERATOR_RPCS_DEFAULTS` is sourced from the SDK-bundled
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
  TESTNET_OPERATOR_RPCS_DEFAULTS,
  MAX_EXECUTION_UNIT_PRICE_LYTHOSHI,
  clearGenesisCache,
  classifyNoOperatorReason,
  getActiveOperators,
  probeFirstAliveOperator,
  snapshotGenesisCache,
  snapshotWrongChainOperators,
  verifyOperatorGenesis,
} from "./networks.js";
import { clampToSaneBound } from "../shared/operator-bounds.js";
import {
  TESTNET_BLOCK0_HASH,
  TESTNET_GENESIS_HASH,
} from "../shared/build-info.js";

describe("TESTNET_OPERATOR_RPCS_DEFAULTS", () => {
  it("has at least one SDK-sourced endpoint", () => {
    expect(TESTNET_OPERATOR_RPCS_DEFAULTS.length).toBeGreaterThanOrEqual(1);
    for (const entry of TESTNET_OPERATOR_RPCS_DEFAULTS) {
      expect(entry.rpc).toMatch(/^https?:\/\//);
    }
  });

  it("places operator-1 at position 0 (1-indexed off the SDK registry)", () => {
    expect(TESTNET_OPERATOR_RPCS_DEFAULTS[0]?.name).toBe("operator-1");
  });

  it("contains no entry pointing at the dropped operator's old IP (192.0.2.7)", () => {
    for (const entry of TESTNET_OPERATOR_RPCS_DEFAULTS) {
      expect(entry.rpc).not.toContain("192.0.2.7");
    }
  });
});

describe("verifyOperatorGenesis", () => {
  const originalFetch = globalThis.fetch;
  const RPC = "http://test-operator.invalid:8545";

  beforeEach(() => {
    clearGenesisCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function installFetch(
    handler: (request: {
      method: string;
      params: unknown[];
    }) => Promise<unknown>,
  ) {
    globalThis.fetch = vi.fn(async (_url, init) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        method?: unknown;
        params?: unknown;
      };
      const body = await handler({
        method: typeof payload.method === "string" ? payload.method : "",
        params: Array.isArray(payload.params) ? payload.params : [],
      });
      return {
        ok: true,
        status: 200,
        json: async () => body,
      } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  function unsupportedStats() {
    return { jsonrpc: "2.0", id: 1, error: { message: "method not found" } };
  }

  it("returns true when lyth_chainStats genesisHash matches TESTNET_GENESIS_HASH", async () => {
    installFetch(async () => ({
      jsonrpc: "2.0",
      id: 1,
      result: { genesisHash: TESTNET_GENESIS_HASH },
    }));
    const ok = await verifyOperatorGenesis(RPC);
    expect(ok).toBe(true);
    expect(snapshotGenesisCache().get(RPC)?.ok).toBe(true);
    expect(snapshotGenesisCache().get(RPC)?.observed).toBe(
      TESTNET_GENESIS_HASH,
    );
  });

  it("returns false on a lyth_chainStats hash mismatch and caches that result", async () => {
    const forked =
      "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    installFetch(async () => ({
      jsonrpc: "2.0",
      id: 1,
      result: { genesisHash: forked },
    }));
    const ok = await verifyOperatorGenesis(RPC);
    expect(ok).toBe(false);
    expect(snapshotGenesisCache().get(RPC)?.ok).toBe(false);
    expect(snapshotGenesisCache().get(RPC)?.observed).toBe(forked);
  });

  it("falls back to block 0 when lyth_chainStats is unavailable", async () => {
    installFetch(async ({ method }) =>
      method === "lyth_chainStats"
        ? unsupportedStats()
        : {
            jsonrpc: "2.0",
            id: 1,
            result: { hash: TESTNET_BLOCK0_HASH },
          },
    );
    const ok = await verifyOperatorGenesis(RPC);
    expect(ok).toBe(true);
    expect(snapshotGenesisCache().get(RPC)?.observed).toBe(
      TESTNET_BLOCK0_HASH,
    );
  });

  it("returns true (probe-not-supported) when fallback block 0 result is null", async () => {
    installFetch(async ({ method }) =>
      method === "lyth_chainStats"
        ? unsupportedStats()
        : { jsonrpc: "2.0", id: 1, result: null },
    );
    expect(await verifyOperatorGenesis(RPC)).toBe(true);
    expect(snapshotGenesisCache().get(RPC)?.observed).toBeNull();
    expect(snapshotGenesisCache().get(RPC)?.ok).toBe(true);
  });

  it("returns false on a malformed fallback response (result exists but no hash field)", async () => {
    installFetch(async ({ method }) =>
      method === "lyth_chainStats"
        ? unsupportedStats()
        : { jsonrpc: "2.0", id: 1, result: {} },
    );
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
        result: { genesisHash: TESTNET_GENESIS_HASH },
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
        result: { genesisHash: TESTNET_GENESIS_HASH },
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
      result: { genesisHash: TESTNET_GENESIS_HASH },
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
      result: { genesisHash: TESTNET_GENESIS_HASH.toUpperCase() },
    }));
    expect(await verifyOperatorGenesis(RPC)).toBe(true);
  });
});

describe("MAX_EXECUTION_UNIT_PRICE_LYTHOSHI — fee-price ceiling (18-decimal domain)", () => {
  // Pins the 18-decimal-domain ceiling so it can't silently regress to an
  // 8-decimal-era value (the bug class that stranded the balance UI). The
  // DANGEROUS direction is too-LOW: it would clamp a legitimate high price
  // DOWN and underprice/stall the tx. Realistic price is ~1e9–1e10
  // lythoshi/unit (Send page shows ~1e9).
  it("is pinned at 1e15 lythoshi/unit (loose-but-safe, 18-dec)", () => {
    expect(MAX_EXECUTION_UNIT_PRICE_LYTHOSHI).toBe(1_000_000_000_000_000n);
  });

  it("passes a realistic price (~1e9–1e10 lythoshi/unit) through UNCLAMPED", () => {
    for (const realistic of [1_000_000_000n, 10_000_000_000n, 50_000_000_000n]) {
      expect(clampToSaneBound(realistic, MAX_EXECUTION_UNIT_PRICE_LYTHOSHI)).toBe(
        realistic,
      );
    }
  });

  it("never clamps even a 1000x congestion spike over the real price", () => {
    // 1e10 (high end of observed) x 1000 = 1e13, still well below the 1e15 ceiling.
    const congestionSpike = 10_000_000_000n * 1000n; // 1e13
    expect(
      clampToSaneBound(congestionSpike, MAX_EXECUTION_UNIT_PRICE_LYTHOSHI),
    ).toBe(congestionSpike);
  });

  it("clamps an absurd operator/popup price down to the ceiling", () => {
    const absurd = 10n ** 30n; // 1e30 lythoshi/unit — physically impossible
    expect(clampToSaneBound(absurd, MAX_EXECUTION_UNIT_PRICE_LYTHOSHI)).toBe(
      MAX_EXECUTION_UNIT_PRICE_LYTHOSHI,
    );
  });
});

describe("classifyNoOperatorReason (#42 untrusted vs unreachable)", () => {
  const entry = (ok: boolean, observed: string | null) => ({
    ok,
    observed,
    checkedAt: 0,
  });

  // Isolate from any module-level wrong-chain state a probe test may leave.
  beforeEach(() => clearGenesisCache());

  it("empty genesis cache → unreachable", () => {
    expect(classifyNoOperatorReason([{ rpc: "a" }], new Map())).toBe(
      "unreachable",
    );
  });

  it("active op with a mismatching hash (ok:false, observed!=null) → untrusted", () => {
    const g = new Map([["a", entry(false, "0xdeadbeef")]]);
    expect(classifyNoOperatorReason([{ rpc: "a" }], g)).toBe("untrusted");
  });

  it("active op that couldn't read a hash (ok:false, observed:null) → unreachable", () => {
    const g = new Map([["a", entry(false, null)]]);
    expect(classifyNoOperatorReason([{ rpc: "a" }], g)).toBe("unreachable");
  });

  it("#18 fail-open op (ok:true, observed:null) → unreachable (stays trusted)", () => {
    const g = new Map([["a", entry(true, null)]]);
    expect(classifyNoOperatorReason([{ rpc: "a" }], g)).toBe("unreachable");
  });

  it("a stale untrusted entry for a REMOVED operator (not active) → unreachable", () => {
    const g = new Map([["removed", entry(false, "0xstale")]]);
    expect(classifyNoOperatorReason([{ rpc: "a" }], g)).toBe("unreachable");
  });

  it("untrusted OUTRANKS unreachable in a mixed fleet", () => {
    const g = new Map([["a", entry(false, "0xmismatch")]]); // b has no entry
    expect(classifyNoOperatorReason([{ rpc: "a" }, { rpc: "b" }], g)).toBe(
      "untrusted",
    );
  });

  it("reachable op on the WRONG CHAIN ID (in wrongChain set) → untrusted", () => {
    expect(
      classifyNoOperatorReason([{ rpc: "a" }], new Map(), new Set(["a"])),
    ).toBe("untrusted");
  });

  it("a wrong-chain entry for a REMOVED operator (not active) → unreachable", () => {
    expect(
      classifyNoOperatorReason([{ rpc: "a" }], new Map(), new Set(["removed"])),
    ).toBe("unreachable");
  });

  it("wrong-chain OUTRANKS unreachable in a mixed fleet", () => {
    expect(
      classifyNoOperatorReason(
        [{ rpc: "a" }, { rpc: "b" }],
        new Map(),
        new Set(["b"]),
      ),
    ).toBe("untrusted");
  });
});

describe("probeFirstAliveOperator (#42 reachable-but-wrong-chain → untrusted)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => clearGenesisCache());
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("records reachable operators that report the wrong chain id and classifies untrusted", async () => {
    // Every active operator answers net_version, but with a chain id that does
    // not match the expected one — reachable, wrong chain (not unreachable).
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: "999999" }),
    })) as unknown as typeof fetch;

    const hit = await probeFirstAliveOperator(69420, 50);
    expect(hit).toBeNull();

    const active = getActiveOperators();
    expect(active.length).toBeGreaterThanOrEqual(1);
    for (const op of active) {
      expect(snapshotWrongChainOperators().has(op.rpc)).toBe(true);
    }
    expect(
      classifyNoOperatorReason(
        active,
        snapshotGenesisCache(),
        snapshotWrongChainOperators(),
      ),
    ).toBe("untrusted");
  });
});
