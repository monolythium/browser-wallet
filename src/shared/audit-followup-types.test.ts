import { describe, it, expect } from "vitest";
import {
  isTransactionHookPreview,
  isOperatorSigningActivity,
  isPublicServiceProbe,
  isUpcomingDuties,
  isKeyRotationAvailable,
  summarizeSigningActivity,
  KNOWN_SIGNING_ENTRY_STATUSES,
  type TransactionHookPreview,
  type OperatorSigningActivity,
  type PublicServiceProbe,
  type UpcomingDuties,
} from "./audit-followup-types.js";

describe("audit-followup-types — TransactionHookPreview shape", () => {
  const valid: TransactionHookPreview = {
    schemaVersion: 1,
    wouldReject: false,
    warnings: [
      { code: "fee_spike", severity: "warning", message: "fee is high" },
    ],
    spendingPolicy: {
      status: "ok",
      details: { policy_version: "v1" },
    },
  };

  it("accepts a minimal valid preview", () => {
    expect(isTransactionHookPreview(valid)).toBe(true);
  });

  it("accepts a preview with all optional spendingPolicy fields", () => {
    const full: TransactionHookPreview = {
      ...valid,
      spendingPolicy: {
        status: "rejected",
        reason: "daily_cap_exceeded",
        wireCode: 4032,
        message: "Daily transfer cap exceeded for this asset",
        details: { cap: "1000", remaining: "0" },
      },
    };
    expect(isTransactionHookPreview(full)).toBe(true);
  });

  it("accepts a preview with an empty warnings array", () => {
    expect(isTransactionHookPreview({ ...valid, warnings: [] })).toBe(true);
  });

  it("rejects when schemaVersion is missing", () => {
    const broken = { ...valid } as Record<string, unknown>;
    delete broken.schemaVersion;
    expect(isTransactionHookPreview(broken)).toBe(false);
  });

  it("rejects when wouldReject is a string", () => {
    expect(isTransactionHookPreview({ ...valid, wouldReject: "false" })).toBe(false);
  });

  it("rejects when warnings is not an array", () => {
    expect(isTransactionHookPreview({ ...valid, warnings: null })).toBe(false);
  });

  it("rejects when a warning is missing severity", () => {
    const broken = { ...valid, warnings: [{ code: "x", message: "y" }] };
    expect(isTransactionHookPreview(broken)).toBe(false);
  });

  it("rejects when spendingPolicy.details is missing", () => {
    const broken = {
      ...valid,
      spendingPolicy: { status: "ok" } as unknown as TransactionHookPreview["spendingPolicy"],
    };
    expect(isTransactionHookPreview(broken)).toBe(false);
  });

  it("rejects null and primitives outright", () => {
    expect(isTransactionHookPreview(null)).toBe(false);
    expect(isTransactionHookPreview(42)).toBe(false);
    expect(isTransactionHookPreview("preview")).toBe(false);
  });
});

describe("audit-followup-types — OperatorSigningActivity shape", () => {
  const valid: OperatorSigningActivity = {
    schemaVersion: 1,
    authorityIndex: 7,
    currentRound: 12_345,
    limit: 200,
    supportedStatuses: ["signed", "delayed", "offline", "maintenance"],
    reservedStatuses: [],
    entries: [
      { round: 12_345, status: "signed", signersCount: 12 },
      { round: 12_344, status: "delayed", signersCount: 9 },
      { round: 12_343, status: "no_cert" },
    ],
  };

  it("accepts a minimal valid activity", () => {
    expect(isOperatorSigningActivity(valid)).toBe(true);
  });

  it("accepts retention + archive redirect when present", () => {
    const withRetention: OperatorSigningActivity = {
      ...valid,
      retention: {
        earliestRetained: 10_000,
        archiveRedirect: { hint: "https://archive.example/operator-7" },
      },
    };
    expect(isOperatorSigningActivity(withRetention)).toBe(true);
  });

  it("accepts an unknown status string (forward-compat)", () => {
    const novel: OperatorSigningActivity = {
      ...valid,
      entries: [{ round: 12_345, status: "some_new_status_code", signersCount: 5 }],
    };
    expect(isOperatorSigningActivity(novel)).toBe(true);
  });

  it("rejects when entries is not an array", () => {
    expect(isOperatorSigningActivity({ ...valid, entries: {} as unknown[] })).toBe(false);
  });

  it("rejects when reservedStatuses entry is missing a required key", () => {
    const broken = {
      ...valid,
      reservedStatuses: [{ code: "x", description: "y" }],
    };
    expect(isOperatorSigningActivity(broken)).toBe(false);
  });

  it("rejects when signersCount is a string", () => {
    const broken = {
      ...valid,
      entries: [{ round: 1, status: "signed", signersCount: "12" }],
    };
    expect(isOperatorSigningActivity(broken)).toBe(false);
  });

  it("exposes the canonical status list", () => {
    expect(KNOWN_SIGNING_ENTRY_STATUSES).toContain("signed");
    expect(KNOWN_SIGNING_ENTRY_STATUSES).toContain("maintenance");
    expect(KNOWN_SIGNING_ENTRY_STATUSES).toContain("unavailable_history");
  });

  it("summarizeSigningActivity picks the highest-round entry", () => {
    const out = summarizeSigningActivity(valid);
    expect(out.latestStatus).toBe("signed");
    expect(out.latestSignersCount).toBe(12);
    expect(out.isHealthy).toBe(true);
  });

  it("summarizeSigningActivity flags unhealthy on offline", () => {
    const out = summarizeSigningActivity({
      ...valid,
      entries: [{ round: 99, status: "offline", signersCount: 0 }],
    });
    expect(out.isHealthy).toBe(false);
  });

  it("summarizeSigningActivity handles an empty entries window", () => {
    const out = summarizeSigningActivity({ ...valid, entries: [] });
    expect(out.latestStatus).toBe("unavailable_history");
    expect(out.latestSignersCount).toBeNull();
    expect(out.isHealthy).toBe(false);
  });
});

