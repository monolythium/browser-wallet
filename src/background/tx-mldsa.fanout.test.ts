// Phase 1 Part B — write fan-out (broadcastPlaintextTransaction).
//
// The SAME signed bytes are broadcast to up to 3 genesis-trusted operators in
// parallel; success = >=1 accepts or reports our own hash already-known. A single
// accepting-but-non-gossiping operator can no longer sink a send (the X1 mode).
// Re-broadcasting identical bytes is idempotent by tx hash (chain dedupes ->
// DuplicateKnown), so this cannot double-spend. Mocked operators, no live chain.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const OP1 = { name: "operator-1", region: "a", rpc: "http://op1.example" };
const OP2 = { name: "operator-2", region: "b", rpc: "http://op2.example" };
const OP3 = { name: "operator-3", region: "c", rpc: "http://op3.example" };

vi.mock("./networks.js", () => ({
  getActiveOperators: vi.fn(() => [OP1, OP2, OP3]),
  verifyOperatorGenesis: vi.fn(async () => true),
  allActiveOperatorsDefinitivelyUntrusted: vi.fn(() => false),
  classifyNoOperatorReason: vi.fn(() => "unreachable"),
}));
vi.mock("@monolythium/core-sdk/crypto", () => ({ buildPlaintextSubmission: vi.fn() }));
vi.mock("./keystore-mldsa.js", () => ({
  getUnlockedBackendV4: () => ({}),
  getActiveVaultIdV4: vi.fn(() => "v1"),
}));

import { broadcastPlaintextTransaction, bytesMayBeLive } from "./tx-mldsa.js";
import { getActiveOperators, verifyOperatorGenesis } from "./networks.js";

// A canonical 32-byte hash the wallet computed locally; an operator must echo
// exactly this for a clean accept.
const EXPECTED = "0x" + "ab".repeat(32);
const WIRE = "0xcafef00d";
const wrapped = (inner: string) => `upstream unavailable: mempool: ${inner}`;

type Outcome =
  | { kind: "accept" } // echoes EXPECTED
  | { kind: "echo"; hash: string } // echoes a (possibly wrong) hash
  | { kind: "error"; code?: number | undefined; message?: string | undefined }
  | { kind: "transport" };

function respond(o: Outcome) {
  if (o.kind === "transport") return { ok: false, status: 503, json: async () => ({}) };
  const payload =
    o.kind === "accept"
      ? { jsonrpc: "2.0", id: 1, result: EXPECTED }
      : o.kind === "echo"
        ? { jsonrpc: "2.0", id: 1, result: o.hash }
        : { jsonrpc: "2.0", id: 1, error: { code: o.code, message: o.message ?? "err" } };
  return { ok: true, status: 200, json: async () => payload };
}

function installFetch(byUrl: Record<string, Outcome>): { order: string[] } {
  const order: string[] = [];
  globalThis.fetch = vi.fn(async (url: unknown) => {
    const u = String(url);
    order.push(u);
    const o = byUrl[u];
    if (o === undefined) throw new TypeError(`unexpected url ${u}`);
    return respond(o);
  }) as unknown as typeof fetch;
  return { order };
}

