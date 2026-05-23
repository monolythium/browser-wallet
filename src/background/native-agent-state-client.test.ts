import { beforeEach, describe, expect, it, vi } from "vitest";

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

const { readNativeAgentState } = await import("./native-agent-state-client.js");
const {
  buildNativeAgentStateRpcFilter,
  validateNativeAgentStateResponse,
} = await import("../shared/native-agent-state.js");

const AGENT_STATE = {
  schemaVersion: 1,
  limit: 25,
  filters: {
    account: "mono1agentowner",
    includePolicySpends: true,
  },
  issuers: [
    {
      issuerId: `0x${"11".repeat(32)}`,
      issuer: "mono1agentowner",
      metadataHash: `0x${"1b".repeat(32)}`,
      updatedAtBlock: 45,
    },
  ],
  attestations: [
    {
      attestationId: `0x${"12".repeat(32)}`,
      issuerId: `0x${"11".repeat(32)}`,
      issuer: "mono1agentowner",
      subject: "mono1agentcontroller",
      schemaHash: `0x${"17".repeat(32)}`,
      payloadHash: `0x${"ee".repeat(32)}`,
      active: false,
      updatedAtBlock: 46,
    },
  ],
  consents: [
    {
      consentId: `0x${"13".repeat(32)}`,
      subject: "mono1agentcontroller",
      grantee: "mono1agentarbiter",
      scopeHash: `0x${"19".repeat(32)}`,
      expiresAt: 10_000,
      active: true,
      updatedAtBlock: 47,
    },
  ],
  services: [
    {
      serviceId: `0x${"14".repeat(32)}`,
      provider: "mono1agentprovider",
      categoryHash: `0x${"1a".repeat(32)}`,
      metadataHash: `0x${"1b".repeat(32)}`,
      active: true,
      updatedAtBlock: 48,
    },
  ],
  availability: [
    {
      provider: "mono1agentprovider",
      maxConcurrent: 8,
      openRequests: 2,
      paused: false,
      updatedAtBlock: 49,
    },
  ],
  arbiters: [
    {
      arbiterId: `0x${"15".repeat(32)}`,
      arbiter: "mono1agentarbiter",
      tier: 2,
      metadataHash: `0x${"1b".repeat(32)}`,
      updatedAtBlock: 50,
    },
  ],
  spendingPolicies: [
    {
      policyId: `0x${"aa".repeat(32)}`,
      owner: "mono1agentowner",
      controller: "mono1agentcontroller",
      assetId: `0x${"cc".repeat(32)}`,
      enabled: true,
      perActionLimit: "100",
      windowLimit: "500",
      windowSecs: 60,
      updatedAtBlock: 42,
    },
  ],
  policySpends: [
    {
      policyId: `0x${"aa".repeat(32)}`,
      controller: "mono1agentcontroller",
      assetId: `0x${"cc".repeat(32)}`,
      window: 7,
      amount: "25",
      spent: "125",
      updatedAtBlock: 43,
    },
  ],
  escrows: [
    {
      escrowId: `0x${"bb".repeat(32)}`,
      buyer: "mono1agentowner",
      provider: "mono1agentprovider",
      arbiter: "mono1agentarbiter",
      assetId: `0x${"cc".repeat(32)}`,
      amount: "1000",
      termsHash: `0x${"dd".repeat(32)}`,
      round: 2,
      buyerAccepted: true,
      providerAccepted: false,
      submittedPayloadHash: null,
      status: "accepted",
      resolution: null,
      lastActor: "mono1agentowner",
      createdAtBlock: 40,
      updatedAtBlock: 44,
    },
  ],
  reputationReviews: [
    {
      reviewId: `0x${"16".repeat(32)}`,
      reviewer: "mono1agentowner",
      subject: "mono1agentprovider",
      categoryId: 7,
      speedScore: 9,
      qualityScore: 8,
      communicationScore: 10,
      accuracyScore: 9,
      payloadHash: `0x${"ee".repeat(32)}`,
      updatedAtBlock: 51,
    },
  ],
  source: {
    indexerProvider: "native_agent_state",
    projection: "native_agent_state",
  },
};

beforeEach(() => {
  stub.responses = {};
  stub.errors = {};
  stub.calls = [];
});

