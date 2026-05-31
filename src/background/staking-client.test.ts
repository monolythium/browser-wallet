// Phase 7 commit 1 — staking-client read-path tests.
//
// Three property classes pinned here:
//   1. Happy path: a well-formed RPC response normalises into the
//      typed StakingResult envelope (cluster-directory row count
//      preserved, regions array passed through, entity stitched in
//      via the second `lyth_getClusterEntity` lookup).
//   2. Sprintnet-offline behaviour:
//      - readClusterDirectory propagates `ok: false` (no MOCK_CLUSTERS
//        fallback — per `_dev-notes/_principles/no-mock-fallbacks.md`,
//        R18);
//      - readDelegations / readDelegationHistory / readClusterDelegators
//        still return `ok: true, data: { rows: [] }` because empty is
//        a legitimate chain response;
//      - readDelegationCap retains its synthetic §23.6 fallback (tracked
//        for follow-up review under the no-mock principle).
//   3. Malformed-response handling: a well-formed-transport but
//      missing-required-fields response yields `ok: false, reason`.
//
// Pending rewards and redemption queue now call their direct live RPCs
// first, falling back to old mock render shapes only when the method is
// absent or Sprintnet is unreachable.

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ClusterDirectoryPageResponse,
  ClusterStatusResponse,
  OperatorInfoResponse,
} from "@monolythium/core-sdk";

// Stub the tx-mldsa dispatch surface; every staking read goes through
// this single function so one mock controls the whole suite.
vi.mock("./tx-mldsa.js", () => ({
  sprintnetJsonRpc: vi.fn(),
}));

import { sprintnetJsonRpc } from "./tx-mldsa.js";
import {
  readClusterApr,
  readClusterDelegators,
  readClusterDirectory,
  readClusterDiversity,
  readClusterServiceTiers,
  readClusterStatus,
  readDelegationCap,
  readDelegationHistory,
  readDelegations,
  readOperatorInfo,
  readPendingRewards,
  readRedemptionQueue,
} from "./staking-client.js";
import { MOCK_CLUSTER_APR_BPS } from "../shared/staking.js";
import { LYTHOSHI_PER_LYTH } from "../shared/native-amount.js";
import { userAddressForNativeRpc } from "../shared/address-format.js";

const mockedRpc = sprintnetJsonRpc as unknown as ReturnType<typeof vi.fn>;

const BPS_DENOMINATOR = 10_000n;
const MOCK_REWARD_PRINCIPAL_LYTHOSHI = 100n * LYTHOSHI_PER_LYTH;
const MOCK_REWARD_INTERVALS_PER_YEAR = 365n * 288n;

function methodNotFoundError(method = "lyth_pendingRewards"): Error & {
  code: number;
  method: string;
  via: string;
} {
  return Object.assign(new Error("Method not found"), {
    code: -32601,
    method,
    via: "operator-1",
  });
}

function expectedMockRewardLythoshi(weightBps: number, aprBps: number): bigint {
  return (
    MOCK_REWARD_PRINCIPAL_LYTHOSHI *
    BigInt(weightBps) *
    BigInt(aprBps)
  ) / (BPS_DENOMINATOR * BPS_DENOMINATOR * MOCK_REWARD_INTERVALS_PER_YEAR);
}

afterEach(() => {
  mockedRpc.mockReset();
});

// ─────────────────────────────────────────────────────────────────────────────
// readClusterDirectory
// ─────────────────────────────────────────────────────────────────────────────