const originalFetch = globalThis.fetch;
beforeEach(() => {
  vi.mocked(getActiveOperators).mockReturnValue([OP1, OP2, OP3]);
  vi.mocked(verifyOperatorGenesis).mockImplementation(async () => true);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

describe("broadcast fan-out — success semantics (D3/D4/D5)", () => {
  it("fans the SAME bytes to 3 operators in parallel; ≥1 accept → success", async () => {
    const { order } = installFetch({
      [OP1.rpc]: { kind: "accept" },
      [OP2.rpc]: { kind: "accept" },
      [OP3.rpc]: { kind: "accept" },
    });
    const r = await broadcastPlaintextTransaction(WIRE, EXPECTED);
    expect(r.txHash).toBe(EXPECTED);
    // Redundancy: the tx reached all 3 (so ≥1 honest gossiper exists) — the
    // single-accepting-but-non-gossiping operator can no longer sink it.
    expect(order.sort()).toEqual([OP1.rpc, OP2.rpc, OP3.rpc].sort());
  });

  it("stuck-tx: op1 accepts but op2 also receives it → still succeeds (redundant broadcast)", async () => {
    const { order } = installFetch({
      [OP1.rpc]: { kind: "accept" }, // this one would (sim) not gossip
      [OP2.rpc]: { kind: "accept" }, // this one does
      [OP3.rpc]: { kind: "transport" },
    });
    const r = await broadcastPlaintextTransaction(WIRE, EXPECTED);
    expect(r.txHash).toBe(EXPECTED);
    expect(order).toContain(OP2.rpc); // a second operator got the tx
  });

  it("duplicate-known for our OWN hash counts as success (idempotent resubmit)", async () => {
    installFetch({
      [OP1.rpc]: { kind: "error", code: -32047, message: wrapped("duplicate tx already known") },
      [OP2.rpc]: { kind: "error", code: -32047, message: wrapped("duplicate tx already known") },
      [OP3.rpc]: { kind: "error", code: -32047, message: wrapped("duplicate tx already known") },
    });
    const r = await broadcastPlaintextTransaction(WIRE, EXPECTED);
    expect(r.txHash).toBe(EXPECTED); // already pooled everywhere → success, no double-submit failure
  });

  it("nonce already consumed (already mined) → success", async () => {
    installFetch({
      [OP1.rpc]: { kind: "error", code: -32047, message: wrapped("nonce already consumed") },
      [OP2.rpc]: { kind: "transport" },
      [OP3.rpc]: { kind: "transport" },
    });
    const r = await broadcastPlaintextTransaction(WIRE, EXPECTED);
    expect(r.txHash).toBe(EXPECTED);
  });

  it("mailbox full from one op but another accepts → success", async () => {
    installFetch({
      [OP1.rpc]: { kind: "error", code: -32047, message: wrapped("mailbox full") },
      [OP2.rpc]: { kind: "accept" },
      [OP3.rpc]: { kind: "error", code: -32047, message: wrapped("mailbox full") },
    });
    const r = await broadcastPlaintextTransaction(WIRE, EXPECTED);
    expect(r.txHash).toBe(EXPECTED);
  });
});

describe("broadcast fan-out — failure semantics", () => {
  it("EVERY operator deterministically rejects (insufficient balance) → real failure surfaced", async () => {
    installFetch({
      [OP1.rpc]: { kind: "error", code: -32047, message: wrapped("insufficient balance") },
      [OP2.rpc]: { kind: "error", code: -32047, message: wrapped("insufficient balance") },
      [OP3.rpc]: { kind: "error", code: -32047, message: wrapped("insufficient balance") },
    });
    await expect(broadcastPlaintextTransaction(WIRE, EXPECTED)).rejects.toThrow(
      /insufficient balance/,
    );
  });

  it("mixed reject + transient (not ALL deterministic) → retryable, NOT the reject", async () => {
    installFetch({
      [OP1.rpc]: { kind: "error", code: -32047, message: wrapped("insufficient balance") },
      [OP2.rpc]: { kind: "transport" }, // one op was merely unavailable
      [OP3.rpc]: { kind: "error", code: -32047, message: wrapped("insufficient balance") },
    });
    const err = await broadcastPlaintextTransaction(WIRE, EXPECTED).then(
      () => null,
      (e) => e as Error,
    );
    expect(err?.message).toContain("no Monolythium Testnet operator accepted the broadcast");
    expect(err?.message).not.toContain("insufficient balance");
  });

  it("all operators transient/unavailable → retryable failure", async () => {
    installFetch({
      [OP1.rpc]: { kind: "transport" },
      [OP2.rpc]: { kind: "error", code: -32047, message: "upstream unavailable: p2p: down" }, // bare
      [OP3.rpc]: { kind: "transport" },
    });
    await expect(broadcastPlaintextTransaction(WIRE, EXPECTED)).rejects.toThrow(
      /accepted the broadcast/,
    );
  });
});

// ── Did the bytes reach anyone? ─────────────────────────────────────────────
//
// A caller that discards a signed transaction on failure needs to know whether
// the failure was a DECLINE or merely an absence of information. `transient` is
// returned only after the bytes were handed to `fetch` — a non-OK response and
// an unparseable body both prove the operator answered — so an admission
// followed by a proxy error is indistinguishable from never being taken.
// `reject` and `mailbox-full` are the operator saying it did not take them.
//
// Asserted via the exported predicate rather than the property name, so the
// marker's representation stays free to change.

async function failureOf(): Promise<unknown> {
  return broadcastPlaintextTransaction(WIRE, EXPECTED).then(
    () => null,
    (e: unknown) => e,
  );
}

describe("broadcast fan-out — whether a failure means the bytes are dead", () => {
  it("all transient → marked, because any of them may have been admitted", async () => {
    installFetch({
      [OP1.rpc]: { kind: "transport" },
      [OP2.rpc]: { kind: "transport" },
      [OP3.rpc]: { kind: "transport" },
    });
    expect(bytesMayBeLive(await failureOf())).toBe(true);
  });

  it("mixed reject + transient → marked; one unknown outcome is enough", async () => {
    installFetch({
      [OP1.rpc]: { kind: "error", code: -32047, message: wrapped("insufficient balance") },
      [OP2.rpc]: { kind: "transport" },
      [OP3.rpc]: { kind: "error", code: -32047, message: wrapped("insufficient balance") },
    });
    expect(bytesMayBeLive(await failureOf())).toBe(true);
  });

  it("a bare (non-mempool) error body is transient → marked", async () => {
    installFetch({
      [OP1.rpc]: { kind: "error", code: -32047, message: "upstream unavailable: p2p: down" },
      [OP2.rpc]: { kind: "error", code: -32047, message: "upstream unavailable: p2p: down" },
      [OP3.rpc]: { kind: "error", code: -32047, message: "upstream unavailable: p2p: down" },
    });
    expect(bytesMayBeLive(await failureOf())).toBe(true);
  });

  it("EVERY operator declines admission → NOT marked, the bytes are dead", async () => {
    installFetch({
      [OP1.rpc]: { kind: "error", code: -32047, message: wrapped("insufficient balance") },
      [OP2.rpc]: { kind: "error", code: -32047, message: wrapped("insufficient balance") },
      [OP3.rpc]: { kind: "error", code: -32047, message: wrapped("insufficient balance") },
    });
    expect(bytesMayBeLive(await failureOf())).toBe(false);
  });

  it("rejects + mailbox-full → NOT marked; backpressure IS a decline", async () => {
    // This reaches the same throw as the mixed case above, so it pins that the
    // marker follows the OUTCOME KIND and not merely which branch threw.
    installFetch({
      [OP1.rpc]: { kind: "error", code: -32047, message: wrapped("insufficient balance") },
      [OP2.rpc]: { kind: "error", code: -32047, message: wrapped("mailbox full") },
      [OP3.rpc]: { kind: "error", code: -32047, message: wrapped("insufficient balance") },
    });
    expect(bytesMayBeLive(await failureOf())).toBe(false);
  });

  it("no genesis-trusted operator → NOT marked; nothing was ever sent", async () => {
    vi.mocked(verifyOperatorGenesis).mockImplementation(async () => false);
    installFetch({});
    expect(bytesMayBeLive(await failureOf())).toBe(false);
  });

  it("an unmarked value reads as dead — the predicate never guesses", async () => {
    expect(bytesMayBeLive(new Error("plain"))).toBe(false);
    expect(bytesMayBeLive(null)).toBe(false);
    expect(bytesMayBeLive(undefined)).toBe(false);
    expect(bytesMayBeLive("a string")).toBe(false);
  });
});

describe("broadcast fan-out — echo-hash validation (never trust a foreign hash)", () => {
  it("a mismatching echo is ignored when another operator accepts cleanly", async () => {
    installFetch({
      [OP1.rpc]: { kind: "echo", hash: "0x" + "cd".repeat(32) }, // wrong hash
      [OP2.rpc]: { kind: "accept" },
      [OP3.rpc]: { kind: "transport" },
    });
    const r = await broadcastPlaintextTransaction(WIRE, EXPECTED);
    expect(r.txHash).toBe(EXPECTED);
    expect(r.via).toBe("operator-2");
  });

  it("ALL operators echo a mismatching hash → surfaces the loud mismatch error", async () => {
    installFetch({
      [OP1.rpc]: { kind: "echo", hash: "0x" + "cd".repeat(32) },
      [OP2.rpc]: { kind: "echo", hash: "0x" + "cd".repeat(32) },
      [OP3.rpc]: { kind: "echo", hash: "0x" + "cd".repeat(32) },
    });
    await expect(broadcastPlaintextTransaction(WIRE, EXPECTED)).rejects.toThrow(
      /does not match locally computed/,
    );
  });

  it("a non-canonical echo → surfaces the non-canonical error when all fail", async () => {
    installFetch({
      [OP1.rpc]: { kind: "echo", hash: "0x1234" },
      [OP2.rpc]: { kind: "echo", hash: "0x1234" },
      [OP3.rpc]: { kind: "echo", hash: "0x1234" },
    });
    await expect(broadcastPlaintextTransaction(WIRE, EXPECTED)).rejects.toThrow(
      /non-canonical tx hash/,
    );
  });
});

describe("broadcast fan-out — trusted set / breadth (override-defined, genesis-gated)", () => {
  it("skips genesis-untrusted operators; fans out to the trusted subset", async () => {
    // op1 fails the genesis pin → excluded; only op2/op3 receive the tx.
    vi.mocked(verifyOperatorGenesis).mockImplementation(async (rpc: string) => rpc !== OP1.rpc);
    const { order } = installFetch({
      [OP2.rpc]: { kind: "accept" },
      [OP3.rpc]: { kind: "accept" },
    });
    const r = await broadcastPlaintextTransaction(WIRE, EXPECTED);
    expect(r.txHash).toBe(EXPECTED);
    expect(order).not.toContain(OP1.rpc); // never routed to the untrusted operator
    expect(order.sort()).toEqual([OP2.rpc, OP3.rpc].sort());
  });

  it("caps the fan-out at breadth 3 even with a larger fleet", async () => {
    const OPS = [OP1, OP2, OP3, { name: "operator-4", region: "d", rpc: "http://op4.example" }, { name: "operator-5", region: "e", rpc: "http://op5.example" }];
    vi.mocked(getActiveOperators).mockReturnValue(OPS);
    const { order } = installFetch(Object.fromEntries(OPS.map((o) => [o.rpc, { kind: "accept" } as Outcome])));
    const r = await broadcastPlaintextTransaction(WIRE, EXPECTED);
    expect(r.txHash).toBe(EXPECTED);
    expect(order.length).toBe(3); // only the first 3 trusted operators, not all 5
  });

  it("fans out to ALL when the trusted set is smaller than the breadth", async () => {
    vi.mocked(getActiveOperators).mockReturnValue([OP1, OP2]);
    const { order } = installFetch({ [OP1.rpc]: { kind: "accept" }, [OP2.rpc]: { kind: "accept" } });
    const r = await broadcastPlaintextTransaction(WIRE, EXPECTED);
    expect(r.txHash).toBe(EXPECTED);
    expect(order.length).toBe(2);
  });

  it("no genesis-trusted operator → throws (never routes a tx onto an untrusted ledger)", async () => {
    vi.mocked(verifyOperatorGenesis).mockImplementation(async () => false);
    installFetch({}); // no fetch should be issued
    await expect(broadcastPlaintextTransaction(WIRE, EXPECTED)).rejects.toThrow();
  });
});
