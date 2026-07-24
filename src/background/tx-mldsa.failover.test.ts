// Phase 1 Part A — read-failover on the transient/operator-scoped error band.
//
// `_testnetJsonRpcUncoalesced` (via the exported `testnetJsonRpc`) must fail
// over across the genesis-trusted fleet on an HTTP-200 {error} body whose code
// is operator-scoped/transient, while propagating deterministic errors and the
// mesh_submitTx mempool-wrapped -32047 admission reject immediately. Multi-op
// fleet + per-URL fetch mock let each case pin one behaviour. No live chain.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const OP1 = { name: "operator-1", region: "a", rpc: "http://op1.example" };
const OP2 = { name: "operator-2", region: "b", rpc: "http://op2.example" };
const OP3 = { name: "operator-3", region: "c", rpc: "http://op3.example" };

// getActiveOperators is a vi.fn so each test sets the fleet; verifyOperatorGenesis
// always-true (this suite tests dispatch failover, not the genesis gate).
vi.mock("./networks.js", () => ({
  getActiveOperators: vi.fn(() => [OP1, OP2, OP3]),
  verifyOperatorGenesis: vi.fn(async () => true),
  allActiveOperatorsDefinitivelyUntrusted: vi.fn(() => false),
  classifyNoOperatorReason: vi.fn(() => "unreachable"),
}));

// Module-load imports that must not touch the real SDK / keystore.
vi.mock("@monolythium/core-sdk/crypto", () => ({
  buildPlaintextSubmission: vi.fn(),
}));
vi.mock("./keystore-mldsa.js", () => ({
  getUnlockedBackendV4: () => ({}),
  getActiveVaultIdV4: vi.fn(() => "v1"),
}));

import {
  testnetJsonRpc,
  __resetReadFailoverStateForTest,
} from "./tx-mldsa.js";
import { getActiveOperators } from "./networks.js";

// --- fetch mock: route by operator rpc URL ---
type RpcOutcome =
  | { kind: "result"; result: unknown }
  | { kind: "error"; code?: number | undefined; message?: string | undefined }
  | { kind: "transport" }; // non-2xx

function outcomeToResponse(o: RpcOutcome, url: string) {
  if (o.kind === "transport") {
    return { ok: false, status: 503, json: async () => ({}) };
  }
  const payload =
    o.kind === "result"
      ? { jsonrpc: "2.0", id: 1, result: o.result }
      : { jsonrpc: "2.0", id: 1, error: { code: o.code, message: o.message ?? `err from ${url}` } };
  return { ok: true, status: 200, json: async () => payload };
}

/** Install a fetch that maps each operator URL to an outcome and records the
 *  URL order in which operators were dialed. */
function installFetch(byUrl: Record<string, RpcOutcome>): { order: string[] } {
  const order: string[] = [];
  globalThis.fetch = vi.fn(async (url: unknown) => {
    const u = String(url);
    order.push(u);
    const o = byUrl[u];
    if (o === undefined) throw new TypeError(`unexpected url ${u}`);
    return outcomeToResponse(o, u);
  }) as unknown as typeof fetch;
  return { order };
}

