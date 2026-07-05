// autovote algorithm tests.
//
// Whitepaper §23.9 mandates four behavioural properties that the test
// suite pins explicitly:
//
//   1. Determinism: same seed + same input → byte-identical
//      allocations. (Two delegators on different machines reading the
//      same cluster directory produce the same plan; the algorithm
//      doesn't depend on Date.now() or Math.random().)
//
//   2. Per-user uniqueness: different seeds + same input → typically
//      different allocations. ("Two delegators picking Max Yield don't
//      end up at the same cluster set.") Tested over a small seed
//      sample at the §23.6 launch cap (50%).
//
//   3. Cap enforcement: no allocation exceeds the per-cluster cap; the
//      sum of allocations never exceeds the requested target. Includes
//      the disabled-cap case (capBps === null → no per-cluster ceiling).
//
//   4. Mode-specific selection: Max Yield prefers high-APR; Max
//      Diversity meets §23.6 minimum-diversification; Max
//      Decentralization prefers high-region-spread + low-correlation;
//      Custom passes through with cap enforcement.

import { describe, expect, it } from "vitest";
import {
  pickCustom,
  pickMaxDecentralization,
  pickMaxDiversity,
  pickMaxYield,
} from "./autovote.js";
import { MOCK_CLUSTERS } from "./__fixtures__/mock-clusters.js";
import {
  MOCK_CLUSTER_APR_BPS,
  type ClusterDirectoryEntry,
} from "./staking.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const SEED_ALICE = new Uint8Array(32).map((_, i) => i + 1);
const SEED_BOB = new Uint8Array(32).map((_, i) => (i + 1) * 7 + 13);
const SEED_ZERO = new Uint8Array(32);

const PHASE_12_CAP_BPS = 5000;
const PHASE_12_MIN_DIV = 2;
const PHASE_15_CAP_BPS = 1000;
const PHASE_15_MIN_DIV = 10;

// ─────────────────────────────────────────────────────────────────────────────
// pickMaxYield
// ─────────────────────────────────────────────────────────────────────────────

