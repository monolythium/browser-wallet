import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OperatorRiskWire } from "../shared/audit-followup-types.js";

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
  readOperatorRisk,
  DEFAULT_OPERATOR_RISK_AUTHORITY,
  DEFAULT_OPERATOR_RISK_WINDOW_ROUNDS,
} = await import("./operator-risk-client.js");
const { deriveOperatorRiskTier } = await import("../shared/audit-followup-types.js");

const HEALTHY: OperatorRiskWire = {
  schemaVersion: 1,
  authorityIndex: 0,
  dataHeight: 1_000,
  windowRounds: 200,
  missedRounds: 0,
  observedRounds: 200,
  missRateBps: 0,
  thresholdBps: 5_000,
  remainingHeadroomBps: 5_000,
  jailStatus: {
    jailed: false,
    tombstoned: false,
    jailedUntilHeight: 0,
    unjailCount: 0,
  },
  reasons: [],
};

beforeEach(() => {
  stub.responses = {};
  stub.errors = {};
  stub.calls = [];
});

describe("operator-risk-client / readOperatorRisk", () => {
  it("uses canonical defaults when no args given", async () => {
    stub.responses["lyth_operatorRisk"] = HEALTHY;
    await readOperatorRisk();
    expect(stub.calls[0]!.method).toBe("lyth_operatorRisk");
    expect(stub.calls[0]!.params).toEqual([
      DEFAULT_OPERATOR_RISK_AUTHORITY,
      DEFAULT_OPERATOR_RISK_WINDOW_ROUNDS,
    ]);
  });

  it("honours explicit authorityIndex + windowRounds", async () => {
    stub.responses["lyth_operatorRisk"] = HEALTHY;
    await readOperatorRisk({ authorityIndex: 4, windowRounds: 500 });
    expect(stub.calls[0]!.params).toEqual([4, 500]);
  });

  it("clamps negative / zero / non-int args back to defaults", async () => {
    stub.responses["lyth_operatorRisk"] = HEALTHY;
    await readOperatorRisk({ authorityIndex: -2, windowRounds: 0 });
    expect(stub.calls[0]!.params).toEqual([
      DEFAULT_OPERATOR_RISK_AUTHORITY,
      DEFAULT_OPERATOR_RISK_WINDOW_ROUNDS,
    ]);
  });

  it("falls back to mock-not-deployed on -32601", async () => {
    stub.errors["lyth_operatorRisk"] = {
      code: -32601,
      message: "method not found",
    };
    const out = await readOperatorRisk({ authorityIndex: 2 });
    expect(out.kind).toBe("mock-not-deployed");
    if (out.kind === "mock-not-deployed") {
      expect(out.data.authorityIndex).toBe(2);
    }
  });

  it("falls back to mock-error on schema-invalid response", async () => {
    stub.responses["lyth_operatorRisk"] = { schemaVersion: 1 };
    const out = await readOperatorRisk();
    expect(out.kind).toBe("mock-error");
  });
});

describe("operator-risk-client / deriveOperatorRiskTier", () => {
  it("returns ok on a healthy operator", () => {
    expect(deriveOperatorRiskTier(HEALTHY)).toBe("ok");
  });

  it("returns warn when remaining headroom drops below threshold/4", () => {
    const warn: OperatorRiskWire = {
      ...HEALTHY,
      missRateBps: 4_000,
      remainingHeadroomBps: 1_000, // < 5000/4 = 1250
    };
    expect(deriveOperatorRiskTier(warn)).toBe("warn");
  });

  it("returns warn when chain emitted any reason code", () => {
    const reasoned: OperatorRiskWire = {
      ...HEALTHY,
      reasons: ["near_threshold"],
    };
    expect(deriveOperatorRiskTier(reasoned)).toBe("warn");
  });

  it("returns err when miss rate crosses the threshold", () => {
    const over: OperatorRiskWire = {
      ...HEALTHY,
      missRateBps: 6_000,
      thresholdBps: 5_000,
      remainingHeadroomBps: 0,
    };
    expect(deriveOperatorRiskTier(over)).toBe("err");
  });

  it("returns err when the operator is jailed", () => {
    const jailed: OperatorRiskWire = {
      ...HEALTHY,
      jailStatus: {
        jailed: true,
        tombstoned: false,
        jailedUntilHeight: 999,
        unjailCount: 1,
      },
    };
    expect(deriveOperatorRiskTier(jailed)).toBe("err");
  });

  it("returns err when the operator is tombstoned", () => {
    const tomb: OperatorRiskWire = {
      ...HEALTHY,
      jailStatus: {
        jailed: false,
        tombstoned: true,
        jailedUntilHeight: 0,
        unjailCount: 2,
      },
    };
    expect(deriveOperatorRiskTier(tomb)).toBe("err");
  });

  it("treats absent jail status as ok (defers to miss-rate)", () => {
    const absent: OperatorRiskWire = {
      ...HEALTHY,
      jailStatus: { reason: "no jail registry wired" },
    };
    expect(deriveOperatorRiskTier(absent)).toBe("ok");
  });

  it("tolerates zero threshold without divide-by-zero", () => {
    const zero: OperatorRiskWire = {
      ...HEALTHY,
      thresholdBps: 0,
      remainingHeadroomBps: 0,
    };
    expect(deriveOperatorRiskTier(zero)).toBe("ok");
  });
});
