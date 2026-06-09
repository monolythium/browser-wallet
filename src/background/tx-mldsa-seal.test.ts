// Real-SDK coverage for the LythiumSeal encrypted-send path. Unlike
// tx-mldsa.test.ts, this suite does NOT mock @monolythium/core-sdk/crypto — the
// seal / parse / submit primitives are the real SDK so the roster validation
// (and, later, the canonical-hash invariant) are exercised for real.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MlDsa65Backend,
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

// getUnlockedBackendV4 returns a real MlDsa65Backend the tests set per-case.
vi.mock("./keystore-mldsa.js", () => ({
  getUnlockedBackendV4: vi.fn(() => null),
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

// fetch mock: answer lyth_getClusterSealKeys with the queued roster source,
// lyth_submitEncrypted with the queued response, and record every JSON-RPC
// (method + params) so cache hits + the submit param shape are assertable.
let fetchCalls: { method: string; params: unknown }[] = [];
let rosterToServe: unknown = null;
let rosterError = false; // when true, lyth_getClusterSealKeys returns an error
let meshEcho = "0x" + "ee".repeat(32); // mesh_submitTx echoed canonical hash
let submitEncryptedResponse: {
  result?: unknown;
  error?: { code: number; message: string };
} = { result: "0x" + "cd".repeat(32) };
function installFetch(): void {
  fetchCalls = [];
  submitEncryptedResponse = { result: "0x" + "cd".repeat(32) };
  rosterError = false;
  meshEcho = "0x" + "ee".repeat(32);
  globalThis.fetch = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String((init as { body?: string })?.body ?? "{}"));
    fetchCalls.push({ method: body.method, params: body.params });
    let payload: Record<string, unknown>;
    if (body.method === "lyth_getClusterSealKeys") {
      payload = rosterError
        ? { error: { code: -32601, message: "method not found" } }
        : { result: rosterToServe };
    } else if (body.method === "lyth_submitEncrypted") {
      payload = submitEncryptedResponse;
    } else if (body.method === "mesh_submitTx") {
      payload = { result: meshEcho };
    } else {
      payload = { result: "0x" };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: "2.0", id: 1, ...payload }),
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

describe("buildSealedSubmission — canonical-hash invariant (seal wraps, never re-keys)", () => {
  const originalFetch = globalThis.fetch;
  const TEST_SEED = new Uint8Array(32).fill(7);
  const TX_REQ = {
    to: "0x" + "ab".repeat(20),
    value: "0x0",
    data: "0x",
    gas: "0x5208",
    nonce: "0x1",
    maxFeePerGas: "0x3b9aca00",
    maxPriorityFeePerGas: "0x3b9aca00",
    chainIdHex: "0x10f2c",
  };
  beforeEach(() => {
    vi.resetModules();
    installFetch();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("seals to the SAME canonical inner-tx hash + sighash as the plaintext path", async () => {
    rosterToServe = makeRosterSource({ t: 2, n: 3 });
    const backend = MlDsa65Backend.fromSeed(TEST_SEED);
    const ks = await import("./keystore-mldsa.js");
    vi.mocked(ks.getUnlockedBackendV4).mockReturnValue(backend);
    const tx = await import("./tx-mldsa.js");
    const roster = await tx.fetchClusterSealKeys(0);

    const plain = await tx.buildPlaintextSubmission({ txReq: TX_REQ });
    const sealed = await tx.buildSealedSubmission({
      txReq: TX_REQ,
      clusterSealKeys: roster,
    });

    // THE invariant: the inner canonical hashes are identical. The receipt is
    // keyed on innerTxHashHex; if sealing changed it, the receipt poll could
    // never resolve. signEvmTx is deterministic (extraEntropy: false), so the
    // same {backend, tx} yields the same signed tx + hash on both paths.
    expect(sealed.innerTxHashHex).toBe(plain.innerTxHashHex);
    expect(sealed.innerSighashHex).toBe(plain.innerSighashHex);
    // The envelope is a real sealed wrapper: 0x-hex, larger than the bare signed
    // tx (ML-KEM ciphertext + Shamir shares + outer signature).
    expect(sealed.envelopeWireHex.startsWith("0x")).toBe(true);
    expect(sealed.envelopeWireHex.length).toBeGreaterThan(
      plain.signedTxWireHex.length,
    );
  });

  it("throws 'wallet is locked' when no backend is unlocked (fails closed)", async () => {
    rosterToServe = makeRosterSource();
    const ks = await import("./keystore-mldsa.js");
    vi.mocked(ks.getUnlockedBackendV4).mockReturnValue(null);
    const tx = await import("./tx-mldsa.js");
    const roster = await tx.fetchClusterSealKeys(0);
    await expect(
      tx.buildSealedSubmission({ txReq: TX_REQ, clusterSealKeys: roster }),
    ).rejects.toThrow(/locked/i);
  });
});

describe("broadcastEncryptedTransaction — lyth_submitEncrypted, trust local hash", () => {
  const originalFetch = globalThis.fetch;
  const ENVELOPE = "0xdeadbeef";
  const LOCAL_HASH = "0x" + "ab".repeat(32);
  beforeEach(() => {
    vi.resetModules();
    installFetch();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("submits the envelope as a positional [envelopeWireHex] param (not {envelope})", async () => {
    const tx = await import("./tx-mldsa.js");
    await tx.broadcastEncryptedTransaction(ENVELOPE, LOCAL_HASH);
    const submit = fetchCalls.find((c) => c.method === "lyth_submitEncrypted");
    expect(submit?.params).toEqual([ENVELOPE]);
  });

  it("returns the LOCAL canonical hash even when the node returns a DIFFERENT 32-byte hash", async () => {
    submitEncryptedResponse = { result: "0x" + "99".repeat(32) }; // node id != local
    const tx = await import("./tx-mldsa.js");
    const r = await tx.broadcastEncryptedTransaction(ENVELOPE, LOCAL_HASH);
    expect(r.txHash).toBe(LOCAL_HASH); // never adopts the node echo (it can't be the inner hash)
  });

  it("accepts a non-32-byte-hash success response without throwing (no false reject → no double-send)", async () => {
    submitEncryptedResponse = { result: { mailboxId: 7 } }; // unexpected but non-error
    const tx = await import("./tx-mldsa.js");
    const r = await tx.broadcastEncryptedTransaction(ENVELOPE, LOCAL_HASH);
    expect(r.txHash).toBe(LOCAL_HASH);
  });

  it("propagates a JSON-RPC error from the node (surfaced to the send-error classifier)", async () => {
    submitEncryptedResponse = {
      error: { code: -32602, message: "invalid params: missing encrypted envelope" },
    };
    const tx = await import("./tx-mldsa.js");
    await expect(
      tx.broadcastEncryptedTransaction(ENVELOPE, LOCAL_HASH),
    ).rejects.toThrow();
  });

  it("submitSealedMlDsaTx builds + broadcasts, returning the local canonical inner-tx hash", async () => {
    rosterToServe = makeRosterSource();
    submitEncryptedResponse = { result: "0x" + "77".repeat(32) };
    const backend = MlDsa65Backend.fromSeed(new Uint8Array(32).fill(9));
    const ks = await import("./keystore-mldsa.js");
    vi.mocked(ks.getUnlockedBackendV4).mockReturnValue(backend);
    const tx = await import("./tx-mldsa.js");
    const roster = await tx.fetchClusterSealKeys(0);
    const r = await tx.submitSealedMlDsaTx(
      {
        to: "0x" + "cd".repeat(20),
        value: "0x0",
        data: "0x",
        gas: "0x5208",
        nonce: "0x2",
        maxFeePerGas: "0x3b9aca00",
        maxPriorityFeePerGas: "0x3b9aca00",
        chainIdHex: "0x10f2c",
      },
      roster,
    );
    expect(r.txHash).toMatch(/^0x[0-9a-f]{64}$/); // the local canonical inner hash
    expect(r.via).toBe("operator-seal");
    const submit = fetchCalls.find((c) => c.method === "lyth_submitEncrypted");
    expect(Array.isArray(submit?.params)).toBe(true);
    expect((submit?.params as string[])[0]?.startsWith("0x")).toBe(true);
  });
});

describe("submitMlDsaTx — seal-vs-plaintext decision (single chokepoint, fail-closed)", () => {
  const originalFetch = globalThis.fetch;
  const TEST_SEED = new Uint8Array(32).fill(3);
  const TX_REQ = {
    to: "0x" + "12".repeat(20),
    value: "0x0",
    data: "0x",
    gas: "0x5208",
    nonce: "0x3",
    maxFeePerGas: "0x3b9aca00",
    maxPriorityFeePerGas: "0x3b9aca00",
    chainIdHex: "0x10f2c",
  };
  beforeEach(() => {
    vi.resetModules();
    installFetch();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("seals when a roster is available (lyth_submitEncrypted, never mesh_submitTx)", async () => {
    rosterToServe = makeRosterSource();
    const backend = MlDsa65Backend.fromSeed(TEST_SEED);
    const ks = await import("./keystore-mldsa.js");
    vi.mocked(ks.getUnlockedBackendV4).mockReturnValue(backend);
    const tx = await import("./tx-mldsa.js");
    const r = await tx.submitMlDsaTx(TX_REQ);
    expect(r.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(fetchCalls.some((c) => c.method === "lyth_submitEncrypted")).toBe(
      true,
    );
    expect(fetchCalls.some((c) => c.method === "mesh_submitTx")).toBe(false);
  });

  it("falls back to plaintext when the roster is unavailable (mesh_submitTx, never lyth_submitEncrypted)", async () => {
    rosterError = true; // lyth_getClusterSealKeys errors → roster absent → plaintext
    const backend = MlDsa65Backend.fromSeed(TEST_SEED);
    const ks = await import("./keystore-mldsa.js");
    vi.mocked(ks.getUnlockedBackendV4).mockReturnValue(backend);
    const tx = await import("./tx-mldsa.js");
    // Echo the correct canonical hash so the plaintext broadcast validates.
    meshEcho = (await tx.buildPlaintextSubmission({ txReq: TX_REQ }))
      .innerTxHashHex;
    const r = await tx.submitMlDsaTx(TX_REQ);
    expect(r.txHash).toBe(meshEcho);
    expect(fetchCalls.some((c) => c.method === "mesh_submitTx")).toBe(true);
    expect(fetchCalls.some((c) => c.method === "lyth_submitEncrypted")).toBe(
      false,
    );
  });
});

describe("withEncryptedExecutionUnitFloor — clears the encrypted intrinsic floor", () => {
  const originalFetch = globalThis.fetch;
  const TEST_SEED = new Uint8Array(32).fill(4);
  const BASE = {
    to: "0x" + "ab".repeat(20),
    value: "0x0",
    data: "0x",
    gas: "0x7530", // 30000 — a plaintext send limit
    nonce: "0x4",
    maxFeePerGas: "0x3b9aca00",
    maxPriorityFeePerGas: "0x3b9aca00",
    chainIdHex: "0x10f2c",
  };
  beforeEach(() => {
    vi.resetModules();
    installFetch();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("raises a plaintext per-tx-type limit above the observed encrypted floors", async () => {
    const tx = await import("./tx-mldsa.js");
    const send = tx.withEncryptedExecutionUnitFloor({ ...BASE, gas: "0x7530" }); // 30000
    expect(BigInt(send.gas)).toBe(280000n); // 30000 + 250000
    expect(BigInt(send.gas)).toBeGreaterThan(248213n); // observed send floor
    const delegate = tx.withEncryptedExecutionUnitFloor({
      ...BASE,
      gas: "0x186a0", // 100000
    });
    expect(BigInt(delegate.gas)).toBe(350000n);
    expect(BigInt(delegate.gas)).toBeGreaterThan(249301n); // observed delegate floor
    expect(send.to).toBe(BASE.to);
    expect(send.nonce).toBe(BASE.nonce); // other fields untouched
  });

  it("is additive so a high-base tx (e.g. MRV) still clears the floor", async () => {
    const tx = await import("./tx-mldsa.js");
    const mrv = tx.withEncryptedExecutionUnitFloor({
      ...BASE,
      gas: "0x7a120", // 500000
    });
    expect(BigInt(mrv.gas)).toBe(750000n);
  });

  it("the dispatcher seals the FLOOR-RAISED tx (receipt hash = bumped tx, not original)", async () => {
    rosterToServe = makeRosterSource();
    submitEncryptedResponse = { result: "0x" + "55".repeat(32) };
    const backend = MlDsa65Backend.fromSeed(TEST_SEED);
    const ks = await import("./keystore-mldsa.js");
    vi.mocked(ks.getUnlockedBackendV4).mockReturnValue(backend);
    const tx = await import("./tx-mldsa.js");
    const r = await tx.submitMlDsaTx(BASE);
    // The sealed tx's canonical hash equals the plaintext hash of the
    // FLOOR-RAISED tx — proving the dispatcher sealed the bumped tx (and the
    // canonical-hash invariant still holds for the bumped tx).
    const plainBumped = await tx.buildPlaintextSubmission({
      txReq: tx.withEncryptedExecutionUnitFloor(BASE),
    });
    const plainOriginal = await tx.buildPlaintextSubmission({ txReq: BASE });
    expect(r.txHash).toBe(plainBumped.innerTxHashHex);
    expect(r.txHash).not.toBe(plainOriginal.innerTxHashHex); // the bump took effect
  });
});