describe("pickMaxYield", () => {
  it("emits no allocations when the cluster list is empty", () => {
    const r = pickMaxYield({
      clusters: [],
      targetTotalBps: 5000,
      capBps: PHASE_12_CAP_BPS,
      seed: SEED_ALICE,
      minDiversification: PHASE_12_MIN_DIV,
    });
    expect(r.allocations).toEqual([]);
    expect(r.totalAllocatedBps).toBe(0);
    expect(r.reason).toMatch(/no eligible/);
  });

  it("respects the per-cluster cap when allocating", () => {
    const r = pickMaxYield({
      clusters: MOCK_CLUSTERS,
      targetTotalBps: 10_000,
      capBps: PHASE_12_CAP_BPS, // 5000
      seed: SEED_ALICE,
      minDiversification: PHASE_12_MIN_DIV,
    });
    for (const a of r.allocations) {
      expect(a.weightBps).toBeLessThanOrEqual(PHASE_12_CAP_BPS);
    }
    expect(r.totalAllocatedBps).toBeLessThanOrEqual(10_000);
  });

  it("is deterministic for a given seed", () => {
    const a = pickMaxYield({
      clusters: MOCK_CLUSTERS,
      targetTotalBps: 5000,
      capBps: PHASE_15_CAP_BPS,
      seed: SEED_ALICE,
      minDiversification: PHASE_15_MIN_DIV,
    });
    const b = pickMaxYield({
      clusters: MOCK_CLUSTERS,
      targetTotalBps: 5000,
      capBps: PHASE_15_CAP_BPS,
      seed: SEED_ALICE,
      minDiversification: PHASE_15_MIN_DIV,
    });
    expect(a.allocations).toEqual(b.allocations);
  });

  it("produces different allocations for different seeds (§23.9 per-user entropy)", () => {
    // Cap = 1000 bps; target = 1000 → picks a single cluster from the
    // shuffled top-APR bracket. Sample 8 distinct seeds and assert the
    // set of "first cluster picked" has ≥2 entries — two random
    // shuffles of a 3-cluster bracket each have a 1/3 chance of
    // landing on the same first element, but across 8 seeds the
    // probability of monoculture is < 0.01.
    const firstPicks = new Set<number>();
    for (let i = 0; i < 8; i++) {
      const seed = new Uint8Array(32).map((_, j) => (j + 1) * (i * 7 + 3));
      const r = pickMaxYield({
        clusters: MOCK_CLUSTERS,
        targetTotalBps: 1000,
        capBps: PHASE_15_CAP_BPS,
        seed,
        minDiversification: PHASE_15_MIN_DIV,
      });
      if (r.allocations[0] !== undefined) {
        firstPicks.add(r.allocations[0].cluster);
      }
    }
    expect(firstPicks.size).toBeGreaterThanOrEqual(2);
  });

  it("prefers higher-APR clusters within the top tier", () => {
    // The top-tier is "within 15% of top APR". Top APR in the mocks is
    // cluster 6 at 1010 bps. The bracket includes clusters with APR ≥
    // ~858 bps. Tail clusters (apr < bracket) appear later in the
    // ordering. We test that the first allocation comes from the
    // bracket regardless of seed.
    const topAprBps = Math.max(
      ...MOCK_CLUSTERS.map((c) => MOCK_CLUSTER_APR_BPS[c.clusterId] ?? 0),
    );
    const bracketFloor = Math.floor(topAprBps * 0.85);
    const inBracket = new Set(
      MOCK_CLUSTERS.filter(
        (c) => (MOCK_CLUSTER_APR_BPS[c.clusterId] ?? 0) >= bracketFloor,
      ).map((c) => c.clusterId),
    );
    for (const seed of [SEED_ALICE, SEED_BOB, SEED_ZERO]) {
      const r = pickMaxYield({
        clusters: MOCK_CLUSTERS,
        targetTotalBps: 1000,
        capBps: PHASE_15_CAP_BPS,
        seed,
        minDiversification: PHASE_12_MIN_DIV,
      });
      expect(r.allocations[0]).toBeDefined();
      expect(inBracket.has(r.allocations[0]!.cluster)).toBe(true);
    }
  });

  it("handles disabled cap (capBps = null) by leaving the full target on one cluster", () => {
    const r = pickMaxYield({
      clusters: MOCK_CLUSTERS,
      targetTotalBps: 5000,
      capBps: null,
      seed: SEED_ALICE,
      minDiversification: PHASE_12_MIN_DIV,
    });
    // Cap disabled → first cluster takes the whole target.
    expect(r.allocations).toHaveLength(1);
    expect(r.allocations[0]?.weightBps).toBe(5000);
  });

  it("reports shortfall when the cap arithmetic can't satisfy the target", () => {
    // Target 10000 bps but only 1 eligible cluster + cap 5000 bps →
    // 5000 bps shortfall.
    const single: ClusterDirectoryEntry[] = [MOCK_CLUSTERS[0]!];
    const r = pickMaxYield({
      clusters: single,
      targetTotalBps: 10_000,
      capBps: 5000,
      seed: SEED_ALICE,
      minDiversification: 1,
    });
    expect(r.totalAllocatedBps).toBe(5000);
    expect(r.shortfallBps).toBe(5000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pickMaxDiversity
// ─────────────────────────────────────────────────────────────────────────────

describe("pickMaxDiversity", () => {
  it("meets the §23.6 minimum-diversification floor", () => {
    const r = pickMaxDiversity({
      clusters: MOCK_CLUSTERS,
      targetTotalBps: 5000,
      capBps: PHASE_12_CAP_BPS,
      seed: SEED_ALICE,
      minDiversification: PHASE_12_MIN_DIV, // 2
    });
    expect(r.allocations.length).toBeGreaterThanOrEqual(PHASE_12_MIN_DIV);
  });

  it("picks at least ceil(target / cap) clusters when cap is binding", () => {
    // 5000 bps target + 1000 bps cap → at least 5 clusters needed.
    const r = pickMaxDiversity({
      clusters: MOCK_CLUSTERS,
      targetTotalBps: 5000,
      capBps: PHASE_15_CAP_BPS,
      seed: SEED_ALICE,
      minDiversification: 2, // less than cap-implied minimum
    });
    expect(r.allocations.length).toBeGreaterThanOrEqual(5);
  });

  it("never exceeds the per-cluster cap on any allocation", () => {
    const r = pickMaxDiversity({
      clusters: MOCK_CLUSTERS,
      targetTotalBps: 8000,
      capBps: PHASE_15_CAP_BPS,
      seed: SEED_ALICE,
      minDiversification: PHASE_15_MIN_DIV,
    });
    for (const a of r.allocations) {
      expect(a.weightBps).toBeLessThanOrEqual(PHASE_15_CAP_BPS);
    }
  });

  it("is deterministic for a given seed", () => {
    const a = pickMaxDiversity({
      clusters: MOCK_CLUSTERS,
      targetTotalBps: 5000,
      capBps: PHASE_15_CAP_BPS,
      seed: SEED_ALICE,
      minDiversification: PHASE_15_MIN_DIV,
    });
    const b = pickMaxDiversity({
      clusters: MOCK_CLUSTERS,
      targetTotalBps: 5000,
      capBps: PHASE_15_CAP_BPS,
      seed: SEED_ALICE,
      minDiversification: PHASE_15_MIN_DIV,
    });
    expect(a.allocations).toEqual(b.allocations);
  });

  it("produces different allocations for different seeds", () => {
    const alice = pickMaxDiversity({
      clusters: MOCK_CLUSTERS,
      targetTotalBps: 5000,
      capBps: PHASE_12_CAP_BPS,
      seed: SEED_ALICE,
      minDiversification: PHASE_12_MIN_DIV,
    });
    const bob = pickMaxDiversity({
      clusters: MOCK_CLUSTERS,
      targetTotalBps: 5000,
      capBps: PHASE_12_CAP_BPS,
      seed: SEED_BOB,
      minDiversification: PHASE_12_MIN_DIV,
    });
    expect(alice.allocations).not.toEqual(bob.allocations);
  });

  it("returns empty when the cluster list is empty", () => {
    const r = pickMaxDiversity({
      clusters: [],
      targetTotalBps: 5000,
      capBps: PHASE_12_CAP_BPS,
      seed: SEED_ALICE,
      minDiversification: 2,
    });
    expect(r.allocations).toEqual([]);
  });

  it("ranks the highest real §25.1 diversity score first when present", () => {
    // Two healthy independent clusters, equal reputation-table absence
    // (both fall to the 0.5 default), differing only in their real chain
    // diversity score. With capBps = target the algorithm picks one
    // cluster; the higher chain score must be first.
    const lowDiversity: ClusterDirectoryEntry = {
      clusterId: 300,
      name: "low-div",
      size: 10,
      threshold: 7,
      health: "healthy",
      regions: ["fsn1"],
      active: true,
      entity: "independent",
      diversityScore: 1000,
      asnVariance: 1000,
      geoVariance: 1000,
      hostingSpread: 1000,
    };
    const highDiversity: ClusterDirectoryEntry = {
      clusterId: 301,
      name: "high-div",
      size: 10,
      threshold: 7,
      health: "healthy",
      regions: ["fsn1"],
      active: true,
      entity: "independent",
      diversityScore: 9900,
      asnVariance: 9900,
      geoVariance: 9900,
      hostingSpread: 9900,
    };
    const r = pickMaxDiversity({
      clusters: [lowDiversity, highDiversity],
      targetTotalBps: 1000,
      capBps: 1000,
      seed: SEED_ALICE,
      minDiversification: 1,
    });
    expect(r.allocations[0]?.cluster).toBe(301);
  });

  it("filters offline clusters but keeps healthy/degraded", () => {
    const mix: ClusterDirectoryEntry[] = [
      ...MOCK_CLUSTERS,
      {
        clusterId: 99,
        name: "down.cluster.mono",
        size: 10,
        threshold: 7,
        health: "offline",
        regions: ["fsn1"],
        active: true,
        entity: "independent",
      },
    ];
    const r = pickMaxDiversity({
      clusters: mix,
      targetTotalBps: 5000,
      capBps: PHASE_15_CAP_BPS,
      seed: SEED_ALICE,
      minDiversification: PHASE_15_MIN_DIV,
    });
    for (const a of r.allocations) {
      expect(a.cluster).not.toBe(99);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pickMaxDecentralization
// ─────────────────────────────────────────────────────────────────────────────

describe("pickMaxDecentralization", () => {
  it("is deterministic for a given seed", () => {
    const a = pickMaxDecentralization({
      clusters: MOCK_CLUSTERS,
      targetTotalBps: 5000,
      capBps: PHASE_12_CAP_BPS,
      seed: SEED_ALICE,
      minDiversification: PHASE_12_MIN_DIV,
    });
    const b = pickMaxDecentralization({
      clusters: MOCK_CLUSTERS,
      targetTotalBps: 5000,
      capBps: PHASE_12_CAP_BPS,
      seed: SEED_ALICE,
      minDiversification: PHASE_12_MIN_DIV,
    });
    expect(a.allocations).toEqual(b.allocations);
  });

  it("produces different allocations for different seeds", () => {
    const alice = pickMaxDecentralization({
      clusters: MOCK_CLUSTERS,
      targetTotalBps: 5000,
      capBps: PHASE_12_CAP_BPS,
      seed: SEED_ALICE,
      minDiversification: PHASE_12_MIN_DIV,
    });
    const bob = pickMaxDecentralization({
      clusters: MOCK_CLUSTERS,
      targetTotalBps: 5000,
      capBps: PHASE_12_CAP_BPS,
      seed: SEED_BOB,
      minDiversification: PHASE_12_MIN_DIV,
    });
    expect(alice.allocations).not.toEqual(bob.allocations);
  });

  it("respects the per-cluster cap", () => {
    const r = pickMaxDecentralization({
      clusters: MOCK_CLUSTERS,
      targetTotalBps: 5000,
      capBps: PHASE_15_CAP_BPS,
      seed: SEED_ALICE,
      minDiversification: PHASE_15_MIN_DIV,
    });
    for (const a of r.allocations) {
      expect(a.weightBps).toBeLessThanOrEqual(PHASE_15_CAP_BPS);
    }
  });

  it("prefers clusters with more regions over fewer (geographic spread)", () => {
    // Two clusters: low-spread (1 region) vs high-spread (4 regions),
    // equal everything else. Decentralization should prefer high-spread.
    const lowSpread: ClusterDirectoryEntry = {
      clusterId: 100,
      name: "low",
      size: 10,
      threshold: 7,
      health: "healthy",
      regions: ["fsn1"],
      active: true,
      entity: "independent",
    };
    const highSpread: ClusterDirectoryEntry = {
      clusterId: 101,
      name: "high",
      size: 10,
      threshold: 7,
      health: "healthy",
      regions: ["fsn1", "nbg1", "hel1", "ash"],
      active: true,
      entity: "independent",
    };
    const r = pickMaxDecentralization({
      clusters: [lowSpread, highSpread],
      targetTotalBps: 1000,
      capBps: 1000,
      seed: SEED_ALICE,
      minDiversification: 1,
    });
    // First allocation must be the high-spread cluster.
    expect(r.allocations[0]?.cluster).toBe(101);
  });

  it("prefers the real §25.1 diversity entropy over region-count when present", () => {
    // Cluster A: only 1 region but HIGH chain ASN/geo/hosting entropy.
    // Cluster B: 4 regions but LOW chain entropy. When the chain has
    // surfaced a real ClusterDiversityView, the chain entropy wins over
    // the region-count heuristic, so A must be picked first.
    const realHighEntropyOneRegion: ClusterDirectoryEntry = {
      clusterId: 200,
      name: "real-high",
      size: 10,
      threshold: 7,
      health: "healthy",
      regions: ["fsn1"],
      active: true,
      entity: "independent",
      diversityScore: 9500,
      asnVariance: 9800,
      geoVariance: 9200,
      hostingSpread: 9600,
    };
    const realLowEntropyManyRegions: ClusterDirectoryEntry = {
      clusterId: 201,
      name: "real-low",
      size: 10,
      threshold: 7,
      health: "healthy",
      regions: ["fsn1", "nbg1", "hel1", "ash"],
      active: true,
      entity: "independent",
      diversityScore: 1200,
      asnVariance: 800,
      geoVariance: 1000,
      hostingSpread: 1500,
    };
    const r = pickMaxDecentralization({
      clusters: [realLowEntropyManyRegions, realHighEntropyOneRegion],
      targetTotalBps: 1000,
      capBps: 1000,
      seed: SEED_ALICE,
      minDiversification: 1,
    });
    expect(r.allocations[0]?.cluster).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pickCustom
// ─────────────────────────────────────────────────────────────────────────────

describe("pickCustom", () => {
  it("passes valid allocations through, sorted by cluster id", () => {
    const r = pickCustom({
      allocations: [
        { cluster: 3, weightBps: 1500 },
        { cluster: 1, weightBps: 2000 },
        { cluster: 2, weightBps: 500 },
      ],
      capBps: 5000,
    });
    expect(r.allocations).toEqual([
      { cluster: 1, weightBps: 2000 },
      { cluster: 2, weightBps: 500 },
      { cluster: 3, weightBps: 1500 },
    ]);
    expect(r.totalAllocatedBps).toBe(4000);
    expect(r.shortfallBps).toBe(0);
  });

  it("clips per-cluster allocations at the cap and reports shortfall", () => {
    const r = pickCustom({
      allocations: [{ cluster: 1, weightBps: 8000 }],
      capBps: 5000,
    });
    expect(r.allocations).toEqual([{ cluster: 1, weightBps: 5000 }]);
    expect(r.shortfallBps).toBe(3000);
  });

  it("clips total at MAX_TOTAL_BPS (10000)", () => {
    const r = pickCustom({
      allocations: [
        { cluster: 1, weightBps: 5000 },
        { cluster: 2, weightBps: 5000 },
        { cluster: 3, weightBps: 5000 },
      ],
      capBps: 5000,
    });
    expect(r.totalAllocatedBps).toBe(10_000);
  });

  it("merges duplicate cluster ids", () => {
    const r = pickCustom({
      allocations: [
        { cluster: 1, weightBps: 1000 },
        { cluster: 1, weightBps: 1500 },
        { cluster: 2, weightBps: 500 },
      ],
      capBps: 5000,
    });
    const oneAlloc = r.allocations.find((a) => a.cluster === 1);
    expect(oneAlloc?.weightBps).toBe(2500);
  });

  it("rejects non-positive weights silently", () => {
    const r = pickCustom({
      allocations: [
        { cluster: 1, weightBps: 0 },
        { cluster: 2, weightBps: -500 },
        { cluster: 3, weightBps: 1000 },
      ],
      capBps: 5000,
    });
    expect(r.allocations).toEqual([{ cluster: 3, weightBps: 1000 }]);
  });

  it("treats null cap as unlimited per-cluster", () => {
    const r = pickCustom({
      allocations: [{ cluster: 1, weightBps: 8000 }],
      capBps: null,
    });
    expect(r.allocations).toEqual([{ cluster: 1, weightBps: 8000 }]);
    expect(r.shortfallBps).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-mode invariants
// ─────────────────────────────────────────────────────────────────────────────

describe("cross-mode invariants", () => {
  it("totalAllocatedBps never exceeds targetTotalBps for any mode", () => {
    const target = 5000;
    const cases = [
      pickMaxYield({
        clusters: MOCK_CLUSTERS,
        targetTotalBps: target,
        capBps: PHASE_15_CAP_BPS,
        seed: SEED_ALICE,
        minDiversification: PHASE_15_MIN_DIV,
      }),
      pickMaxDiversity({
        clusters: MOCK_CLUSTERS,
        targetTotalBps: target,
        capBps: PHASE_15_CAP_BPS,
        seed: SEED_ALICE,
        minDiversification: PHASE_15_MIN_DIV,
      }),
      pickMaxDecentralization({
        clusters: MOCK_CLUSTERS,
        targetTotalBps: target,
        capBps: PHASE_15_CAP_BPS,
        seed: SEED_ALICE,
        minDiversification: PHASE_15_MIN_DIV,
      }),
    ];
    for (const r of cases) {
      expect(r.totalAllocatedBps).toBeLessThanOrEqual(target);
    }
  });

  it("all autovote modes produce allocations that sum to totalAllocatedBps", () => {
    const cases = [
      pickMaxYield({
        clusters: MOCK_CLUSTERS,
        targetTotalBps: 5000,
        capBps: PHASE_12_CAP_BPS,
        seed: SEED_ALICE,
        minDiversification: PHASE_12_MIN_DIV,
      }),
      pickMaxDiversity({
        clusters: MOCK_CLUSTERS,
        targetTotalBps: 5000,
        capBps: PHASE_12_CAP_BPS,
        seed: SEED_ALICE,
        minDiversification: PHASE_12_MIN_DIV,
      }),
      pickMaxDecentralization({
        clusters: MOCK_CLUSTERS,
        targetTotalBps: 5000,
        capBps: PHASE_12_CAP_BPS,
        seed: SEED_ALICE,
        minDiversification: PHASE_12_MIN_DIV,
      }),
    ];
    for (const r of cases) {
      const sum = r.allocations.reduce((s, a) => s + a.weightBps, 0);
      expect(sum).toBe(r.totalAllocatedBps);
    }
  });
});
