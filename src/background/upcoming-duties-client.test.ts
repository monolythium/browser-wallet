import { describe, it, expect, vi, beforeEach } from "vitest";
import type { UpcomingDuties } from "../shared/audit-followup-types.js";

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
  readUpcomingDuties,
  DEFAULT_UPCOMING_DUTIES_AUTHORITY,
  DEFAULT_UPCOMING_DUTIES_HORIZON_ROUNDS,
} = await import("./upcoming-duties-client.js");

const VALID: UpcomingDuties = {
  schemaVersion: 1,
  authorityIndex: 0,
  currentRound: 1_000,
  horizonRounds: 1_000,
  committee: {
    authoritySetSize: 50,
    quorumThreshold: 34,
    recoveryFloor: 17,
    authorityInCurrentSet: true,
  },
  duties: {
    attestation: { startRound: 1_001, endRound: 2_000, kind: "every_round" },
    blockProduction: { reason: "starfish_c_unpredictable" },
    sync: { reason: "in_sync" },
    keyRotation: { nextRound: 5_000, epochLengthRounds: 4_000 },
  },
};

beforeEach(() => {
  stub.responses = {};
  stub.errors = {};
  stub.calls = [];
});

describe("upcoming-duties-client / readUpcomingDuties", () => {
  it("uses canonical defaults when no args given", async () => {
    stub.responses["lyth_upcomingDuties"] = VALID;
    await readUpcomingDuties();
    expect(stub.calls[0]!.method).toBe("lyth_upcomingDuties");
    expect(stub.calls[0]!.params).toEqual([
      DEFAULT_UPCOMING_DUTIES_AUTHORITY,
      DEFAULT_UPCOMING_DUTIES_HORIZON_ROUNDS,
    ]);
  });

  it("honours explicit args", async () => {
    stub.responses["lyth_upcomingDuties"] = VALID;
    await readUpcomingDuties({ authorityIndex: 5, horizonRounds: 200 });
    expect(stub.calls[0]!.params).toEqual([5, 200]);
  });

  it("clamps negative / zero / non-int args to defaults", async () => {
    stub.responses["lyth_upcomingDuties"] = VALID;
    await readUpcomingDuties({ authorityIndex: -3, horizonRounds: 0 });
    expect(stub.calls[0]!.params).toEqual([
      DEFAULT_UPCOMING_DUTIES_AUTHORITY,
      DEFAULT_UPCOMING_DUTIES_HORIZON_ROUNDS,
    ]);
  });

  it("returns live on a valid response", async () => {
    stub.responses["lyth_upcomingDuties"] = VALID;
    const out = await readUpcomingDuties();
    expect(out.kind).toBe("live");
    if (out.kind === "live") expect(out.data).toEqual(VALID);
  });

  it("returns live when keyRotation is in absent branch", async () => {
    const absentRot: UpcomingDuties = {
      ...VALID,
      duties: { ...VALID.duties, keyRotation: { reason: "not_due" } },
    };
    stub.responses["lyth_upcomingDuties"] = absentRot;
    const out = await readUpcomingDuties();
    expect(out.kind).toBe("live");
  });

  it("falls back to mock-not-deployed on -32601", async () => {
    stub.errors["lyth_upcomingDuties"] = {
      code: -32601,
      message: "method not found",
    };
    const out = await readUpcomingDuties({ authorityIndex: 1 });
    expect(out.kind).toBe("mock-not-deployed");
    if (out.kind === "mock-not-deployed") {
      expect(out.data.authorityIndex).toBe(1);
    }
  });

  it("falls back to mock-error on schema-invalid response", async () => {
    stub.responses["lyth_upcomingDuties"] = { schemaVersion: 1 };
    const out = await readUpcomingDuties();
    expect(out.kind).toBe("mock-error");
  });
});
