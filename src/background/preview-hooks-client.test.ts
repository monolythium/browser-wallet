import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TransactionHookPreview } from "../shared/audit-followup-types.js";

interface RpcStub {
  responses: Record<string, unknown>;
  errors: Record<string, { code?: number; message: string }>;
  calls: Array<{ method: string; params: unknown[] }>;
}

const stub: RpcStub = { responses: {}, errors: {}, calls: [] };

vi.mock("./tx-mldsa.js", () => ({
  testnetJsonRpc: vi.fn(async (method: string, params: unknown[]) => {
    stub.calls.push({ method, params });
    if (stub.errors[method] !== undefined) {
      const e = stub.errors[method]!;
      const err = new Error(e.message) as Error & { code?: number };
      if (e.code !== undefined) err.code = e.code;
      throw err;
    }
    if (stub.responses[method] !== undefined) {
      return { result: stub.responses[method], via: "test-operator" };
    }
    throw new Error(`no seed for ${method}`);
  }),
}));

const {
  previewTransactionHooks,
  buildCallRequest,
  PREVIEW_HOOKS_PLACEHOLDER,
} = await import("./preview-hooks-client.js");

const VALID_PREVIEW: TransactionHookPreview = {
  schemaVersion: 1,
  wouldReject: false,
  warnings: [
    { code: "fee_spike", severity: "warning", message: "fee is 1.5x baseline" },
  ],
  spendingPolicy: {
    status: "ok",
    details: { policy_version: "v1", remaining: "999" },
  },
};

beforeEach(() => {
  stub.responses = {};
  stub.errors = {};
  stub.calls = [];
});

describe("preview-hooks-client / buildCallRequest", () => {
  it("includes only the fields the wallet supplied", () => {
    expect(buildCallRequest({ to: "0xdead" })).toEqual({ to: "0xdead" });
    expect(
      buildCallRequest({
        from: "0xfeed",
        to: "0xdead",
        valueWeiHex: "0x1",
        data: "0xabcd",
      }),
    ).toEqual({ from: "0xfeed", to: "0xdead", value: "0x1", data: "0xabcd" });
  });

  it("renames valueWeiHex to value on the wire (eth_call shape)", () => {
    expect(buildCallRequest({ to: "0xdead", valueWeiHex: "0xff" })).toEqual({
      to: "0xdead",
      value: "0xff",
    });
  });
});

describe("preview-hooks-client / previewTransactionHooks", () => {
  it("returns live on a valid chain response", async () => {
    stub.responses["lyth_previewTransactionHooks"] = VALID_PREVIEW;
    const out = await previewTransactionHooks({
      from: "0xfeed",
      to: "0xdead",
      valueWeiHex: "0x100",
    });
    expect(out.kind).toBe("live");
    if (out.kind === "live") {
      expect(out.data).toEqual(VALID_PREVIEW);
      expect(out.via).toBe("lyth_previewTransactionHooks");
    }
  });

  it("passes the correct JSON-RPC params", async () => {
    stub.responses["lyth_previewTransactionHooks"] = VALID_PREVIEW;
    await previewTransactionHooks({
      from: "0xfeed",
      to: "0xdead",
      valueWeiHex: "0x10",
      data: "0x1234",
    });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.method).toBe("lyth_previewTransactionHooks");
    expect(stub.calls[0]!.params).toEqual([
      { from: "0xfeed", to: "0xdead", value: "0x10", data: "0x1234" },
    ]);
  });

  it("falls back to mock-not-deployed on -32601 (method not found)", async () => {
    stub.errors["lyth_previewTransactionHooks"] = {
      code: -32601,
      message: "method not found",
    };
    const out = await previewTransactionHooks({ to: "0xdead" });
    expect(out.kind).toBe("mock-not-deployed");
    if (out.kind === "mock-not-deployed") {
      expect(out.data).toEqual(PREVIEW_HOOKS_PLACEHOLDER);
      expect(out.reason).toContain("method not found");
    }
  });

  it("falls back to mock-not-deployed on any thrown error (notLiveAs is set)", async () => {
    // withChainFallback's notLiveAs="not-deployed" routes ALL throws to
    // mock-not-deployed, not just -32601. This documents that — the
    // wallet hides the section graciously on transport errors too.
    stub.errors["lyth_previewTransactionHooks"] = {
      code: -32000,
      message: "operator overloaded",
    };
    const out = await previewTransactionHooks({ to: "0xdead" });
    expect(out.kind).toBe("mock-not-deployed");
  });

  it("falls back to mock-error on a schema-invalid response", async () => {
    stub.responses["lyth_previewTransactionHooks"] = {
      schemaVersion: 1,
      // missing wouldReject + warnings + spendingPolicy
    };
    const out = await previewTransactionHooks({ to: "0xdead" });
    expect(out.kind).toBe("mock-error");
    if (out.kind === "mock-error") {
      expect(out.reason).toContain("shape validation");
    }
  });
});
