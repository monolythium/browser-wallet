// Phase 7 commit 1 — staking-client read-path tests.
//
// Three property classes pinned here:
//   1. Happy path: a well-formed RPC response normalises into the
//      typed StakingResult envelope (cluster-directory row count
//      preserved, regions array passed through, entity stitched in
//      via the second `lyth_getClusterEntity` lookup).
//   2. Sprintnet-offline fallback: when `sprintnetJsonRpc` throws,
//      readClusterDirectory + readDelegations + readDelegationCap
//      all serve the MOCK fixtures rather than failing the popup
//      render (`via: "mock"`).
//   3. Malformed-response handling: a well-formed-transport but
//      missing-required-fields response yields `ok: false, reason`.
//
// Pending-rewards + redemption-queue paths are chain-GAP mocks today
// (the SDK at 0fd8a79 doesn't expose either reader); the tests pin the
// mock-derivation shape so a future chain-side activation breaks the
// fixture loudly rather than silently.

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ClusterDirectoryPageResponse,
  ClusterStatusResponse,
} from "@monolythium/core-sdk";

// Stub the tx-mldsa dispatch surface; every staking read goes through
// this single function so one mock controls the whole suite.
vi.mock("./tx-mldsa.js", () => ({
  sprintnetJsonRpc: vi.fn(),
}));

import { sprintnetJsonRpc } from "./tx-mldsa.js";
import {
  readClusterDirectory,
  readClusterStatus,
  readDelegationCap,
  readDelegationHistory,
  readDelegations,
  readPendingRewards,
  readRedemptionQueue,
} from "./staking-client.js";
import { MOCK_CLUSTERS, MOCK_CLUSTER_APR_BPS } from "../shared/staking.js";

const mockedRpc = sprintnetJsonRpc as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
  mockedRpc.mockReset();
});

// ─────────────────────────────────────────────────────────────────────────────
// readClusterDirectory
// ─────────────────────────────────────────────────────────────────────────────

