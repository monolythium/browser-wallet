import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OperatorSigningActivity } from "../shared/audit-followup-types.js";

interface RpcStub {
  responses: Record<string, unknown>;
  errors: Record<string, { code?: number; message: string }>;
  calls: Array<{ method: string; params: unknown[] }>;
}

const stub: RpcStub = { responses: {}, errors: {}, calls: [] };

vi.mock("./tx-mldsa.js", () => ({
  sprintnetJsonRpc: vi.fn(async (method: string, params: unknown[]) => {
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
  readSigningActivity,
  DEFAULT_SIGNING_ACTIVITY_AUTHORITY,
  DEFAULT_SIGNING_ACTIVITY_LIMIT,
} = await import("./signing-activity-client.js");

const VALID_ACTIVITY: OperatorSigningActivity = {
  schemaVersion: 1,
  authorityIndex: 0,
  currentRound: 1_234,
  limit: 20,
  supportedStatuses: ["signed", "delayed", "offline", "maintenance"],
  reservedStatuses: [
    {
      code: "delayed",
      missingPrimitive: "round-clock",
      responsibleSubsystem: "consensus-starfish",
      description: "Round-clock not yet wired",
    },
  ],
  entries: [
    { round: 1_234, status: "signed", signersCount: 12 },
    { round: 1_233, status: "signed", signersCount: 11 },
  ],
};

beforeEach(() => {
  stub.responses = {};
  stub.errors = {};
  stub.calls = [];
});

describe("signing-activity-client / readSigningActivity", () => {
  it("uses canonical defaults when no args given", async () => {
    stub.responses["lyth_signingActivity"] = VALID_ACTIVITY;
    await readSigningActivity();
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.method).toBe("lyth_signingActivity");
    expect(stub.calls[0]!.params).toEqual([
      DEFAULT_SIGNING_ACTIVITY_AUTHORITY,
      DEFAULT_SIGNING_ACTIVITY_LIMIT,
    ]);
  });

  it("honours an explicit authorityIndex + limit", async () => {
    stub.responses["lyth_signingActivity"] = VALID_ACTIVITY;
    await readSigningActivity({ authorityIndex: 7, limit: 50 });
    expect(stub.calls[0]!.params).toEqual([7, 50]);
  });

  it("clamps negative / zero / non-int args to canonical defaults", async () => {
    stub.responses["lyth_signingActivity"] = VALID_ACTIVITY;
    await readSigningActivity({ authorityIndex: -1, limit: 0 });
    expect(stub.calls[0]!.params).toEqual([
      DEFAULT_SIGNING_ACTIVITY_AUTHORITY,
      DEFAULT_SIGNING_ACTIVITY_LIMIT,
    ]);
  });

  it("returns live on a valid response", async () => {
    stub.responses["lyth_signingActivity"] = VALID_ACTIVITY;
    const out = await readSigningActivity();
    expect(out.kind).toBe("live");
    if (out.kind === "live") {
      expect(out.data).toEqual(VALID_ACTIVITY);
    }
  });

  it("falls back to mock-not-deployed on -32601", async () => {
    stub.errors["lyth_signingActivity"] = {
      code: -32601,
      message: "method not found",
    };
    const out = await readSigningActivity({ authorityIndex: 3, limit: 10 });
    expect(out.kind).toBe("mock-not-deployed");
    if (out.kind === "mock-not-deployed") {
      // Mock preserves the requested args so the UI's "authority X" copy
      // matches what was asked.
      expect(out.data.authorityIndex).toBe(3);
      expect(out.data.limit).toBe(10);
    }
  });

  it("falls back to mock-error on shape-invalid response", async () => {
    stub.responses["lyth_signingActivity"] = {
      schemaVersion: 1,
      // missing nearly everything else
    };
    const out = await readSigningActivity();
    expect(out.kind).toBe("mock-error");
  });
});