describe("audit-followup-types — PublicServiceProbe shape", () => {
  const valid: PublicServiceProbe = {
    serviceMask: 0x1,
    status: "healthy",
    statusCode: 0,
    lastProbeBlock: 998_877,
    latencyMs: 42,
    probeDigest: "0xabc123",
    reporter: "0xdeadbeef",
  };

  it("accepts a minimal valid probe", () => {
    expect(isPublicServiceProbe(valid)).toBe(true);
  });

  it("rejects null (caller handles 'no report' separately)", () => {
    expect(isPublicServiceProbe(null)).toBe(false);
  });

  it("rejects when latencyMs is missing", () => {
    const broken = { ...valid } as Record<string, unknown>;
    delete broken.latencyMs;
    expect(isPublicServiceProbe(broken)).toBe(false);
  });

  it("rejects when statusCode is a string", () => {
    expect(isPublicServiceProbe({ ...valid, statusCode: "0" })).toBe(false);
  });

  it("rejects when reporter is a number", () => {
    expect(isPublicServiceProbe({ ...valid, reporter: 0 })).toBe(false);
  });
});

describe("audit-followup-types — UpcomingDuties shape", () => {
  const valid: UpcomingDuties = {
    schemaVersion: 1,
    authorityIndex: 3,
    currentRound: 1_000,
    horizonRounds: 1_000,
    committee: {
      authoritySetSize: 50,
      quorumThreshold: 34,
      recoveryFloor: 17,
      authorityInCurrentSet: true,
    },
    duties: {
      attestation: { startRound: 1_010, endRound: 1_020, kind: "scheduled" },
      blockProduction: { reason: "not_scheduled" },
      sync: { reason: "in_sync" },
      keyRotation: { nextRound: 5_000, epochLengthRounds: 4_000 },
    },
  };

  it("accepts a minimal valid duties payload", () => {
    expect(isUpcomingDuties(valid)).toBe(true);
  });

  it("accepts duties with key-rotation in 'absent' branch", () => {
    const absent: UpcomingDuties = {
      ...valid,
      duties: { ...valid.duties, keyRotation: { reason: "not_due" } },
    };
    expect(isUpcomingDuties(absent)).toBe(true);
  });

  it("rejects when keyRotation has neither nextRound nor reason", () => {
    const broken = { ...valid, duties: { ...valid.duties, keyRotation: {} } };
    expect(isUpcomingDuties(broken)).toBe(false);
  });

  it("rejects when attestation kind is missing", () => {
    const broken = {
      ...valid,
      duties: {
        ...valid.duties,
        attestation: { startRound: 1, endRound: 2 } as unknown as UpcomingDuties["duties"]["attestation"],
      },
    };
    expect(isUpcomingDuties(broken)).toBe(false);
  });

  it("isKeyRotationAvailable narrows correctly", () => {
    expect(isKeyRotationAvailable(valid.duties.keyRotation)).toBe(true);
    expect(isKeyRotationAvailable({ reason: "absent" })).toBe(false);
  });
});