const originalFetch = globalThis.fetch;
beforeEach(() => {
  __resetReadFailoverStateForTest();
  vi.mocked(getActiveOperators).mockReturnValue([OP1, OP2, OP3]);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

// The FAILOVER band (operator-scoped / transient): another trusted operator may
// answer. Bare -32047 uses a NON-mempool message so extractMempoolInner→null.
const FAILOVER_CASES: Array<{ code: number; message?: string; label: string }> = [
  { code: -32045, label: "METHOD_DISABLED" },
  { code: -32046, label: "NOT_IMPLEMENTED" },
  { code: -32047, message: "upstream unavailable: indexer: down", label: "UPSTREAM_UNAVAILABLE (bare)" },
  { code: -32048, label: "TIMEOUT" },
  { code: -32058, label: "CACHE_UNAVAILABLE" },
  { code: -32601, label: "METHOD_NOT_FOUND (stale binary)" },
  { code: -32701, label: "PRE_RETENTION_WINDOW" },
  { code: -32090, label: "NOT_FOUND" },
];

describe("read-failover — FAILOVER band advances degraded → healthy", () => {
  for (const c of FAILOVER_CASES) {
    it(`${c.label} (${c.code}) on op1 → fails over to op2`, async () => {
      installFetch({
        [OP1.rpc]: { kind: "error", code: c.code, message: c.message },
        [OP2.rpc]: { kind: "result", result: "0xhealthy" },
        [OP3.rpc]: { kind: "result", result: "0xshouldNotReach" },
      });
      const r = await testnetJsonRpc<string>("lyth_txStatus", [`0x${c.code}`]);
      expect(r.result).toBe("0xhealthy");
      expect(r.via).toBe("operator-2");
    });
  }
});

// The PROPAGATE band (deterministic / tx-decision): every operator answers the
// same, so throw immediately WITHOUT reaching a later operator.
const PROPAGATE_CASES: Array<{ code: number; label: string }> = [
  { code: -32602, label: "INVALID_PARAMS" },
  { code: -32700, label: "PARSE_ERROR" },
  { code: -32059, label: "INVALID_JSONRPC_VERSION" },
  { code: -32043, label: "REQUEST_TOO_LARGE" },
];

describe("read-failover — PROPAGATE band throws immediately (no failover)", () => {
  for (const c of PROPAGATE_CASES) {
    it(`${c.label} (${c.code}) on op1 → throws, op2 never reached`, async () => {
      const { order } = installFetch({
        [OP1.rpc]: { kind: "error", code: c.code, message: c.label },
        [OP2.rpc]: { kind: "result", result: "0xshouldNotReach" },
        [OP3.rpc]: { kind: "result", result: "0xshouldNotReach" },
      });
      const err = await testnetJsonRpc("lyth_txStatus", ["0x1"]).then(
        () => null,
        (e) => e as Error & { code?: number },
      );
      expect(err?.code).toBe(c.code);
      expect(order).toEqual([OP1.rpc]); // stopped at op1
    });
  }

  it("mempool-WRAPPED -32047 (admission reject) propagates — NOT failover", async () => {
    const { order } = installFetch({
      [OP1.rpc]: {
        kind: "error",
        code: -32047,
        message: "upstream unavailable: mempool: insufficient balance",
      },
      [OP2.rpc]: { kind: "result", result: "0xshouldNotReach" },
      [OP3.rpc]: { kind: "result", result: "0xshouldNotReach" },
    });
    const err = await testnetJsonRpc("lyth_txStatus", ["0x1"]).then(
      () => null,
      (e) => e as Error & { code?: number },
    );
    expect(err?.code).toBe(-32047);
    expect(order).toEqual([OP1.rpc]); // wrapped -32047 is deterministic → no failover
  });
});

describe("read-failover — D1 attempt cap (4)", () => {
  it("stops after 4 failover-band attempts and surfaces the last error", async () => {
    // 6-operator fleet, all NOT_IMPLEMENTED → the cap must halt the walk at 4.
    const OPS = [OP1, OP2, OP3, { name: "operator-4", region: "d", rpc: "http://op4.example" }, { name: "operator-5", region: "e", rpc: "http://op5.example" }, { name: "operator-6", region: "f", rpc: "http://op6.example" }];
    vi.mocked(getActiveOperators).mockReturnValue(OPS);
    const { order } = installFetch(
      Object.fromEntries(OPS.map((o) => [o.rpc, { kind: "error", code: -32046, message: "not implemented" } as RpcOutcome])),
    );
    const err = await testnetJsonRpc("lyth_txStatus", ["0x1"]).then(
      () => null,
      (e) => e as Error & { code?: number },
    );
    expect(err?.code).toBe(-32046);
    expect(order.length).toBe(4); // D1: at most 4 operators dialed, not all 6
  });
});

describe("read-failover — D2 soft deprioritize (~30s)", () => {
  it("a failover-flagged operator is tried AFTER fresh operators, but still tried when they're exhausted", async () => {
    // Round 1: op1 errors (failover-band) → op2 answers. op1 is now degraded.
    installFetch({
      [OP1.rpc]: { kind: "error", code: -32047, message: "upstream unavailable: p2p: down" },
      [OP2.rpc]: { kind: "result", result: "0xr1" },
      [OP3.rpc]: { kind: "result", result: "0xr1c" },
    });
    const r1 = await testnetJsonRpc<string>("lyth_txStatus", ["0xa"]);
    expect(r1.via).toBe("operator-2");

    // Round 2: op2 transport-fails, op3 fresh answers. If op1 were NOT
    // deprioritized the order [op1,op2,op3] would return op1; instead the
    // order is [op2,op3,op1] so op3 answers before op1 is reached.
    const { order: order2 } = installFetch({
      [OP1.rpc]: { kind: "result", result: "0xfromOp1" },
      [OP2.rpc]: { kind: "transport" },
      [OP3.rpc]: { kind: "result", result: "0xfromOp3" },
    });
    const r2 = await testnetJsonRpc<string>("lyth_txStatus", ["0xb"]);
    // op3 (fresh) answered before op1 (degraded) was reached — proving op1 was
    // deprioritized below op3. (op1 isn't dialed at all here, since op3 wins.)
    expect(r2.via).toBe("operator-3");
    expect(order2).not.toContain(OP1.rpc); // degraded op1 never reached this round

    // Round 3: everyone but op1 transport-fails → the SOFT deprioritize still
    // reaches op1 (never a hard removal).
    installFetch({
      [OP1.rpc]: { kind: "result", result: "0xfromOp1" },
      [OP2.rpc]: { kind: "transport" },
      [OP3.rpc]: { kind: "transport" },
    });
    const r3 = await testnetJsonRpc<string>("lyth_txStatus", ["0xc"]);
    expect(r3.via).toBe("operator-1");
  });

  it("a later SUCCESS clears the degraded flag (recovers before the TTL)", async () => {
    // op1 fails once (degraded), then op1 succeeds → flag cleared. A subsequent
    // read with op1 first must return op1 (no longer deprioritized).
    installFetch({
      [OP1.rpc]: { kind: "error", code: -32046, message: "x" },
      [OP2.rpc]: { kind: "result", result: "0xr" },
      [OP3.rpc]: { kind: "result", result: "0xr" },
    });
    await testnetJsonRpc("lyth_txStatus", ["0x1"]); // op1 degraded

    // op2 fails so op1 (still last) is reached and SUCCEEDS → clears its flag.
    installFetch({
      [OP1.rpc]: { kind: "result", result: "0xop1ok" },
      [OP2.rpc]: { kind: "transport" },
      [OP3.rpc]: { kind: "transport" },
    });
    const r2 = await testnetJsonRpc<string>("lyth_txStatus", ["0x2"]);
    expect(r2.via).toBe("operator-1");

    // Now op1 is fresh again → order [op1,op2,op3], op1 answers first.
    const { order } = installFetch({
      [OP1.rpc]: { kind: "result", result: "0xop1first" },
      [OP2.rpc]: { kind: "result", result: "0xr" },
      [OP3.rpc]: { kind: "result", result: "0xr" },
    });
    const r3 = await testnetJsonRpc<string>("lyth_txStatus", ["0x3"]);
    expect(r3.via).toBe("operator-1");
    expect(order[0]).toBe(OP1.rpc); // op1 back at the front (flag cleared)
  });
});

describe("read-failover — submit path (mesh_submitTx) is UNCHANGED (Part B)", () => {
  it("mesh_submitTx does NOT fail over on a bare-transient error — throws at op1", async () => {
    const { order } = installFetch({
      [OP1.rpc]: { kind: "error", code: -32047, message: "upstream unavailable: consensus: down" },
      [OP2.rpc]: { kind: "result", result: "0xshouldNotReach" },
      [OP3.rpc]: { kind: "result", result: "0xshouldNotReach" },
    });
    const err = await testnetJsonRpc("mesh_submitTx", ["0xraw"]).then(
      () => null,
      (e) => e as Error & { code?: number },
    );
    expect(err?.code).toBe(-32047);
    expect(order).toEqual([OP1.rpc]); // submit stays single-shot (Part A is reads-only)
  });

  it("mesh_submitTx does NOT reorder by the degraded map (raw override order)", async () => {
    // Degrade op1 via a READ failover first.
    installFetch({
      [OP1.rpc]: { kind: "error", code: -32046, message: "x" },
      [OP2.rpc]: { kind: "result", result: "0xr" },
      [OP3.rpc]: { kind: "result", result: "0xr" },
    });
    await testnetJsonRpc("lyth_txStatus", ["0x1"]); // op1 degraded

    // A submit must still dial op1 FIRST (raw order), unaffected by D2.
    const { order } = installFetch({
      [OP1.rpc]: { kind: "result", result: "0xsubmitEcho" },
      [OP2.rpc]: { kind: "result", result: "0xr" },
      [OP3.rpc]: { kind: "result", result: "0xr" },
    });
    const r = await testnetJsonRpc<string>("mesh_submitTx", ["0xraw"]);
    expect(r.via).toBe("operator-1");
    expect(order[0]).toBe(OP1.rpc);
  });
});

describe("read-failover — operator set/order honored (override-defined)", () => {
  it("failover iterates exactly the getActiveOperators() set/order", async () => {
    // A custom 2-op set in a specific order; op-a errors, op-b answers.
    const A = { name: "op-a", region: "a", rpc: "http://a.example" };
    const B = { name: "op-b", region: "b", rpc: "http://b.example" };
    vi.mocked(getActiveOperators).mockReturnValue([A, B]);
    const { order } = installFetch({
      [A.rpc]: { kind: "error", code: -32046, message: "x" },
      [B.rpc]: { kind: "result", result: "0xb" },
    });
    const r = await testnetJsonRpc<string>("lyth_txStatus", ["0x1"]);
    expect(r.via).toBe("op-b");
    expect(order).toEqual([A.rpc, B.rpc]); // exactly the mocked set, in order
  });
});
