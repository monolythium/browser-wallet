// operator-risk classifier tests.

import { describe, expect, it } from "vitest";
import {
  EXPECTED_CAPABILITY_SURFACES,
  HIGH_LATENCY_MS,
  INDEXER_STALE_LAG,
  OPERATOR_RISK_LEGEND,
  classifyOperatorRisk,
  type OperatorRiskInput,
} from "./operator-risk.js";

const HEALTHY: OperatorRiskInput = {
  ok: true,
  trustedGenesis: true,
  capabilities: Object.fromEntries(
    EXPECTED_CAPABILITY_SURFACES.map((s) => [s, "available"]),
  ),
  indexerHeight: 1000,
  indexerLatest: 1000,
  latencyMs: 100,
};

describe("classifyOperatorRisk — healthy baseline", () => {
  it("returns no badges for a fully healthy operator", () => {
    expect(classifyOperatorRisk(HEALTHY)).toEqual([]);
  });
});

describe("classifyOperatorRisk — transport-error short-circuit", () => {
  it("flags offline and skips other checks when ok=false", () => {
    const r = classifyOperatorRisk({
      ...HEALTHY,
      ok: false,
      trustedGenesis: false,
      capabilities: null,
      indexerHeight: null,
      indexerLatest: null,
      latencyMs: null,
    });
    expect(r.length).toBe(1);
    expect(r[0]!.kind).toBe("transport-error");
    expect(r[0]!.severity).toBe("err");
  });
});

describe("classifyOperatorRisk — untrusted genesis", () => {
  it("flags untrusted-genesis (severity: err)", () => {
    const r = classifyOperatorRisk({ ...HEALTHY, trustedGenesis: false });
    const flag = r.find((b) => b.kind === "untrusted-genesis");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("err");
  });
});

describe("classifyOperatorRisk — capabilities", () => {
  it("flags no-caps when capabilities object is null", () => {
    const r = classifyOperatorRisk({ ...HEALTHY, capabilities: null });
    const flag = r.find((b) => b.kind === "missing-capabilities");
    expect(flag).toBeDefined();
    expect(flag!.label).toBe("no caps");
  });

  it("flags missing-N when expected surfaces absent", () => {
    const r = classifyOperatorRisk({
      ...HEALTHY,
      capabilities: {}, // missing 'indexer'
    });
    const flag = r.find((b) => b.kind === "missing-capabilities");
    expect(flag).toBeDefined();
    expect(flag!.label).toBe("missing 1");
    expect(flag!.tooltip).toContain("indexer");
  });

  it("does not flag missing-caps when all expected surfaces present", () => {
    const r = classifyOperatorRisk({
      ...HEALTHY,
      capabilities: Object.fromEntries(
        EXPECTED_CAPABILITY_SURFACES.map((s) => [s, "available"]),
      ),
    });
    expect(r.some((b) => b.kind === "missing-capabilities")).toBe(false);
  });
});

describe("classifyOperatorRisk — indexer state", () => {
  it("flags no-indexer when height is null", () => {
    const r = classifyOperatorRisk({
      ...HEALTHY,
      indexerHeight: null,
      indexerLatest: null,
    });
    const flag = r.find((b) => b.kind === "indexer-disabled");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("info");
  });

  it("flags indexer-stale when lag exceeds threshold", () => {
    const r = classifyOperatorRisk({
      ...HEALTHY,
      indexerHeight: 100,
      indexerLatest: 100 + INDEXER_STALE_LAG + 1,
    });
    const flag = r.find((b) => b.kind === "indexer-stale");
    expect(flag).toBeDefined();
    expect(flag!.label).toBe(`lag ${INDEXER_STALE_LAG + 1}`);
  });

  it("does NOT flag indexer-stale at exactly the threshold", () => {
    const r = classifyOperatorRisk({
      ...HEALTHY,
      indexerHeight: 100,
      indexerLatest: 100 + INDEXER_STALE_LAG,
    });
    expect(r.some((b) => b.kind === "indexer-stale")).toBe(false);
  });
});

describe("classifyOperatorRisk — latency", () => {
  it("flags high-latency when latencyMs >= threshold", () => {
    const r = classifyOperatorRisk({ ...HEALTHY, latencyMs: HIGH_LATENCY_MS });
    const flag = r.find((b) => b.kind === "high-latency");
    expect(flag).toBeDefined();
    expect(flag!.label).toBe(`${(HIGH_LATENCY_MS / 1000).toFixed(1)}s`);
  });

  it("does not flag when latencyMs < threshold", () => {
    const r = classifyOperatorRisk({
      ...HEALTHY,
      latencyMs: HIGH_LATENCY_MS - 1,
    });
    expect(r.some((b) => b.kind === "high-latency")).toBe(false);
  });
});

describe("classifyOperatorRisk — pending change", () => {
  it("surfaces chain-supplied pending-change badges verbatim", () => {
    const r = classifyOperatorRisk({
      ...HEALTHY,
      pendingChange: {
        summary: "Operator rotation scheduled in 3 epochs",
        severity: "warn",
      },
    });
    const flag = r.find((b) => b.kind === "pending-change");
    expect(flag).toBeDefined();
    expect(flag!.label).toBe("pending");
    expect(flag!.tooltip).toBe("Operator rotation scheduled in 3 epochs");
    expect(flag!.severity).toBe("warn");
  });

  it("does not surface pending-change when chain doesn't supply it", () => {
    const r = classifyOperatorRisk(HEALTHY);
    expect(r.some((b) => b.kind === "pending-change")).toBe(false);
  });
});

describe("classifyOperatorRisk — composite cases", () => {
  it("stacks multiple risk badges", () => {
    const r = classifyOperatorRisk({
      ok: true,
      trustedGenesis: false,
      capabilities: null,
      indexerHeight: null,
      indexerLatest: null,
      latencyMs: HIGH_LATENCY_MS,
    });
    const kinds = r.map((b) => b.kind).sort();
    expect(kinds).toContain("untrusted-genesis");
    expect(kinds).toContain("missing-capabilities");
    expect(kinds).toContain("indexer-disabled");
    expect(kinds).toContain("high-latency");
  });
});

describe("OPERATOR_RISK_LEGEND", () => {
  it("has one entry per risk kind the classifier emits", () => {
    const emittedKinds = new Set([
      "untrusted-genesis",
      "transport-error",
      "indexer-stale",
      "indexer-disabled",
      "missing-capabilities",
      "high-latency",
      "pending-change",
    ]);
    for (const k of emittedKinds) {
      expect(OPERATOR_RISK_LEGEND.some((e) => e.kind === k)).toBe(true);
    }
  });

  it("every legend entry has a non-empty label + body", () => {
    for (const e of OPERATOR_RISK_LEGEND) {
      expect(e.label.length).toBeGreaterThan(0);
      expect(e.body.length).toBeGreaterThan(0);
    }
  });
});
