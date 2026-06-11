// Unit coverage for testnetJsonRpc's body.error stamping. Two cases
// pin the asymmetry between RPC-level rejects (which stamp method +
// via + code onto the thrown error) and transport-level failures
// (which propagate unstamped after exhausting the operator list).
//
// The popup's method-aware ErrorView in Send.tsx
// depends on the body.error branch carrying the method that threw;
// these tests are the regression-catcher that pins that contract.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub getActiveOperators to a single deterministic entry. With a
// real list the post-regenesis defaults (operator-1 through operator-6)
// would drive which operator name lands in err.via; mocking lets the
// assertion be exact regardless of future default-list edits.
// verifyOperatorGenesis is stubbed to always-true: this suite tests
// the RPC dispatch error-stamping, not the genesis-pin path
// (covered separately via verifyOperatorGenesis unit tests).
// vi.mock is hoisted above the static import below.
vi.mock("./networks.js", () => ({
  getActiveOperators: () => [
    { name: "operator-test", region: "x", rpc: "http://test.example" },
  ],
  verifyOperatorGenesis: async () => true,
}));

// Canonical-hash threading needs the SDK submission builder + keystore
// stubbed: the wallet must surface the SDK's `innerTxHashHex` (the canonical
// inner-tx hash the chain indexes). Only the runtime export
// (buildPlaintextSubmission) is mocked; the other crypto imports in
// tx-mldsa.ts are type-only and erased.
const CANONICAL_TX_HASH =
  CANONICAL_INNER_TX_HASH;

const PLAINTEXT_SIGNED_TX_WIRE_HEX = "0xcafef00d";

vi.mock("@monolythium/core-sdk/crypto", () => ({
  // SDK 0.3.11 plaintext builder — signs over the canonical sighash and
  // returns the bincode `SignedTransaction` wire bytes + canonical hashes.
  buildPlaintextSubmission: vi.fn(() => ({
    signedTxWireHex: PLAINTEXT_SIGNED_TX_WIRE_HEX,
    innerSighashHex: "0xsighash",
    innerTxHashHex: CANONICAL_TX_HASH,
    innerWireBytes: 4,
  })),
}));

vi.mock("./keystore-mldsa.js", () => ({
  getUnlockedBackendV4: () => ({}),
  // NN-01: the builders assert getActiveVaultIdV4() === boundVaultId before the
  // backend read; default it to the id the happy-path tests pass ("v1"). A
  // vi.fn so the TOCTOU test can override it to a mismatching id.
  getActiveVaultIdV4: vi.fn(() => "v1"),
}));

import {
  testnetJsonRpc,
  submitPlaintextMlDsaTx,
  buildPlaintextSubmission,
  broadcastPlaintextTransaction,
} from "./tx-mldsa.js";
import { buildPlaintextSubmission as sdkBuildPlaintextSubmission } from "@monolythium/core-sdk/crypto";
import { getActiveVaultIdV4 } from "./keystore-mldsa.js";
import { CANONICAL_INNER_TX_HASH } from "../shared/__fixtures__/golden.js";

describe("testnetJsonRpc — method/via/code stamping", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("body.error stamps method + via + code on the thrown error", async () => {
    // Duck-typed Response — testnetJsonRpc only reads .ok, .status,
    // and .json(). Avoids depending on globalThis.Response availability
    // in the Node test env.
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32032, message: "decryption failed" },
      }),
    })) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await testnetJsonRpc("lyth_getEncryptionKey", []);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error & {
      code?: number;
      via?: string;
      method?: string;
    };
    expect(err.code).toBe(-32032);
    expect(err.via).toBe("operator-test");
    expect(err.method).toBe("lyth_getEncryptionKey");
    expect(err.message).toBe("decryption failed");
  });

  it("transport-only failure throws WITHOUT method/via/code stamping", async () => {
    // fetch itself rejects — the body.error branch never fires, so the
    // function falls through to the post-loop `throw lastTransportErr`
    // and that error has no stamps.
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("network unreachable");
    }) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await testnetJsonRpc("lyth_getEncryptionKey", []);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error & {
      code?: number;
      via?: string;
      method?: string;
    };
    // Intentional asymmetry: transport failures don't carry attribution
    // because there's no chain-side response to attribute them to.
    expect(err.code).toBeUndefined();
    expect(err.via).toBeUndefined();
    expect(err.method).toBeUndefined();
  });
});