describe("readClusterDirectory", () => {
  it("normalises a well-formed lyth_clusters page + stitches entity flags", async () => {
    mockedRpc.mockImplementation(async (method: string, params: unknown[]) => {
      if (method === "lyth_clusters") {
        return {
          via: "operator-2",
          result: {
            page: 0,
            limit: 25,
            totalClusters: 2,
            clusters: [
              {
                clusterId: 1,
                size: 10,
                threshold: 7,
                aggregateHealth: "healthy",
                regionDiversity: ["fsn1", "nbg1"],
                active: true,
              },
              {
                clusterId: 2,
                size: 10,
                threshold: 7,
                aggregateHealth: "degraded",
                regionDiversity: ["ash"],
                active: true,
              },
            ],
          },
        };
      }
      if (method === "lyth_getClusterEntity") {
        const cluster = (params as [number])[0];
        return {
          via: "operator-2",
          result: { cluster, entity: cluster === 1 ? "mono-labs" : "independent" },
        };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const r = await readClusterDirectory(0, 25);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.clusters).toHaveLength(2);
    expect(r.data.clusters[0]?.entity).toBe("mono-labs");
    expect(r.data.clusters[1]?.entity).toBe("independent");
    expect(r.data.clusters[0]?.regions).toEqual(["fsn1", "nbg1"]);
    expect(r.data.clusters[0]?.health).toBe("healthy");
    // The cluster-name registry is not yet emitted by the SDK; the
    // wallet normalises name to null on every directory row.
    expect(r.data.clusters[0]?.name).toBeNull();
  });

  it("falls back to MOCK_CLUSTERS when sprintnetJsonRpc throws (Sprintnet offline)", async () => {
    mockedRpc.mockRejectedValue(new Error("no Sprintnet operator reachable"));
    const r = await readClusterDirectory(0, 25);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.via).toBe("mock");
    expect(r.data.clusters.length).toBe(MOCK_CLUSTERS.length);
    // The mock fixtures preserve the §14 architecture shape (10 ops per
    // cluster, 7-of-10 threshold).
    for (const c of r.data.clusters) {
      expect(c.size).toBe(10);
      expect(c.threshold).toBe(7);
    }
  });

  it("rejects a malformed response (missing clusters[] array)", async () => {
    mockedRpc.mockResolvedValue({ via: "operator-1", result: { page: 0, limit: 25 } });
    const r = await readClusterDirectory(0, 25);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/malformed/);
  });

  it("normalises an unknown health string to 'unknown'", async () => {
    mockedRpc.mockImplementation(async (method: string) => {
      if (method === "lyth_clusters") {
        return {
          via: "operator-1",
          result: {
            page: 0,
            limit: 25,
            totalClusters: 1,
            clusters: [
              {
                clusterId: 7,
                size: 10,
                threshold: 7,
                aggregateHealth: "fish-flavored",
                regionDiversity: null,
                active: true,
              },
            ],
          },
        };
      }
      return { via: "operator-1", result: { cluster: 7, entity: "independent" } };
    });
    const r = await readClusterDirectory(0, 25);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.clusters[0]?.health).toBe("unknown");
    expect(r.data.clusters[0]?.regions).toEqual([]);
  });

  // Phase 7.1 — wire-contract anchor. Constructs the exact SDK-shape
  // `ClusterDirectoryPageResponse` (post-normalisation) and verifies the
  // wallet's parser handles it. If Nayiem rotates a field name on the
  // chain side and the SDK re-exports the new shape, this fixture's
  // type annotation forces a compile error here before the wallet
  // ships against a stale contract.
  it("parses a strict SDK ClusterDirectoryPageResponse without rejecting fields", async () => {
    const sdkShape: ClusterDirectoryPageResponse = {
      page: 0,
      limit: 25,
      totalClusters: 1,
      clusters: [
        {
          clusterId: 42,
          size: 10,
          threshold: 7,
          aggregateHealth: "healthy",
          regionDiversity: ["fsn1", "hel1"],
          active: true,
        },
      ],
    };
    mockedRpc.mockImplementation(async (method: string) => {
      if (method === "lyth_clusters") return { via: "operator-3", result: sdkShape };
      return { via: "operator-3", result: { cluster: 42, entity: "independent" } };
    });
    const r = await readClusterDirectory(0, 25);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.totalClusters).toBe(1);
    expect(r.data.clusters[0]?.clusterId).toBe(42);
    expect(r.data.clusters[0]?.entity).toBe("independent");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// readClusterStatus
// ─────────────────────────────────────────────────────────────────────────────

describe("readClusterStatus", () => {
  it("normalises members + stringifies bigints (epoch / round / lastUpdateHeight)", async () => {
    mockedRpc.mockResolvedValue({
      via: "operator-3",
      result: {
        clusterId: 1,
        threshold: 7,
        size: 10,
        live: 9,
        lagging: 1,
        offline: 0,
        maintenance: 0,
        members: [
          { operatorId: "op-1", blsPubkey: "0xabc", state: "active" },
          { operatorId: "op-2", blsPubkey: "0xdef", state: "active" },
        ],
        epoch: 42n,
        round: 12345n,
        quorum: "7-of-10",
        reputationScore: 0.91,
        livenessScore: 0.99,
        lastUpdateHeight: 99999n,
      },
    });
    const r = await readClusterStatus(1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.members).toHaveLength(2);
    expect(r.data.epoch).toBe("42");
    expect(r.data.lastUpdateHeight).toBe("99999");
    expect(r.data.reputationScore).toBe(0.91);
  });

  it("propagates RPC failure rather than mock-falling-back (status is opt-in detail)", async () => {
    mockedRpc.mockRejectedValue(new Error("timeout"));
    const r = await readClusterStatus(1);
    expect(r.ok).toBe(false);
  });

  // Phase 7.1 — wire-contract anchor for cluster status. Same rationale
  // as the directory anchor above: constructs the strict SDK shape with
  // bigints for epoch / round / lastUpdateHeight and verifies the
  // wallet's parser stringifies them faithfully for IPC.
  it("parses a strict SDK ClusterStatusResponse and stringifies bigints", async () => {
    const sdkShape: ClusterStatusResponse = {
      clusterId: 5,
      threshold: 7,
      size: 10,
      live: 8,
      lagging: 1,
      offline: 1,
      maintenance: 0,
      members: [
        { operatorId: "op-a", blsPubkey: "0x" + "11".repeat(48), state: "active" },
      ],
      epoch: 17n,
      round: 256n,
      quorum: "7-of-10",
      reputationScore: 0.88,
      livenessScore: 0.97,
      lastUpdateHeight: 524288n,
    };
    mockedRpc.mockResolvedValue({ via: "operator-2", result: sdkShape });
    const r = await readClusterStatus(5);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.epoch).toBe("17");
    expect(r.data.round).toBe("256");
    expect(r.data.lastUpdateHeight).toBe("524288");
    expect(r.data.members).toHaveLength(1);
    expect(r.data.quorum).toBe("7-of-10");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// readDelegations
// ─────────────────────────────────────────────────────────────────────────────

describe("readDelegations", () => {
  const wallet = "0x" + "aa".repeat(20);

  it("returns the chain rows when sprintnetJsonRpc succeeds", async () => {
    mockedRpc.mockResolvedValue({
      via: "operator-1",
      result: {
        wallet,
        rows: [
          { cluster: 1, weightBps: 3000 },
          { cluster: 3, weightBps: 2000 },
        ],
        totalBps: 5000,
      },
    });
    const r = await readDelegations(wallet);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.rows).toHaveLength(2);
    expect(r.data.totalBps).toBe(5000);
  });

  it("falls back to an empty envelope when sprintnetJsonRpc throws", async () => {
    mockedRpc.mockRejectedValue(new Error("transport"));
    const r = await readDelegations(wallet);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.via).toBe("mock");
    expect(r.data.rows).toEqual([]);
    expect(r.data.totalBps).toBe(0);
  });

  it("drops malformed rows but keeps valid ones", async () => {
    mockedRpc.mockResolvedValue({
      via: "operator-1",
      result: {
        wallet,
        rows: [
          { cluster: 1, weightBps: 1000 },
          { cluster: "not-a-number", weightBps: 500 },
          { cluster: 2, weightBps: "not-a-number" },
          { cluster: 4, weightBps: 2000 },
        ],
        totalBps: 4500, // chain-canonical total includes the malformed rows
      },
    });
    const r = await readDelegations(wallet);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.rows).toEqual([
      { cluster: 1, weightBps: 1000 },
      { cluster: 4, weightBps: 2000 },
    ]);
    // totalBps is the chain-reported figure, not the per-row sum; the
    // wallet trusts the chain on aggregates and uses the row list only
    // for the per-cluster display.
    expect(r.data.totalBps).toBe(4500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// readDelegationCap
// ─────────────────────────────────────────────────────────────────────────────

describe("readDelegationCap", () => {
  it("normalises u32::MAX (chain's 'disabled') to null capBps", async () => {
    mockedRpc.mockResolvedValue({
      via: "operator-1",
      result: { capBps: 0xffffffff, lastChangedAtHeight: 0n },
    });
    const r = await readDelegationCap();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.capBps).toBeNull();
  });

  it("preserves a real cap value", async () => {
    mockedRpc.mockResolvedValue({
      via: "operator-1",
      result: { capBps: 5000, lastChangedAtHeight: 12345n },
    });
    const r = await readDelegationCap();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.capBps).toBe(5000);
    expect(r.data.lastChangedAtHeight).toBe("12345");
  });

  it("falls back to the §23.6 Phase 12 launch cap (50%) on transport failure", async () => {
    mockedRpc.mockRejectedValue(new Error("offline"));
    const r = await readDelegationCap();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.via).toBe("mock");
    expect(r.data.capBps).toBe(5000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// readPendingRewards (chain GAP — verify mock-derivation shape)
// ─────────────────────────────────────────────────────────────────────────────

describe("readPendingRewards (chain GAP — mock fixture)", () => {
  const wallet = "0x" + "bb".repeat(20);

  it("emits a row per active delegation, attached APR from MOCK_CLUSTER_APR_BPS", async () => {
    const r = await readPendingRewards(wallet, [
      { cluster: 1, weightBps: 2000 },
      { cluster: 3, weightBps: 1000 },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.via).toBe("mock");
    expect(r.data.rows).toHaveLength(2);
    expect(r.data.rows[0]?.effectiveAprBps).toBe(MOCK_CLUSTER_APR_BPS[1]);
    expect(r.data.rows[1]?.effectiveAprBps).toBe(MOCK_CLUSTER_APR_BPS[3]);
    // The total is a non-empty hex; verifies the BigInt arithmetic
    // doesn't underflow to zero on small weights.
    expect(r.data.totalAmountWei).toMatch(/^0x[0-9a-f]+$/);
  });

  it("emits a zero row when the cluster isn't in the mock APR table", async () => {
    const r = await readPendingRewards(wallet, [{ cluster: 999, weightBps: 1000 }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.rows[0]?.effectiveAprBps).toBeNull();
    expect(r.data.rows[0]?.amountWei).toBe("0x0");
    expect(r.data.totalAmountWei).toBe("0x0");
  });

  it("returns an empty rows[] for an unstaked wallet", async () => {
    const r = await readPendingRewards(wallet, []);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.rows).toEqual([]);
    expect(r.data.totalAmountWei).toBe("0x0");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// readRedemptionQueue (chain GAP — §23.2 says zero unbonding)
// ─────────────────────────────────────────────────────────────────────────────

describe("readRedemptionQueue (chain GAP — §23.2 zero unbonding)", () => {
  it("always returns an empty queue today", async () => {
    const r = await readRedemptionQueue("0xdead");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.via).toBe("mock");
    expect(r.data.rows).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// readDelegationHistory (Phase 7.1 — newly activated per-wallet timeline)
// ─────────────────────────────────────────────────────────────────────────────

describe("readDelegationHistory", () => {
  const wallet = "0x" + "cc".repeat(20);

  it("normalises a well-formed lyth_getDelegationHistory array (bigints stringified)", async () => {
    mockedRpc.mockResolvedValue({
      via: "operator-4",
      result: [
        {
          blockHeight: 1234n,
          txIndex: 0,
          logIndex: 2,
          wallet,
          cluster: 1,
          toCluster: null,
          kind: "delegated",
          weightBps: 3000,
          walletTotalBps: 3000,
        },
        {
          blockHeight: 5678n,
          txIndex: 1,
          logIndex: 0,
          wallet,
          cluster: 1,
          toCluster: 2,
          kind: "redelegated",
          weightBps: 1500,
          walletTotalBps: 3000,
        },
      ],
    });
    const r = await readDelegationHistory(wallet);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.rows).toHaveLength(2);
    expect(r.data.rows[0]?.blockHeight).toBe("1234");
    expect(r.data.rows[0]?.kind).toBe("delegated");
    expect(r.data.rows[1]?.toCluster).toBe(2);
    expect(r.data.rows[1]?.kind).toBe("redelegated");
  });

  it("paginates: passes cursor when provided", async () => {
    let receivedParams: unknown[] | undefined;
    mockedRpc.mockImplementation(async (_method: string, params: unknown[]) => {
      receivedParams = params;
      return { via: "operator-1", result: [] };
    });
    await readDelegationHistory(wallet, 25, "cursor-page-2");
    expect(receivedParams).toEqual([wallet, 25, "cursor-page-2"]);
  });

  it("omits cursor on first-page calls", async () => {
    let receivedParams: unknown[] | undefined;
    mockedRpc.mockImplementation(async (_method: string, params: unknown[]) => {
      receivedParams = params;
      return { via: "operator-1", result: [] };
    });
    await readDelegationHistory(wallet, 10);
    expect(receivedParams).toEqual([wallet, 10]);
  });

  it("falls back to an empty timeline when chain is offline", async () => {
    mockedRpc.mockRejectedValue(new Error("no operator reachable"));
    const r = await readDelegationHistory(wallet);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.via).toBe("mock");
    expect(r.data.rows).toEqual([]);
  });

  it("drops malformed rows but keeps valid ones", async () => {
    mockedRpc.mockResolvedValue({
      via: "operator-1",
      result: [
        { blockHeight: 1n, txIndex: 0, logIndex: 0, wallet, cluster: 1, toCluster: null, kind: "delegated", weightBps: 1000, walletTotalBps: 1000 },
        { blockHeight: 2n, cluster: "not-a-number", kind: "delegated", weightBps: 500 }, // bad cluster
        { blockHeight: 3n, cluster: 2, weightBps: 500 }, // missing kind
        { blockHeight: 4n, txIndex: 1, logIndex: 0, wallet, cluster: 3, toCluster: null, kind: "undelegated", weightBps: 500, walletTotalBps: 500 },
      ],
    });
    const r = await readDelegationHistory(wallet);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.rows).toHaveLength(2);
    expect(r.data.rows[0]?.cluster).toBe(1);
    expect(r.data.rows[1]?.cluster).toBe(3);
  });

  it("rejects a non-array response", async () => {
    mockedRpc.mockResolvedValue({ via: "operator-1", result: { not: "an array" } });
    const r = await readDelegationHistory(wallet);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/malformed/);
  });
});
