// Phase 11 Commit 1 — tests for `withChainFallback`.
//
// The wallet's existing chain readers all wrap a `try { return await
// rpc(...) } catch { return MOCK }` in some shape; `withChainFallback`
// centralises that pattern. The tests below cover the four outcome
// kinds and the timeout path.

import { describe, expect, it } from "vitest";
import {
  withChainFallback,
  chainOutcomeData,
  isLive,
  type ChainOutcome,
} from "./chain-readiness.js";

describe("withChainFallback", () => {
  it("returns live data when the chain call resolves", async () => {
    const out = await withChainFallback(async () => "real-data", {
      mockValue: "mock-data",
      label: "test_method",
    });
    expect(out.kind).toBe("live");
    expect(out.data).toBe("real-data");
    expect(out.via).toBe("test_method");
    if (out.kind === "live") {
      expect(out.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("falls back to mock with kind=mock-offline on transport error", async () => {
    const out = await withChainFallback(
      async () => {
        throw new Error("network unreachable");
      },
      {
        mockValue: "mock-data",
        label: "test_method",
      },
    );
    expect(out.kind).toBe("mock-offline");
    expect(out.data).toBe("mock-data");
    expect(out.via).toBe("mock");
    if (out.kind === "mock-offline") {
      expect(out.reason).toContain("test_method");
      expect(out.reason).toContain("network unreachable");
    }
  });

  it("falls back to mock with kind=mock-not-deployed when notLiveAs hints chain GAP", async () => {
    const out = await withChainFallback(
      async () => {
        throw new Error("method not found");
      },
      {
        mockValue: { rows: [] },
        notLiveAs: "not-deployed",
        label: "lyth_futurePrimitive",
      },
    );
    expect(out.kind).toBe("mock-not-deployed");
    expect(out.data).toEqual({ rows: [] });
  });

  it("falls back to mock-error when validator rejects the chain response", async () => {
    type ChainShape = { expectedShape?: string; wrongShape?: number };
    const out = await withChainFallback<ChainShape>(
      async () => ({ wrongShape: 1 }),
      {
        mockValue: { expectedShape: "default" },
        label: "test_method",
        isValid: (raw): boolean =>
          typeof raw === "object" &&
          raw !== null &&
          "expectedShape" in (raw as object),
      },
    );
    expect(out.kind).toBe("mock-error");
    expect(out.data).toEqual({ expectedShape: "default" });
    if (out.kind === "mock-error") {
      expect(out.reason).toContain("shape validation");
    }
  });

  it("times out and falls back when the chain call hangs", async () => {
    const out = await withChainFallback(
      () =>
        new Promise<string>(() => {
          // never resolves
        }),
      {
        mockValue: "mock-data",
        label: "hung_method",
        timeoutMs: 50,
      },
    );
    expect(out.kind).toBe("mock-offline");
    expect(out.data).toBe("mock-data");
    if (out.kind === "mock-offline") {
      expect(out.reason).toContain("timeout");
      expect(out.reason).toContain("50ms");
    }
  });

  it("timeout-as-not-deployed routes via the notLiveAs hint", async () => {
    const out = await withChainFallback(
      () =>
        new Promise<string>(() => {
          // never resolves
        }),
      {
        mockValue: "mock-data",
        notLiveAs: "not-deployed",
        label: "hung_method",
        timeoutMs: 50,
      },
    );
    expect(out.kind).toBe("mock-not-deployed");
  });

  it("clears the timeout handle when the chain call resolves first", async () => {
    // If the timeout handle weren't cleared, the test would hang waiting
    // for vitest to drain timers. A direct setTimeout assertion would be
    // brittle; instead, we time the full path and check it's < the
    // timeout budget by a safe margin.
    const startedAt = Date.now();
    const out = await withChainFallback(async () => "fast", {
      mockValue: "mock",
      timeoutMs: 5000,
    });
    const elapsed = Date.now() - startedAt;
    expect(out.kind).toBe("live");
    expect(elapsed).toBeLessThan(1000);
  });

  it("chainOutcomeData unwraps the data regardless of kind", async () => {
    const live: ChainOutcome<string> = {
      kind: "live",
      data: "x",
      via: "label",
      durationMs: 1,
    };
    const offline: ChainOutcome<string> = {
      kind: "mock-offline",
      data: "y",
      via: "mock",
      reason: "boom",
      durationMs: 1,
    };
    expect(chainOutcomeData(live)).toBe("x");
    expect(chainOutcomeData(offline)).toBe("y");
  });

  it("isLive distinguishes chain-sourced vs mock-sourced", () => {
    const live: ChainOutcome<string> = {
      kind: "live",
      data: "x",
      via: "label",
      durationMs: 1,
    };
    const offline: ChainOutcome<string> = {
      kind: "mock-offline",
      data: "y",
      via: "mock",
      reason: "boom",
      durationMs: 1,
    };
    const notDeployed: ChainOutcome<string> = {
      kind: "mock-not-deployed",
      data: "z",
      via: "mock",
      reason: "gap",
      durationMs: 1,
    };
    const errorKind: ChainOutcome<string> = {
      kind: "mock-error",
      data: "w",
      via: "mock",
      reason: "shape",
      durationMs: 1,
    };
    expect(isLive(live)).toBe(true);
    expect(isLive(offline)).toBe(false);
    expect(isLive(notDeployed)).toBe(false);
    expect(isLive(errorKind)).toBe(false);
  });
});