describe("native-agent-state parsing", () => {
  it("preserves all native agent current-state row families", () => {
    expect(validateNativeAgentStateResponse(AGENT_STATE)).toEqual(AGENT_STATE);
  });

  it("accepts snake_case row arrays from REST-style envelopes", () => {
    const reputationReviews = [
      {
        review_id: `0x${"16".repeat(32)}`,
        reviewer: "mono1agentowner",
        subject: "mono1agentprovider",
        quality_score: 8,
        accuracy_score: 9,
      },
    ];
    const parsed = validateNativeAgentStateResponse({
      schemaVersion: 1,
      limit: 10,
      filters: {},
      issuers: AGENT_STATE.issuers,
      attestations: AGENT_STATE.attestations,
      consents: AGENT_STATE.consents,
      services: AGENT_STATE.services,
      availability: AGENT_STATE.availability,
      arbiters: AGENT_STATE.arbiters,
      reputation_reviews: reputationReviews,
      spending_policies: AGENT_STATE.spendingPolicies,
      policy_spends: AGENT_STATE.policySpends,
      escrows: AGENT_STATE.escrows,
      source: null,
    });

    expect(parsed?.issuers).toEqual(AGENT_STATE.issuers);
    expect(parsed?.attestations).toEqual(AGENT_STATE.attestations);
    expect(parsed?.consents).toEqual(AGENT_STATE.consents);
    expect(parsed?.services).toEqual(AGENT_STATE.services);
    expect(parsed?.availability).toEqual(AGENT_STATE.availability);
    expect(parsed?.arbiters).toEqual(AGENT_STATE.arbiters);
    expect(parsed?.reputationReviews).toEqual(reputationReviews);
    expect(parsed?.spendingPolicies).toEqual(AGENT_STATE.spendingPolicies);
    expect(parsed?.policySpends).toEqual(AGENT_STATE.policySpends);
    expect(parsed?.escrows).toEqual(AGENT_STATE.escrows);
  });

  it("defaults additive row families to empty arrays for legacy current-state responses", () => {
    const parsed = validateNativeAgentStateResponse({
      schemaVersion: 1,
      limit: 10,
      filters: {},
      spendingPolicies: AGENT_STATE.spendingPolicies,
      policySpends: AGENT_STATE.policySpends,
      escrows: AGENT_STATE.escrows,
      source: null,
    });

    expect(parsed).toMatchObject({
      issuers: [],
      attestations: [],
      consents: [],
      services: [],
      availability: [],
      arbiters: [],
      reputationReviews: [],
      spendingPolicies: AGENT_STATE.spendingPolicies,
      policySpends: AGENT_STATE.policySpends,
      escrows: AGENT_STATE.escrows,
    });
  });

  it("rejects malformed additive current-state rows", () => {
    expect(
      validateNativeAgentStateResponse({
        ...AGENT_STATE,
        issuers: [{ issuerId: `0x${"11".repeat(32)}`, metadata: new Date(0) }],
      }),
    ).toBeNull();
    expect(
      validateNativeAgentStateResponse({
        ...AGENT_STATE,
        reputationReviews: "not rows",
      }),
    ).toBeNull();
  });

  it("rejects envelopes without the current-state row families", () => {
    expect(validateNativeAgentStateResponse({ schemaVersion: 1, limit: 10 })).toBeNull();
  });

  it("builds a valid RPC filter without combining exact ids with account", () => {
    expect(
      buildNativeAgentStateRpcFilter({
        policyId: `0x${"aa".repeat(32)}`,
        account: "mono1agentowner",
        includePolicySpends: true,
        limit: 25,
      }),
    ).toEqual({
      policyId: `0x${"aa".repeat(32)}`,
      includePolicySpends: true,
      limit: 25,
    });
    expect(
      buildNativeAgentStateRpcFilter({
        escrowId: `0x${"bb".repeat(32)}`,
        includePolicySpends: true,
      }),
    ).toEqual({ escrowId: `0x${"bb".repeat(32)}` });
  });
});

describe("readNativeAgentState", () => {
  it("calls lyth_nativeAgentState and returns live current state", async () => {
    stub.responses["lyth_nativeAgentState"] = AGENT_STATE;

    const out = await readNativeAgentState({
      account: "mono1agentowner",
      includePolicySpends: true,
      limit: 25,
    });

    expect(stub.calls).toEqual([
      {
        method: "lyth_nativeAgentState",
        params: [
          {
            account: "mono1agentowner",
            includePolicySpends: true,
            limit: 25,
          },
        ],
      },
    ]);
    expect(out.kind).toBe("live");
    expect(out.data).toEqual(AGENT_STATE);
  });

  it("does not fabricate state when the chain method is absent", async () => {
    stub.errors["lyth_nativeAgentState"] = {
      code: -32601,
      message: "method not found",
    };

    const out = await readNativeAgentState();

    expect(out.kind).toBe("mock-not-deployed");
    expect(out.data).toBeNull();
  });

  it("does not fabricate state for malformed current-state responses", async () => {
    stub.responses["lyth_nativeAgentState"] = {
      schemaVersion: 1,
      limit: 10,
      spendingPolicies: [],
    };

    const out = await readNativeAgentState();

    expect(out.kind).toBe("mock-error");
    expect(out.data).toBeNull();
  });
});
