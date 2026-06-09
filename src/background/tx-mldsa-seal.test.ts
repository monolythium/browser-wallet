// Real-SDK coverage for the LythiumSeal encrypted-send path. Unlike
// tx-mldsa.test.ts, this suite does NOT mock @monolythium/core-sdk/crypto — the
// seal / parse / submit primitives are the real SDK so the roster validation
// (and, later, the canonical-hash invariant) are exercised for real.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bytesToHex,
  generateOperatorSealKeypair,
} from "@monolythium/core-sdk/crypto";

// One genesis-trusted operator. The per-operator genesis gate inside
// testnetJsonRpc (verifyOperatorGenesis) is covered by tx-mldsa.test.ts; here it
// is stubbed true so we exercise the roster fetch + validation, not the gate.
vi.mock("./networks.js", () => ({
  getActiveOperators: () => [
    { name: "operator-seal", region: "x", rpc: "http://seal.example" },
  ],
  verifyOperatorGenesis: async () => true,
}));

// Build a valid n-of-t cluster seal roster source from freshly generated
// ML-KEM-768 keypairs (real SDK keygen → real 1184-byte encapsulation keys).
function makeRosterSource(opts?: {
  t?: number;
  n?: number;
  clusterId?: number;
  epoch?: number;
  withRosterHash?: "wrong";
}): Record<string, unknown> {
  const n = opts?.n ?? 2;
  const t = opts?.t ?? 2;
  const roster = Array.from({ length: n }, (_, i) => ({
    operatorIndex: i + 1,
    mlKemEk: bytesToHex(generateOperatorSealKeypair().encapsulationKey),
  }));
  const source: Record<string, unknown> = {
    algo: "cluster-mlkem768-shamir",
    clusterId: opts?.clusterId ?? 0,
    epoch: opts?.epoch ?? 0,
    t,
    n,
    roster,
  };
  if (opts?.withRosterHash === "wrong") {
    source.rosterHash = "0x" + "11".repeat(32);
  }
  return source;
}

// fetch mock: answer lyth_getClusterSealKeys with the queued roster source and
// record every JSON-RPC method seen (so cache hit/miss is assertable).
let fetchCalls: { method: string }[] = [];
let rosterToServe: unknown = null;
function installFetch(): void {
  fetchCalls = [];
  globalThis.fetch = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String((init as { body?: string })?.body ?? "{}"));
    fetchCalls.push({ method: body.method });
    const result =
      body.method === "lyth_getClusterSealKeys" ? rosterToServe : "0x";
    return {
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: "2.0", id: 1, result }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("fetchClusterSealKeys — genesis-trusted roster fetch + validation", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    vi.resetModules(); // fresh module → fresh roster cache per test
    installFetch();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("parses a valid served roster into typed ClusterSealKeys", async () => {
    rosterToServe = makeRosterSource({ t: 2, n: 3, epoch: 5 });
    const tx = await import("./tx-mldsa.js");
    const keys = await tx.fetchClusterSealKeys(0);
    expect(keys.clusterId).toBe(0);
    expect(keys.n).toBe(3);
    expect(keys.t).toBe(2);
    expect(keys.epoch).toBe(5n);
    expect(keys.recipientEks).toHaveLength(3);
    expect(keys.rosterHash).toHaveLength(32);
  });

  it("rejects a roster whose supplied rosterHash does not commit to the ek set", async () => {
    rosterToServe = makeRosterSource({ withRosterHash: "wrong" });
    const tx = await import("./tx-mldsa.js");
    await expect(tx.fetchClusterSealKeys(0)).rejects.toThrow(
      /roster hash mismatch/i,
    );
  });

  it("rejects a structurally-invalid roster (non-contiguous operator index)", async () => {
    const src = makeRosterSource({ n: 2, t: 2 }) as {
      roster: { operatorIndex: number }[];
    };
    src.roster[1]!.operatorIndex = 5; // breaks the required 1..=n order
    rosterToServe = src;
    const tx = await import("./tx-mldsa.js");
    await expect(tx.fetchClusterSealKeys(0)).rejects.toThrow();
  });

  it("getClusterSealKeys serves a cached roster within the TTL (single fetch)", async () => {
    rosterToServe = makeRosterSource();
    const tx = await import("./tx-mldsa.js");
    await tx.getClusterSealKeys(0);
    await tx.getClusterSealKeys(0);
    const sealFetches = fetchCalls.filter(
      (c) => c.method === "lyth_getClusterSealKeys",
    );
    expect(sealFetches).toHaveLength(1); // second call is a cache hit
  });

  it("fetchClusterSealKeys always re-fetches + updates the cached epoch", async () => {
    rosterToServe = makeRosterSource({ epoch: 1 });
    const tx = await import("./tx-mldsa.js");
    expect((await tx.fetchClusterSealKeys(0)).epoch).toBe(1n);
    rosterToServe = makeRosterSource({ epoch: 2 });
    expect((await tx.fetchClusterSealKeys(0)).epoch).toBe(2n);
    const sealFetches = fetchCalls.filter(
      (c) => c.method === "lyth_getClusterSealKeys",
    );
    expect(sealFetches).toHaveLength(2); // force-fetch each time
  });
});