describe("readClusterDirectory", () => {
  it("normalises a well-formed lyth_clusterDirectory page + stitches entity flags", async () => {
    mockedRpc.mockImplementation(async (method: string, params: unknown[]) => {
      if (method === "lyth_clusterDirectory") {
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
      if (method === "lyth_clusterApr") {
        const cluster = (params as [number])[0];
        return {
          via: "operator-2",
          result: { clusterId: cluster, aprBps: cluster === 1 ? 820 : 0 },
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
    // PING #7 — the directory fanout stitches the chain-observed APR onto
    // each row. aprBps: 0 is a legitimate "no rewards in window" value.
    expect(r.data.clusters[0]?.aprBps).toBe(820);
    expect(r.data.clusters[1]?.aprBps).toBe(0);
    // The cluster-name registry is not yet emitted by the SDK; the
    // wallet normalises name to null on every directory row.
    expect(r.data.clusters[0]?.name).toBeNull();
  });

  it("stitches the §25.1 diversity score onto each row from the fanout", async () => {
    mockedRpc.mockImplementation(async (method: string, params: unknown[]) => {
      if (method === "lyth_clusterDirectory") {
        return {
          via: "operator-2",
          result: {
            page: 0,
            limit: 25,
            totalClusters: 1,
            clusters: [
              {
                clusterId: 4,
                size: 10,
                threshold: 7,
                aggregateHealth: "ok",
                regionDiversity: ["fsn1", "ash"],
                active: true,
              },
            ],
          },
        };
      }
      if (method === "lyth_getClusterEntity") {
        return { via: "operator-2", result: { cluster: 4, entity: "independent" } };
      }
      if (method === "lyth_clusterApr") {
        return { via: "operator-2", result: { clusterId: 4, aprBps: 880 } };
      }
      if (method === "lyth_getClusterDiversity") {
        const cluster = (params as [number])[0];
        return {
          via: "operator-2",
          result: {
            clusterId: cluster,
            score: 7700,
            asnVariance: 8000,
            geoVariance: 7000,
            hostingSpread: 6500,
          },
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const r = await readClusterDirectory(0, 25);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.clusters[0]?.diversityScore).toBe(7700);
    expect(r.data.clusters[0]?.asnVariance).toBe(8000);
    expect(r.data.clusters[0]?.geoVariance).toBe(7000);
    expect(r.data.clusters[0]?.hostingSpread).toBe(6500);
  });

  it("leaves diversity fields null when lyth_getClusterDiversity is unavailable", async () => {
    mockedRpc.mockImplementation(async (method: string) => {
      if (method === "lyth_clusterDirectory") {
        return {
          via: "operator-1",
          result: {
            page: 0,
            limit: 25,
            totalClusters: 1,
            clusters: [
              {
                clusterId: 5,
                size: 10,
                threshold: 7,
                aggregateHealth: "ok",
                regionDiversity: null,
                active: true,
              },
            ],
          },
        };
      }
      if (method === "lyth_getClusterEntity") {
        return { via: "operator-1", result: { cluster: 5, entity: "independent" } };
      }
      if (method === "lyth_clusterApr") {
        return { via: "operator-1", result: { clusterId: 5, aprBps: 0 } };
      }
      if (method === "lyth_getClusterDiversity") {
        throw methodNotFoundError("lyth_getClusterDiversity");
      }
      throw new Error(`unexpected method ${method}`);
    });
    const r = await readClusterDirectory(0, 25);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.clusters[0]?.diversityScore).toBeNull();
    expect(r.data.clusters[0]?.asnVariance).toBeNull();
  });

  it("sets aprBps null on every row when lyth_clusterApr is unavailable", async () => {
    mockedRpc.mockImplementation(async (method: string) => {
      if (method === "lyth_clusterDirectory") {
        return {
          via: "operator-1",
          result: {
            page: 0,
            limit: 25,
            totalClusters: 1,
            clusters: [
              {
                clusterId: 5,
                size: 10,
                threshold: 7,
                aggregateHealth: "ok",
                regionDiversity: null,
                active: true,
              },
            ],
          },
        };
      }
      if (method === "lyth_getClusterEntity") {
        return { via: "operator-1", result: { cluster: 5, entity: "independent" } };
      }
      if (method === "lyth_clusterApr") {
        throw methodNotFoundError("lyth_clusterApr");
      }
      throw new Error(`unexpected method ${method}`);
    });
    const r = await readClusterDirectory(0, 25);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.clusters[0]?.aprBps).toBeNull();
  });

  it("propagates ok:false when sprintnetJsonRpc throws (Sprintnet offline)", async () => {
    mockedRpc.mockRejectedValue(new Error("no Monolythium Testnet operator reachable"));
    const r = await readClusterDirectory(0, 25);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("no Monolythium Testnet operator reachable");
  });

  it("rejects a malformed response (missing clusters[] array)", async () => {
    mockedRpc.mockResolvedValue({ via: "operator-1", result: { page: 0, limit: 25 } });
    const r = await readClusterDirectory(0, 25);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/malformed/);
  });

  // R17 — chain vocabulary for `aggregateHealth` is `"ok" | "degraded" |
  // "halted"` (verified against mono-core
  // `crates/core/runtime/src/providers.rs:6848-6854`). Pin the mapping
  // so a future stale-wallet vs current-chain drift surfaces as a test
  // failure rather than a render bug.
  it("maps chain's aggregateHealth tokens (ok/degraded/halted) onto wallet enum", async () => {
    mockedRpc.mockImplementation(async (method: string) => {
      if (method === "lyth_clusterDirectory") {
        return {
          via: "operator-1",
          result: {
            page: 0,
            limit: 25,
            totalClusters: 3,
            clusters: [
              { clusterId: 1, size: 7, threshold: 5, aggregateHealth: "ok", regionDiversity: null, active: true },
              { clusterId: 2, size: 7, threshold: 5, aggregateHealth: "degraded", regionDiversity: null, active: true },
              { clusterId: 3, size: 7, threshold: 5, aggregateHealth: "halted", regionDiversity: null, active: false },
            ],
          },
        };
      }
      return { via: "operator-1", result: { cluster: 1, entity: "independent" } };
    });
    const r = await readClusterDirectory(0, 25);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.clusters[0]?.health).toBe("healthy");
    expect(r.data.clusters[1]?.health).toBe("degraded");
    expect(r.data.clusters[2]?.health).toBe("offline");
  });

  it("normalises an unknown health string to 'unknown'", async () => {
    mockedRpc.mockImplementation(async (method: string) => {
      if (method === "lyth_clusterDirectory") {
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
      if (method === "lyth_clusterDirectory") return { via: "operator-3", result: sdkShape };
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
// readClusterApr — PING #7 (mono-core 253cac0b, live v0.0.11-testnet)
// ─────────────────────────────────────────────────────────────────────────────

describe("readClusterApr", () => {
  it("returns the chain-observed aprBps on a well-formed response", async () => {
    mockedRpc.mockResolvedValue({
      via: "operator-2",
      result: {
        clusterId: 3,
        aprBps: 940,
        blocks: { from: 8200, to: 9400, window: 1200 },
        totalBps: 5000,
        stakePerBpsLythoshi: 100000000,
      },
    });
    const r = await readClusterApr(3);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.aprBps).toBe(940);
  });

  it("treats aprBps: 0 as a legitimate success (no rewards in window)", async () => {
    mockedRpc.mockResolvedValue({
      via: "operator-1",
      result: { clusterId: 0, aprBps: 0 },
    });
    const r = await readClusterApr(0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.aprBps).toBe(0);
  });

  it("propagates ok:false when the method is absent", async () => {
    mockedRpc.mockRejectedValue(methodNotFoundError("lyth_clusterApr"));
    const r = await readClusterApr(0);
    expect(r.ok).toBe(false);
  });

  it("rejects a malformed response (aprBps missing / non-numeric)", async () => {
    mockedRpc.mockResolvedValue({ via: "operator-1", result: { clusterId: 0 } });
    const r = await readClusterApr(0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/malformed/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// readClusterDiversity (§25.1, SDK 0.3.10)
// ─────────────────────────────────────────────────────────────────────────────

describe("readClusterDiversity", () => {
  it("normalises a well-formed lyth_getClusterDiversity response", async () => {
    mockedRpc.mockResolvedValue({
      via: "operator-2",
      result: {
        clusterId: 3,
        score: 8200,
        asnVariance: 9100,
        geoVariance: 7600,
        hostingSpread: 6400,
      },
    });
    const r = await readClusterDiversity(3);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({
      clusterId: 3,
      score: 8200,
      asnVariance: 9100,
      geoVariance: 7600,
      hostingSpread: 6400,
    });
  });

  it("clamps out-of-range scores into 0..=10000", async () => {
    mockedRpc.mockResolvedValue({
      via: "operator-1",
      result: {
        clusterId: 1,
        score: 12000,
        asnVariance: -50,
        geoVariance: 10000,
        hostingSpread: 0,
      },
    });
    const r = await readClusterDiversity(1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.score).toBe(10_000);
    expect(r.data.asnVariance).toBe(0);
    expect(r.data.geoVariance).toBe(10_000);
    expect(r.data.hostingSpread).toBe(0);
  });

  it("propagates ok:false when the method is absent", async () => {
    mockedRpc.mockRejectedValue(methodNotFoundError("lyth_getClusterDiversity"));
    const r = await readClusterDiversity(0);
    expect(r.ok).toBe(false);
  });

  it("rejects a malformed response (score missing / non-numeric)", async () => {
    mockedRpc.mockResolvedValue({ via: "operator-1", result: { clusterId: 0 } });
    const r = await readClusterDiversity(0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/malformed/);
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

  // R18 — chain returns null for both scores until aggregation lands.
  // Wallet must thread null straight through so the popup hides the
  // rows entirely (per no-mock-fallback principle).
  it("preserves null reputationScore + livenessScore from chain", async () => {
    mockedRpc.mockResolvedValue({
      via: "operator-3",
      result: {
        clusterId: 0,
        threshold: 5,
        size: 7,
        live: 5,
        lagging: 0,
        offline: 0,
        maintenance: 2,
        members: [],
        epoch: null,
        round: null,
        quorum: "ok",
        reputationScore: null,
        livenessScore: null,
        lastUpdateHeight: 136812n,
      },
    });
    const r = await readClusterStatus(0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.reputationScore).toBeNull();
    expect(r.data.livenessScore).toBeNull();
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
// readOperatorInfo (R16 Task A)
// ─────────────────────────────────────────────────────────────────────────────

describe("readOperatorInfo", () => {
  it("normalises a well-formed lyth_operatorInfo response", async () => {
    mockedRpc.mockResolvedValue({
      via: "operator-1",
      result: {
        operatorId: "op-7",
        moniker: "halcyon-alpha",
        alias: null,
        chainAddress: "0x" + "ab".repeat(20),
        bonded: true,
        commissionBps: 500,
        delegationCount: 12,
        bondedAmount: "500000000000",
        activeClusterIds: [1, 3],
        operatorKeyFingerprint: "fp-1",
        blsKeyFingerprint: "fp-bls",
        lifecycleState: "active",
        capability: {},
      },
    });
    const r = await readOperatorInfo("op-7");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.operatorId).toBe("op-7");
    expect(r.data.moniker).toBe("halcyon-alpha");
    expect(r.data.bonded).toBe(true);
    expect(r.data.bondedAmount).toBe("500000000000");
    expect(r.data.commissionBps).toBe(500);
    expect(r.data.delegationCount).toBe(12);
    expect(r.data.lifecycleState).toBe("active");
    expect(r.via).toBe("operator-1");
  });

  it("propagates RPC failure as ok:false (per-operator bond is unique, not mocked)", async () => {
    mockedRpc.mockRejectedValue(new Error("timeout"));
    const r = await readOperatorInfo("op-1");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/timeout/);
  });

  it("rejects a malformed response (missing operatorId)", async () => {
    mockedRpc.mockResolvedValue({
      via: "operator-1",
      result: { bonded: true, bondedAmount: "0" },
    });
    const r = await readOperatorInfo("op-x");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/malformed/);
  });

  // Wire-contract anchor: a strict SDK OperatorInfoResponse must parse
  // without losing fields the wallet cares about.
  it("parses a strict SDK OperatorInfoResponse", async () => {
    const sdkShape: OperatorInfoResponse = {
      operatorId: "op-strict",
      moniker: "strict-moniker",
      alias: "alias-1",
      chainAddress: "0x" + "cc".repeat(20),
      bonded: true,
      commissionBps: 250,
      delegationCount: 4,
      bondedAmount: "5000" + "0".repeat(8), // 5,000 LYTH in lythoshi
      activeClusterIds: [2],
      operatorKeyFingerprint: null,
      blsKeyFingerprint: null,
      lifecycleState: "active",
      capability: { region: "eu-west" },
    };
    mockedRpc.mockResolvedValue({ via: "operator-2", result: sdkShape });
    const r = await readOperatorInfo("op-strict");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.operatorId).toBe("op-strict");
    expect(r.data.bondedAmount).toBe("500000000000");
    expect(r.data.commissionBps).toBe(250);
    expect(r.data.alias).toBe("alias-1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// readClusterServiceTiers (R16 Task B)
// ─────────────────────────────────────────────────────────────────────────────

describe("readClusterServiceTiers", () => {
  it("returns all-false + anyReachable:false for an empty operator list", async () => {
    const r = await readClusterServiceTiers([]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.anyReachable).toBe(false);
    expect(r.data.probedOperators).toBe(0);
    expect(r.data.rpc).toBe(false);
    expect(r.data.archive).toBe(false);
    // Should NOT have called the RPC at all.
    expect(mockedRpc).not.toHaveBeenCalled();
  });

  it("any-true aggregation: cluster offers tier when ≥1 operator reachable for that bit", async () => {
    // op-1 reachable for RPC (mask 1) + Archive (mask 8); op-2 reachable
    // for Indexer (mask 2). No operator reachable for Oracle (64) or
    // BridgeRelay (128). The wallet sends one probe per (operator, tier).
    mockedRpc.mockImplementation(
      async (method: string, params: unknown[]) => {
        if (method !== "lyth_getServiceProbe") {
          throw new Error(`unexpected method ${method}`);
        }
        const [operatorId, mask] = params as [string, number];
        if (operatorId === "op-1" && (mask === 1 || mask === 8)) {
          return { via: "op-1", result: { serviceMask: mask, status: "reachable" } };
        }
        if (operatorId === "op-2" && mask === 2) {
          return { via: "op-2", result: { serviceMask: mask, status: "reachable" } };
        }
        return { via: "op-x", result: { serviceMask: mask, status: "unreachable" } };
      },
    );
    const r = await readClusterServiceTiers(["op-1", "op-2"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.rpc).toBe(true);
    expect(r.data.indexer).toBe(true);
    expect(r.data.archive).toBe(true);
    expect(r.data.oracle).toBe(false);
    expect(r.data.bridgeRelay).toBe(false);
    expect(r.data.anyReachable).toBe(true);
    expect(r.data.probedOperators).toBe(2);
  });

  it("treats non-'reachable' statuses (degraded / unreachable / unknown) as false", async () => {
    mockedRpc.mockResolvedValue({
      via: "op-x",
      result: { serviceMask: 1, status: "degraded" },
    });
    const r = await readClusterServiceTiers(["op-1"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.rpc).toBe(false);
    expect(r.data.anyReachable).toBe(false);
    // probedOperators is still set because the probes resolved
    // (just not as "reachable").
    expect(r.data.probedOperators).toBe(1);
  });

  it("all probes failing leaves probedOperators=0 and anyReachable=false", async () => {
    mockedRpc.mockRejectedValue(new Error("operator unreachable"));
    const r = await readClusterServiceTiers(["op-1", "op-2"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.anyReachable).toBe(false);
    expect(r.data.probedOperators).toBe(0);
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

  // Phase 7.1 — wire-contract anchor mirroring the cluster directory's
  // typed fixture pattern. Constructs the strict SDK-shape envelope (cap
  // + bigint heights + bigint block number) and verifies the wallet
  // stringifies cleanly for IPC.
  it("parses a strict SDK DelegationCapResponse shape (bigint heights stringified)", async () => {
    mockedRpc.mockResolvedValue({
      via: "operator-2",
      result: {
        capBps: 5000,
        lastChangedAtHeight: 100_000n,
        blockNumber: 100_001n, // ignored by the wallet — chain-status covers it
      },
    });
    const r = await readDelegationCap();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.capBps).toBe(5000);
    expect(r.data.lastChangedAtHeight).toBe("100000");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// readClusterDelegators (Phase 7.1 — newly activated co-delegator reader)
// ─────────────────────────────────────────────────────────────────────────────

describe("readClusterDelegators", () => {
  it("normalises a well-formed lyth_getClusterDelegators response", async () => {
    mockedRpc.mockResolvedValue({
      via: "operator-3",
      result: {
        cluster: 7,
        delegators: ["0x" + "aa".repeat(20), "0x" + "bb".repeat(20)],
        count: 2,
      },
    });
    const r = await readClusterDelegators(7);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.cluster).toBe(7);
    expect(r.data.delegators).toHaveLength(2);
    expect(r.data.count).toBe(2);
  });

  it("preserves a chain-reported count that exceeds the returned list (cap case)", async () => {
    mockedRpc.mockResolvedValue({
      via: "operator-1",
      result: {
        cluster: 4,
        delegators: ["0x" + "11".repeat(20)],
        count: 247, // chain scanned 247 slots, capped to 1 returned
      },
    });
    const r = await readClusterDelegators(4);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.delegators).toHaveLength(1);
    expect(r.data.count).toBe(247);
  });

  it("falls back to empty on chain-offline", async () => {
    mockedRpc.mockRejectedValue(new Error("no operator"));
    const r = await readClusterDelegators(1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.via).toBe("mock");
    expect(r.data.delegators).toEqual([]);
    expect(r.data.count).toBe(0);
  });

  it("rejects a malformed response (missing cluster id)", async () => {
    mockedRpc.mockResolvedValue({
      via: "operator-1",
      result: { delegators: [], count: 0 },
    });
    const r = await readClusterDelegators(1);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/malformed/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// readPendingRewards
// ─────────────────────────────────────────────────────────────────────────────

describe("readPendingRewards", () => {
  const wallet = "0x" + "bb".repeat(20);

  it("prefers lyth_pendingRewards and preserves the RPC via", async () => {
    const total = 123_456_789n;
    const settled = 23_456_789n;
    const unsettled = 100_000_000n;
    const rowOne = 70_000_000n;
    const rowTwo = 30_000_000n;
    mockedRpc.mockResolvedValue({
      via: "operator-7",
      result: {
        wallet,
        totalAmountLythoshi: total.toString(10),
        settledPendingLythoshi: settled.toString(10),
        unsettledAmountLythoshi: unsettled.toString(10),
        autoCompound: true,
        rows: [
          {
            cluster: 1,
            weightBps: 2500,
            unsettledAmountLythoshi: rowOne.toString(10),
          },
          {
            cluster: 3,
            weightBps: 7500,
            unsettledAmountLythoshi: "0x" + rowTwo.toString(16),
          },
        ],
        block: 99_001n,
      },
    });

    const r = await readPendingRewards(wallet, [{ cluster: 999, weightBps: 1000 }]);
    // R17 — chain validates wallet param as bech32m; wallet converts before send.
    expect(mockedRpc).toHaveBeenCalledWith("lyth_pendingRewards", [
      userAddressForNativeRpc(wallet),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.via).toBe("operator-7");
    expect(r.data.wallet).toBe(wallet);
    expect(r.data.totalAmountLythoshi).toBe(total.toString(10));
    expect(r.data.settledPendingLythoshi).toBe(settled.toString(10));
    expect(r.data.unsettledAmountLythoshi).toBe(unsettled.toString(10));
    expect(r.data.autoCompound).toBe(true);
    expect(r.data.totalAmountWei).toBe("0x" + total.toString(16));
    expect(r.data.blockHeight).toBe("99001");
    expect(r.data.rows).toEqual([
      {
        cluster: 1,
        weightBps: 2500,
        unsettledAmountLythoshi: rowOne.toString(10),
        amountWei: "0x" + rowOne.toString(16),
        effectiveAprBps: null,
      },
      {
        cluster: 3,
        weightBps: 7500,
        unsettledAmountLythoshi: rowTwo.toString(10),
        amountWei: "0x" + rowTwo.toString(16),
        effectiveAprBps: null,
      },
    ]);
  });

  it("rejects malformed lyth_pendingRewards responses instead of mocking them", async () => {
    mockedRpc.mockResolvedValue({
      via: "operator-7",
      result: {
        wallet,
        totalAmountLythoshi: "1",
        settledPendingLythoshi: "0",
        unsettledAmountLythoshi: "1",
        autoCompound: false,
        rows: [{ cluster: 1, weightBps: "2500", unsettledAmountLythoshi: "1" }],
        block: 12,
      },
    });

    const r = await readPendingRewards(wallet, [{ cluster: 1, weightBps: 2500 }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/malformed lyth_pendingRewards/);
  });

  it("does not mock non-absence RPC errors", async () => {
    mockedRpc.mockRejectedValue(
      Object.assign(new Error("staking state unavailable"), {
        code: -32000,
        method: "lyth_pendingRewards",
        via: "operator-7",
      }),
    );

    const r = await readPendingRewards(wallet, [{ cluster: 1, weightBps: 2500 }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("staking state unavailable");
  });

  it("falls back to the mock derivation when lyth_pendingRewards is absent", async () => {
    mockedRpc.mockRejectedValue(methodNotFoundError());

    const r = await readPendingRewards(wallet, [{ cluster: 1, weightBps: 2000 }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.via).toBe("mock");
    expect(r.data.rows).toHaveLength(1);
  });

  it("falls back to the mock derivation on transport failure", async () => {
    mockedRpc.mockRejectedValue(new Error("no Monolythium Testnet operator reachable"));

    const r = await readPendingRewards(wallet, [{ cluster: 1, weightBps: 2000 }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.via).toBe("mock");
    expect(r.data.rows).toHaveLength(1);
  });

  it("emits lythoshi rewards through legacy amountWei compatibility fields", async () => {
    mockedRpc.mockRejectedValue(methodNotFoundError());

    const r = await readPendingRewards(wallet, [
      { cluster: 1, weightBps: 2000 },
      { cluster: 3, weightBps: 1000 },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.via).toBe("mock");
    expect(r.data.rows).toHaveLength(2);
    expect(r.data.rows[0]?.weightBps).toBe(2000);
    expect(r.data.rows[1]?.weightBps).toBe(1000);
    expect(r.data.rows[0]?.effectiveAprBps).toBe(MOCK_CLUSTER_APR_BPS[1]);
    expect(r.data.rows[1]?.effectiveAprBps).toBe(MOCK_CLUSTER_APR_BPS[3]);

    const firstLythoshi = expectedMockRewardLythoshi(
      2000,
      MOCK_CLUSTER_APR_BPS[1] ?? 0,
    );
    const secondLythoshi = expectedMockRewardLythoshi(
      1000,
      MOCK_CLUSTER_APR_BPS[3] ?? 0,
    );
    expect(firstLythoshi).toBeGreaterThan(0n);
    expect(r.data.rows[0]?.unsettledAmountLythoshi).toBe(
      firstLythoshi.toString(10),
    );
    expect(r.data.rows[1]?.unsettledAmountLythoshi).toBe(
      secondLythoshi.toString(10),
    );
    expect(r.data.rows[0]?.amountWei).toBe("0x" + firstLythoshi.toString(16));
    expect(r.data.rows[1]?.amountWei).toBe("0x" + secondLythoshi.toString(16));
    expect(r.data.totalAmountLythoshi).toBe(
      (firstLythoshi + secondLythoshi).toString(10),
    );
    expect(r.data.settledPendingLythoshi).toBe("0");
    expect(r.data.unsettledAmountLythoshi).toBe(
      (firstLythoshi + secondLythoshi).toString(10),
    );
    expect(r.data.autoCompound).toBe(false);
    expect(r.data.totalAmountWei).toBe(
      "0x" + (firstLythoshi + secondLythoshi).toString(16),
    );
  });

  it("emits a zero row when the cluster isn't in the mock APR table", async () => {
    mockedRpc.mockRejectedValue(methodNotFoundError());

    const r = await readPendingRewards(wallet, [{ cluster: 999, weightBps: 1000 }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.rows[0]?.effectiveAprBps).toBeNull();
    expect(r.data.rows[0]?.weightBps).toBe(1000);
    expect(r.data.rows[0]?.unsettledAmountLythoshi).toBe("0");
    expect(r.data.rows[0]?.amountWei).toBe("0x0");
    expect(r.data.totalAmountLythoshi).toBe("0");
    expect(r.data.totalAmountWei).toBe("0x0");
  });

  it("returns an empty rows[] for an unstaked wallet", async () => {
    mockedRpc.mockRejectedValue(methodNotFoundError());

    const r = await readPendingRewards(wallet, []);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.rows).toEqual([]);
    expect(r.data.totalAmountLythoshi).toBe("0");
    expect(r.data.totalAmountWei).toBe("0x0");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// readRedemptionQueue
// ─────────────────────────────────────────────────────────────────────────────

describe("readRedemptionQueue", () => {
  const wallet = "0x" + "dd".repeat(20);

  it("prefers lyth_redemptionQueue and preserves the RPC via", async () => {
    mockedRpc.mockResolvedValue({
      via: "operator-9",
      result: {
        wallet,
        tickets: [
          {
            index: 0,
            cluster: 7,
            weightBps: 2500,
            amount: "0x5f5e100",
            createdHeight: 10n,
            maturityHeight: "20",
            mature: false,
          },
          {
            index: 1,
            cluster: 8,
            weightBps: 1000,
            createdHeight: 12,
            maturityHeight: 22n,
            mature: null,
          },
        ],
        count: 2,
        returned: 2,
        block: "latest",
      },
    });

    const r = await readRedemptionQueue(wallet);
    // R17 — chain validates wallet param as bech32m; wallet converts before send.
    expect(mockedRpc).toHaveBeenCalledWith("lyth_redemptionQueue", [
      userAddressForNativeRpc(wallet),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.via).toBe("operator-9");
    expect(r.data.wallet).toBe(wallet);
    expect(r.data.rows).toEqual([
      {
        index: 0,
        cluster: 7,
        weightBps: 2500,
        amountLythoshi: "100000000",
        amountWei: "0x5f5e100",
        unlockAt: null,
        createdHeight: "10",
        maturityHeight: "20",
        mature: false,
      },
      {
        index: 1,
        cluster: 8,
        weightBps: 1000,
        amountLythoshi: null,
        amountWei: "0x0",
        unlockAt: null,
        createdHeight: "12",
        maturityHeight: "22",
        mature: null,
      },
    ]);
  });

  it("rejects malformed lyth_redemptionQueue responses instead of mocking them", async () => {
    mockedRpc.mockResolvedValue({
      via: "operator-9",
      result: {
        wallet,
        tickets: [
          {
            index: 0,
            cluster: 7,
            weightBps: "2500",
            createdHeight: 10,
            maturityHeight: 20,
            mature: false,
          },
        ],
        count: 1,
        returned: 1,
      },
    });

    const r = await readRedemptionQueue(wallet);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/malformed lyth_redemptionQueue/);
  });

  it("does not mock non-absence redemption RPC errors", async () => {
    mockedRpc.mockRejectedValue(
      Object.assign(new Error("redemption state unavailable"), {
        code: -32000,
        method: "lyth_redemptionQueue",
        via: "operator-9",
      }),
    );

    const r = await readRedemptionQueue(wallet);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("redemption state unavailable");
  });

  it("falls back to an empty mock queue when lyth_redemptionQueue is absent", async () => {
    mockedRpc.mockRejectedValue(methodNotFoundError("lyth_redemptionQueue"));

    const r = await readRedemptionQueue(wallet);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.via).toBe("mock");
    expect(r.data.rows).toEqual([]);
  });

  it("falls back to an empty mock queue on transport failure", async () => {
    mockedRpc.mockRejectedValue(new Error("no Monolythium Testnet operator reachable"));

    const r = await readRedemptionQueue(wallet);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.via).toBe("mock");
    expect(r.data).toEqual({ wallet, rows: [] });
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
    // R17 — bech32m conversion applied before RPC send.
    expect(receivedParams).toEqual([
      userAddressForNativeRpc(wallet),
      25,
      "cursor-page-2",
    ]);
  });

  it("omits cursor on first-page calls", async () => {
    let receivedParams: unknown[] | undefined;
    mockedRpc.mockImplementation(async (_method: string, params: unknown[]) => {
      receivedParams = params;
      return { via: "operator-1", result: [] };
    });
    await readDelegationHistory(wallet, 10);
    expect(receivedParams).toEqual([userAddressForNativeRpc(wallet), 10]);
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

// ─────────────────────────────────────────────────────────────────────────────
// R17 — bech32m wallet-param conversion regression
// ─────────────────────────────────────────────────────────────────────────────
//
// Chain validates `wallet` strictly as bech32m on every wallet-keyed
// lyth_* read (verified live: lyth_pendingRewards("0x...") returns
// -32602 "wallet must be mono bech32m"). The reads listed below
// receive an account address (typically 0x hex from the popup's
// account list) and must convert via userAddressForNativeRpc() before
// passing to sprintnetJsonRpc. This block pins the conversion at each
// site so any future regression surfaces as a test failure.

describe("R17 bech32m wallet-param conversion (regression)", () => {
  // SDK's addressToTypedBech32("user", 0xhex) emits a "mono1..." prefix.
  // We don't pin the full bech32m string (the SDK's helper is the
  // canonical encoder) — just that the param passed to the RPC layer
  // is NOT the raw 0x form and starts with "mono1".
  const hexWallet = "0x" + "ab".repeat(20);
  function captureRpcWalletParam(method: string): string | null {
    const calls = mockedRpc.mock.calls.filter(
      ([m]) => m === method,
    );
    if (calls.length === 0) return null;
    const params = calls[0]?.[1];
    if (!Array.isArray(params) || params.length === 0) return null;
    const first = params[0];
    return typeof first === "string" ? first : null;
  }

  it("readDelegations converts 0x wallet to mono1 bech32m", async () => {
    mockedRpc.mockResolvedValue({
      via: "operator-1",
      result: { wallet: hexWallet, rows: [], totalBps: 0 },
    });
    await readDelegations(hexWallet);
    const sent = captureRpcWalletParam("lyth_getDelegations");
    expect(sent).not.toBeNull();
    expect(sent).not.toBe(hexWallet);
    expect(sent?.startsWith("mono1")).toBe(true);
  });

  it("readDelegationHistory converts 0x wallet to mono1 bech32m", async () => {
    mockedRpc.mockResolvedValue({ via: "operator-1", result: [] });
    await readDelegationHistory(hexWallet);
    const sent = captureRpcWalletParam("lyth_getDelegationHistory");
    expect(sent).not.toBeNull();
    expect(sent).not.toBe(hexWallet);
    expect(sent?.startsWith("mono1")).toBe(true);
  });

  it("readPendingRewards converts 0x wallet to mono1 bech32m", async () => {
    mockedRpc.mockResolvedValue({
      via: "operator-1",
      result: {
        wallet: hexWallet,
        totalAmountLythoshi: "0",
        settledPendingLythoshi: "0",
        unsettledAmountLythoshi: "0",
        autoCompound: false,
        rows: [],
        block: "latest",
      },
    });
    await readPendingRewards(hexWallet, []);
    const sent = captureRpcWalletParam("lyth_pendingRewards");
    expect(sent).not.toBeNull();
    expect(sent).not.toBe(hexWallet);
    expect(sent?.startsWith("mono1")).toBe(true);
  });

  it("readRedemptionQueue converts 0x wallet to mono1 bech32m", async () => {
    mockedRpc.mockResolvedValue({
      via: "operator-1",
      result: { wallet: hexWallet, tickets: [], count: 0, returned: 0 },
    });
    await readRedemptionQueue(hexWallet);
    const sent = captureRpcWalletParam("lyth_redemptionQueue");
    expect(sent).not.toBeNull();
    expect(sent).not.toBe(hexWallet);
    expect(sent?.startsWith("mono1")).toBe(true);
  });

  it("passes already-bech32m wallet through unchanged", async () => {
    const bech = "mono1qy7fyqqqqqqqqqqqqqqqqqqqqqqqqqqqq6kzzqx";
    mockedRpc.mockResolvedValue({
      via: "operator-1",
      result: { wallet: bech, rows: [], totalBps: 0 },
    });
    await readDelegations(bech);
    const sent = captureRpcWalletParam("lyth_getDelegations");
    expect(sent).toBe(bech);
  });
});