describe("testnetJsonRpc — per-call timeout (opts.timeoutMs)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("opts.timeoutMs aborts a hung fetch → transport failure → throws", async () => {
    // fetch never resolves on its own; it rejects ONLY when the
    // AbortController's signal fires, proving the timeout wiring drives it.
    globalThis.fetch = vi.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    ) as unknown as typeof fetch;

    // Single mocked operator → the abort exhausts the list → it throws.
    await expect(
      testnetJsonRpc("eth_getTransactionReceipt", [], { timeoutMs: 20 }),
    ).rejects.toThrow();
  });

  it("without opts.timeoutMs no abort signal is passed (back-compat) and resolves", async () => {
    let capturedSignal: unknown = "unset";
    globalThis.fetch = vi.fn(
      async (_url: unknown, init?: { signal?: unknown }) => {
        capturedSignal = init?.signal;
        return {
          ok: true,
          status: 200,
          json: async () => ({ jsonrpc: "2.0", id: 1, result: "0xok" }),
        };
      },
    ) as unknown as typeof fetch;

    const r = await testnetJsonRpc<string>("eth_blockNumber", []);
    expect(r.result).toBe("0xok");
    // No timeoutMs ⇒ no AbortController ⇒ no signal key on the fetch init.
    expect(capturedSignal).toBeUndefined();
  });
});

describe("submitPlaintextMlDsaTx — default plaintext path (mesh_submitTx)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // The plaintext path makes exactly one RPC: mesh_submitTx, which echoes
  // the canonical 32-byte native tx hash on admission. We capture the
  // method so the test proves the DEFAULT submit hits the plaintext API
  // (NOT lyth_submitEncrypted) and validates the echoed hash.
  function installPlaintextFetch(echoHash: string): { methods: string[] } {
    const methods: string[] = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        method?: string;
      };
      if (typeof body.method === "string") methods.push(body.method);
      return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: "2.0", id: 1, result: echoHash }),
      };
    }) as unknown as typeof fetch;
    return { methods };
  }

  it("submits via mesh_submitTx and returns the node-validated canonical tx hash", async () => {
    const captured = installPlaintextFetch(CANONICAL_TX_HASH);
    const r = await submitPlaintextMlDsaTx({
      to: "0x0102030405060708090a0b0c0d0e0f1011121314",
      value: "0xf4240",
      gas: "0x7530",
      gasPrice: "0x7d0",
      nonce: "0x0",
      chainIdHex: "0x10F2C",
    }, "v1");
    expect(r.txHash).toBe(CANONICAL_TX_HASH);
    expect(r.via).toBe("operator-test");
    // The DEFAULT path is plaintext: mesh_submitTx, never lyth_submitEncrypted.
    expect(captured.methods).toContain("mesh_submitTx");
    expect(captured.methods).not.toContain("lyth_submitEncrypted");
  });

  it("rejects loud when the node echoes a hash that doesn't match the locally computed one", async () => {
    const wrong =
      "0x" + "ab".repeat(32); // 32 bytes but not CANONICAL_TX_HASH
    installPlaintextFetch(wrong);
    await expect(broadcastPlaintextTransaction("0xcafe", CANONICAL_TX_HASH)).rejects.toThrow(
      /does not match locally computed/,
    );
  });

  it("rejects a non-canonical (non-32-byte) echoed hash", async () => {
    installPlaintextFetch("0x1234");
    await expect(broadcastPlaintextTransaction("0xcafe", CANONICAL_TX_HASH)).rejects.toThrow(
      /non-canonical tx hash/,
    );
  });
});

describe("NN-01 — vault-binding fail-closed assert (plaintext builder)", () => {
  const TX_REQ = {
    to: "0x0102030405060708090a0b0c0d0e0f1011121314",
    value: "0xf4240",
    gas: "0x7530",
    gasPrice: "0x7d0",
    nonce: "0x0",
    chainIdHex: "0x10F2C",
  };
  beforeEach(() => {
    // Reset the swap-simulating mock + clear SDK-signer call history accumulated
    // by other tests in this file, so not.toHaveBeenCalled() reflects only this
    // test (the SDK builder mock is module-shared).
    vi.mocked(getActiveVaultIdV4).mockReturnValue("v1");
    vi.mocked(sdkBuildPlaintextSubmission).mockClear();
  });

  it("aborts BEFORE signing when the active vault != boundVaultId (fail-closed)", async () => {
    // Simulate a concurrent selectActiveVaultV4 that swapped the active vault
    // to "v2" while the send was bound to "v1".
    vi.mocked(getActiveVaultIdV4).mockReturnValue("v2");
    await expect(
      buildPlaintextSubmission({ txReq: TX_REQ, boundVaultId: "v1" }),
    ).rejects.toThrow(/active account changed/);
    // The SDK signer was NEVER reached — nothing was signed.
    expect(sdkBuildPlaintextSubmission).not.toHaveBeenCalled();
  });

  it("signs when the active vault == boundVaultId (no false abort)", async () => {
    vi.mocked(getActiveVaultIdV4).mockReturnValue("v1");
    await buildPlaintextSubmission({ txReq: TX_REQ, boundVaultId: "v1" });
    expect(sdkBuildPlaintextSubmission).toHaveBeenCalledTimes(1);
  });
});
