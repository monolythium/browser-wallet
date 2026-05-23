// Phase 11 Commit 6 — ClusterDetail page logic tests.
//
// The page itself is React; the filter logic it applies to delegation
// history is pure and worth testing in isolation. Mirrors the inline
// `historyRes.data.rows.filter(...)` in the useEffect.

import { describe, expect, it } from "vitest";
import type { DelegationHistoryRow } from "../../shared/staking";

/** Pure filter — mirrors the inline filter in ClusterDetail.tsx. Kept
 *  as a separate function so the test can lock the contract; the page
 *  itself inlines the same predicate. */
function filterHistoryForCluster(
  rows: ReadonlyArray<DelegationHistoryRow>,
  clusterId: number,
): DelegationHistoryRow[] {
  return rows.filter(
    (r) => r.cluster === clusterId || r.toCluster === clusterId,
  );
}

const baseRow: DelegationHistoryRow = {
  blockHeight: "100",
  txIndex: 0,
  logIndex: 0,
  wallet: "0xabc",
  cluster: 1,
  toCluster: null,
  kind: "delegate",
  weightBps: 1000,
  walletTotalBps: 1000,
};

describe("filterHistoryForCluster", () => {
  it("includes delegations to the cluster", () => {
    const rows = [
      { ...baseRow, cluster: 1, kind: "delegate" },
      { ...baseRow, cluster: 2, kind: "delegate" },
    ];
    expect(filterHistoryForCluster(rows, 1).length).toBe(1);
    expect(filterHistoryForCluster(rows, 1)[0]!.cluster).toBe(1);
  });

  it("includes undelegations from the cluster", () => {
    const rows = [
      { ...baseRow, cluster: 1, kind: "undelegate" },
      { ...baseRow, cluster: 2, kind: "undelegate" },
    ];
    expect(filterHistoryForCluster(rows, 1).length).toBe(1);
  });

  it("includes redelegations TO the cluster (via toCluster)", () => {
    const rows = [
      { ...baseRow, cluster: 5, toCluster: 1, kind: "redelegate" },
      { ...baseRow, cluster: 5, toCluster: 2, kind: "redelegate" },
    ];
    const r = filterHistoryForCluster(rows, 1);
    expect(r.length).toBe(1);
    expect(r[0]!.toCluster).toBe(1);
  });

  it("includes redelegations FROM the cluster (via cluster=src)", () => {
    const rows = [
      { ...baseRow, cluster: 1, toCluster: 5, kind: "redelegate" },
      { ...baseRow, cluster: 2, toCluster: 5, kind: "redelegate" },
    ];
    const r = filterHistoryForCluster(rows, 1);
    expect(r.length).toBe(1);
    expect(r[0]!.cluster).toBe(1);
  });

  it("returns empty array for cluster with no history", () => {
    const rows = [
      { ...baseRow, cluster: 1 },
      { ...baseRow, cluster: 2 },
    ];
    expect(filterHistoryForCluster(rows, 99)).toEqual([]);
  });

  it("returns empty for empty input", () => {
    expect(filterHistoryForCluster([], 1)).toEqual([]);
  });
});
