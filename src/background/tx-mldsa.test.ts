// Unit coverage for sprintnetJsonRpc's body.error stamping. Two cases
// pin the asymmetry between RPC-level rejects (which stamp method +
// via + code onto the thrown error) and transport-level failures
// (which propagate unstamped after exhausting the operator list).
//
// The popup's method-aware ErrorView in Send.tsx (Phase 4.3.1)
// depends on the body.error branch carrying the method that threw;
// these tests are the regression-catcher that pins that contract.

import { afterEach, describe, expect, it, vi } from "vitest";

// Stub getActiveOperators to a single deterministic entry. With a
// real list the post-regenesis defaults (operator-1 through operator-6)
// would drive which operator name lands in err.via; mocking lets the
// assertion be exact regardless of future default-list edits.
// verifyOperatorGenesis is stubbed to always-true: this suite tests
// the RPC dispatch error-stamping, not the GAP #11 genesis-pin path
// (covered separately via verifyOperatorGenesis unit tests).
// vi.mock is hoisted above the static import below.
vi.mock("./networks.js", () => ({
  getActiveOperators: () => [
    { name: "operator-test", region: "x", rpc: "http://test.example" },
  ],
  verifyOperatorGenesis: async () => true,
}));

// Canonical-hash threading (C1) needs the SDK submission builder + keystore
// stubbed: the wallet must surface the SDK's `innerTxHashHex` (the canonical
// inner-tx hash the chain indexes), NOT the `lyth_submitEncrypted` envelope
// hash. Only the runtime export (buildEncryptedSubmission) is mocked; the
// other crypto imports in tx-mldsa.ts are type-only and erased.
const CANONICAL_TX_HASH =
  "0x36467a4360a4225ea31c348d0583e505a3d2f15b46a6d0a791163d2060e868c3";
const ENVELOPE_SUBMISSION_HASH =
  "0x7bcde98eb1820654644c07e33627f772ba9df56b189508af97c26c82268d1ba4";

vi.mock("@monolythium/core-sdk/crypto", () => ({
  buildEncryptedSubmission: vi.fn(async () => ({
    envelopeWireHex: "0xdeadbeef",
    innerSighashHex: "0xsighash",
    innerTxHashHex: CANONICAL_TX_HASH,
    innerWireBytes: 4,
  })),
}));

vi.mock("./keystore-mldsa.js", () => ({
  getUnlockedBackendV4: () => ({}),
}));

import {
  sprintnetJsonRpc,
  submitEncryptedMlDsaTx,
  broadcastEncryptedEnvelope,
} from "./tx-mldsa.js";

describe("sprintnetJsonRpc — method/via/code stamping", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("body.error stamps method + via + code on the thrown error", async () => {
    // Duck-typed Response — sprintnetJsonRpc only reads .ok, .status,
    // and .json(). Avoids depending on globalThis.Response availability
    // in the Node test env.
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32049, message: "mempool: decryption failed" },
      }),
    })) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await sprintnetJsonRpc("lyth_getEncryptionKey", []);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error & {
      code?: number;
      via?: string;
      method?: string;
    };
    expect(err.code).toBe(-32049);
    expect(err.via).toBe("operator-test");
    expect(err.method).toBe("lyth_getEncryptionKey");
    expect(err.message).toBe("mempool: decryption failed");
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
      await sprintnetJsonRpc("lyth_getEncryptionKey", []);
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

describe("submitEncryptedMlDsaTx — canonical hash threading (C1)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // fetch answers both RPCs the submit path makes: lyth_getEncryptionKey
  // (so fetchSprintnetEncryptionKey resolves) and lyth_submitEncrypted
  // (returns the ENVELOPE/submission hash, which must NOT become txHash).
  function installFetch(): void {
    globalThis.fetch = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        method?: string;
      };
      let result: unknown = null;
      if (body.method === "lyth_getEncryptionKey") {
        result = { algo: "ml-kem-768", epoch: 1, encapsulationKey: "0x00" };
      } else if (body.method === "lyth_submitEncrypted") {
        result = ENVELOPE_SUBMISSION_HASH;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: "2.0", id: 1, result }),
      };
    }) as unknown as typeof fetch;
  }

  it("returns the SDK canonical innerTxHashHex as txHash, envelope hash as submissionHash", async () => {
    installFetch();
    const r = await submitEncryptedMlDsaTx({
      to: "0x0102030405060708090a0b0c0d0e0f1011121314",
      value: "0xf4240",
      gas: "0x7530",
      gasPrice: "0x7d0",
      nonce: "0x0",
      chainIdHex: "0x10F2C",
    });
    expect(r.txHash).toBe(CANONICAL_TX_HASH);
    expect(r.submissionHash).toBe(ENVELOPE_SUBMISSION_HASH);
    // The bug being fixed: the displayed hash must NOT be the envelope hash.
    expect(r.txHash).not.toBe(ENVELOPE_SUBMISSION_HASH);
  });

  it("broadcastEncryptedEnvelope surfaces the RPC result as submissionHash", async () => {
    installFetch();
    const b = await broadcastEncryptedEnvelope("0xdeadbeef");
    expect(b.submissionHash).toBe(ENVELOPE_SUBMISSION_HASH);
    expect(b.via).toBe("operator-test");
  });
});
