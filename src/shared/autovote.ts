// Phase 7 — §23.9 four-button autovote algorithm.
//
// The whitepaper mandates four named modes plus per-user entropy so two
// delegators picking the same mode don't end up at the same cluster set:
//
//   Max Yield          → highest-APR clusters consistent with the cap
//   Max Diversity      → spread across as many clusters as the cap
//                        allows, weighted by reputation × liveness
//   Max Decentralization → actively route stake away from clusters with
//                        high correlated-preference scores or geographic
//                        concentration
//   Custom             → pass-through with cap enforcement
//
// All allocation respects the chain-side delegation cap (§23.6). Per-
// cluster cap is in bps; the total delegation target the user wants
// to distribute is in bps (e.g., 5000 = 50% of wallet); the algorithm
// returns allocations that sum to ≤ user target.
//
// Per-user entropy is a 32-byte seed; the SW derives it from the
// unlocked ML-DSA-65 public key + the "monolythium.autovote.v1"
// domain tag (see staking-autovote-seed IPC handler). The popup
// fetches the seed once per session and passes it into every
// pick* call.
//
// Sampling is deterministic given the seed — same seed + same input
// → same allocations. The test suite pins this property explicitly.

import { shake256 } from "@noble/hashes/sha3.js";
import {
  DIVERSITY_SCORE_MAX,
  MOCK_CLUSTER_APR_BPS,
  MOCK_CLUSTER_REPUTATION,
  type ClusterDirectoryEntry,
} from "./staking.js";

/** Four-mode taxonomy. The string union mirrors the whitepaper labels
 *  so the UI's mode-selector renders them verbatim. */
export type AutovoteMode =
  | "max-yield"
  | "max-diversity"
  | "max-decentralization"
  | "custom";

/** One row in an allocation plan. */
export interface AutovoteAllocation {
  /** Cluster id receiving the weight. */
  cluster: number;
  /** Weight in basis points. */
  weightBps: number;
}

/** Output of every pick* function. */
export interface AutovoteResult {
  allocations: AutovoteAllocation[];
  /** Sum of `allocations[].weightBps`. The caller usually wants this
   *  to be ≤ the requested target; tests assert it. */
  totalAllocatedBps: number;
  /** Human-readable rationale displayed under the mode pill in the UI.
   *  Example: `"spread 5000 bps across 5 clusters @ 1000 bps each"`. */
  reason: string;
  /** When the cap forced the algorithm to allocate less than the
   *  requested target, the deficit is reported here in bps. The UI
   *  surfaces this as "couldn't reach your target — increase
   *  diversification or reduce target." */
  shortfallBps: number;
}

/** Input bundle for `pickMaxYield` / `pickMaxDiversity` /
 *  `pickMaxDecentralization`. */
export interface AutovoteInput {
  /** All active clusters from `lyth_clusterDirectory`. */
  clusters: ReadonlyArray<ClusterDirectoryEntry>;
  /** Total weight the user wants to delegate, in bps. */
  targetTotalBps: number;
  /** Per-cluster cap in bps (chain-side cap from §23.6). `null` means
   *  the chain has disabled the cap (`u32::MAX`). */
  capBps: number | null;
  /** Per-user entropy. Must be 32 bytes; shorter input falls back to
   *  a zero-padded seed (the algorithm still produces deterministic
   *  output but uniqueness across users degrades). */
  seed: Uint8Array;
  /** Minimum number of clusters the result must touch (§23.6
   *  diversification floor: Phase 12 = 2, Phase 13 = 4, Phase 14 = 7,
   *  Phase 15 = 10). Algorithm picks at least this many when the
   *  capped allocation would otherwise concentrate. */
  minDiversification: number;
}

/** Input bundle for `pickCustom`. */
export interface CustomInput {
  /** User-supplied per-cluster allocations. */
  allocations: ReadonlyArray<AutovoteAllocation>;
  /** Per-cluster cap from §23.6. */
  capBps: number | null;
}

/** Maximum total weight (bps) any wallet can delegate (§23.6). */
const MAX_TOTAL_BPS = 10_000;

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic PRNG (SHAKE256-based)
// ─────────────────────────────────────────────────────────────────────────────

/** Pull `count` u32 values from a SHAKE256 expansion of (seed || tag).
 *  Tag domain-separates each call site (e.g., "max-yield-shuffle")
 *  so we get independent streams per mode without re-seeding. */
function deriveU32Stream(
  seed: Uint8Array,
  tag: string,
  count: number,
): Uint32Array {
  if (count <= 0) return new Uint32Array(0);
  const enc = new TextEncoder();
  const tagBytes = enc.encode(tag);
  const buf = new Uint8Array(seed.length + tagBytes.length);
  buf.set(seed, 0);
  buf.set(tagBytes, seed.length);
  const bytes = shake256(buf, { dkLen: count * 4 });
  const out = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    out[i] =
      (bytes[i * 4]! << 24) |
      (bytes[i * 4 + 1]! << 16) |
      (bytes[i * 4 + 2]! << 8) |
      bytes[i * 4 + 3]!;
  }
  return out;
}

/** Fisher-Yates shuffle, seeded. Mutates and returns the input array. */
function shuffle<T>(arr: T[], seed: Uint8Array, tag: string): T[] {
  if (arr.length < 2) return arr;
  const stream = deriveU32Stream(seed, tag, arr.length - 1);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = stream[arr.length - 1 - i]! % (i + 1);
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cluster metadata accessors (mock-aware)
// ─────────────────────────────────────────────────────────────────────────────

/** APR in bps for a cluster. Prefers the live `aprBps` carried on the
 *  directory entry (`lyth_clusterApr`, populated by the staking-client
 *  fanout); falls back to the mock table when the chain read failed.
 *
 *  TODO(monolythium-vision): there is no per-cluster forward-looking APR
 *  field on `ClusterDiversityView` — Max Yield ranks on the observed
 *  `aprBps` baseline + the reputation/liveness proxy below. When the
 *  chain ships a yield-projection reader, swap the proxy for it. */
function clusterApr(c: ClusterDirectoryEntry): number {
  if (typeof c.aprBps === "number" && Number.isFinite(c.aprBps) && c.aprBps >= 0) {
    return c.aprBps;
  }
  return MOCK_CLUSTER_APR_BPS[c.clusterId] ?? 0;
}

/** Reputation score in [0, 1]. Falls back to 0.5 when unknown so a
 *  cluster without a reputation entry doesn't get either favored or
 *  buried. */
function clusterReputation(c: ClusterDirectoryEntry): number {
  return MOCK_CLUSTER_REPUTATION[c.clusterId] ?? 0.5;
}

/** True when the directory entry carries a real §25.1 diversity score
 *  from `lyth_getClusterDiversity` (the staking-client fanout leaves the
 *  diversity fields `null` when the chain read failed). */
function hasRealDiversity(c: ClusterDirectoryEntry): boolean {
  return typeof c.diversityScore === "number" && Number.isFinite(c.diversityScore);
}

/** §25.1 diversity rank score for Max Diversity. When the chain has
 *  surfaced a real `ClusterDiversityView`, rank on the headline score
 *  (normalised to `[0, 1]`) blended with reputation × liveness so a
 *  diverse-but-unreliable cluster doesn't dominate. Falls back to the
 *  reputation × liveness proxy (the pre-0.3.10 behaviour) when the chain
 *  score is absent. */
function diversityRankScore(c: ClusterDirectoryEntry): number {
  const liveness = c.health === "healthy" ? 1 : 0.5;
  if (hasRealDiversity(c)) {
    const norm = (c.diversityScore as number) / DIVERSITY_SCORE_MAX;
    // 70% chain diversity, 30% reputation × liveness — the chain score
    // is the authoritative §25.1 signal; reputation/liveness break ties.
    return norm * 0.7 + clusterReputation(c) * liveness * 0.3;
  }
  return clusterReputation(c) * liveness;
}

/** Decentralization score. Higher = more decentralized. When the chain
 *  has surfaced a real `ClusterDiversityView`, route on the
 *  ASN/geo/hosting entropy (the actual §25.1 decentralization signal)
 *  plus the independent-entity bonus. Falls back to the region-count +
 *  inverse-reputation + independence heuristic when the chain score is
 *  absent — keeping "Max Decentralization" and the ClusterPicker sort
 *  visually consistent on operators that don't expose the method yet. */
function decentralizationScore(c: ClusterDirectoryEntry): number {
  const independenceBonus = c.entity === "mono-labs" ? 0 : 0.15;
  if (hasRealDiversity(c)) {
    // ASN + geo + hosting entropy are the three §25.1 decentralization
    // dimensions; average them into `[0, 1]` and scale to a comparable
    // magnitude (×4) so the independence bonus stays a tie-breaker rather
    // than dominating, matching the heuristic's ~0..5 range.
    const asn = (c.asnVariance ?? 0) / DIVERSITY_SCORE_MAX;
    const geo = (c.geoVariance ?? 0) / DIVERSITY_SCORE_MAX;
    const hosting = (c.hostingSpread ?? 0) / DIVERSITY_SCORE_MAX;
    return ((asn + geo + hosting) / 3) * 4 + independenceBonus;
  }
  const regionCount = c.regions.length;
  const reputation = clusterReputation(c);
  return regionCount * 1.0 + (1 - reputation) * 0.5 + independenceBonus;
}

/** Filter to clusters eligible for any autovote mode. */
function eligibleClusters(
  clusters: ReadonlyArray<ClusterDirectoryEntry>,
): ClusterDirectoryEntry[] {
  return clusters.filter((c) => {
    if (!c.active) return false;
    // Offline + degraded clusters are filtered to keep autovote routing
    // toward functional teams (§14.Z drama externalization). The user
    // can still pick them manually via Custom.
    if (c.health === "offline") return false;
    return true;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Cap-aware allocation primitive
// ─────────────────────────────────────────────────────────────────────────────

/** Allocate `target` bps across `clusters` (in the given order) using a
 *  per-cluster cap. Used by every mode after sorting/filtering the
 *  cluster list. */
function allocateUpToCap(
  orderedClusters: ReadonlyArray<ClusterDirectoryEntry>,
  target: number,
  capBps: number | null,
): { allocations: AutovoteAllocation[]; allocated: number } {
  const allocations: AutovoteAllocation[] = [];
  let remaining = Math.max(0, Math.min(target, MAX_TOTAL_BPS));
  const perClusterMax =
    capBps === null ? MAX_TOTAL_BPS : Math.max(0, Math.min(capBps, MAX_TOTAL_BPS));
  if (perClusterMax === 0) {
    return { allocations: [], allocated: 0 };
  }
  for (const c of orderedClusters) {
    if (remaining === 0) break;
    const slice = Math.min(perClusterMax, remaining);
    allocations.push({ cluster: c.clusterId, weightBps: slice });
    remaining -= slice;
  }
  const allocated = allocations.reduce((s, a) => s + a.weightBps, 0);
  return { allocations, allocated };
}

/** Spread `target` bps evenly across the first `count` clusters with
 *  per-cluster cap. Any rounding remainder lands on the first
 *  allocation. Used by diversity-driven modes. */
function allocateEvenly(
  clusters: ReadonlyArray<ClusterDirectoryEntry>,
  target: number,
  capBps: number | null,
): { allocations: AutovoteAllocation[]; allocated: number } {
  if (clusters.length === 0 || target <= 0) {
    return { allocations: [], allocated: 0 };
  }
  const safeTarget = Math.max(0, Math.min(target, MAX_TOTAL_BPS));
  const perClusterMax =
    capBps === null ? MAX_TOTAL_BPS : Math.max(0, Math.min(capBps, MAX_TOTAL_BPS));
  if (perClusterMax === 0) {
    return { allocations: [], allocated: 0 };
  }
  // Even base + remainder on the first allocation. Cap each at perClusterMax.
  const baseRaw = Math.floor(safeTarget / clusters.length);
  const remainder = safeTarget - baseRaw * clusters.length;
  const allocations: AutovoteAllocation[] = [];
  let allocated = 0;
  for (let i = 0; i < clusters.length; i++) {
    let slice = baseRaw + (i === 0 ? remainder : 0);
    slice = Math.min(slice, perClusterMax);
    if (slice <= 0) continue;
    allocations.push({ cluster: clusters[i]!.clusterId, weightBps: slice });
    allocated += slice;
  }
  return { allocations, allocated };
}

// ─────────────────────────────────────────────────────────────────────────────
// Max Yield
// ─────────────────────────────────────────────────────────────────────────────

/** Sort clusters by APR descending, sample within the top tier, allocate
 *  cap-max top-down. */
export function pickMaxYield(input: AutovoteInput): AutovoteResult {
  const eligible = eligibleClusters(input.clusters);
  if (eligible.length === 0) {
    return emptyResult("no eligible clusters");
  }
  // Sort by APR descending. Tie-break by reputation × liveness so two
  // equally-yielding clusters use the secondary signal cleanly.
  const sorted = eligible.slice().sort((a, b) => {
    const dApr = clusterApr(b) - clusterApr(a);
    if (dApr !== 0) return dApr;
    return clusterReputation(b) - clusterReputation(a);
  });
  // Bracket: clusters within 15% APR of the top get shuffled together so
  // two delegators picking Max Yield don't both land on the single
  // highest cluster (§23.9 anti-concentration property). The 15% width
  // is calibrated for the §23.5 quadratic-curve regime where APRs
  // typically spread within 1-2 percentage points across the top tier;
  // a 5% bracket would collapse to a single cluster on small operator
  // sets and defeat the entropy property.
  const topApr = clusterApr(sorted[0]!);
  const aprFloor = Math.floor(topApr * 0.85);
  const topBracket: ClusterDirectoryEntry[] = [];
  const tail: ClusterDirectoryEntry[] = [];
  for (const c of sorted) {
    if (clusterApr(c) >= aprFloor) topBracket.push(c);
    else tail.push(c);
  }
  shuffle(topBracket, input.seed, "max-yield-bracket");
  const ordered = topBracket.concat(tail);
  const { allocations, allocated } = allocateUpToCap(
    ordered,
    input.targetTotalBps,
    input.capBps,
  );
  return {
    allocations,
    totalAllocatedBps: allocated,
    shortfallBps: Math.max(0, input.targetTotalBps - allocated),
    reason: `Allocated ${allocated} bps across ${allocations.length} cluster(s) — highest-APR first, top bracket shuffled per-user.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Max Diversity
// ─────────────────────────────────────────────────────────────────────────────

/** Pick enough clusters to satisfy §23.6 minimum diversification AND
 *  the cap arithmetic (e.g., 50% target + 10% cap → 5 clusters minimum).
 *  Weight selection by reputation × liveness; shuffle within the top
 *  tier with per-user seed. */
export function pickMaxDiversity(input: AutovoteInput): AutovoteResult {
  const eligible = eligibleClusters(input.clusters);
  if (eligible.length === 0) {
    return emptyResult("no eligible clusters");
  }
  const target = Math.max(0, Math.min(input.targetTotalBps, MAX_TOTAL_BPS));
  // Cap-implied minimum: ceil(target / cap) clusters needed to spread
  // the target without exceeding the cap on any single one.
  const capImplied =
    input.capBps === null ? 1 : Math.ceil(target / Math.max(1, input.capBps));
  const wanted = Math.max(input.minDiversification, capImplied, 1);
  const count = Math.min(wanted, eligible.length);
  // Rank by the §25.1 diversity rank score — real chain
  // `ClusterDiversityView` (score × reputation × liveness) when present,
  // falling back to the reputation × liveness proxy otherwise.
  const ranked = eligible.slice().sort((a, b) => {
    return diversityRankScore(b) - diversityRankScore(a);
  });
  // Top tier = clusters within 10% rank-score of the top, capped at
  // 2 * count so the seed has a meaningful sample size; shuffle the
  // tier; concat the rest.
  const topScore = diversityRankScore(ranked[0]!);
  const scoreFloor = Math.max(0, topScore - 0.1);
  const topBracket: ClusterDirectoryEntry[] = [];
  const tail: ClusterDirectoryEntry[] = [];
  for (const c of ranked) {
    if (diversityRankScore(c) >= scoreFloor && topBracket.length < count * 2) {
      topBracket.push(c);
    } else {
      tail.push(c);
    }
  }
  shuffle(topBracket, input.seed, "max-diversity-bracket");
  const picked = topBracket.concat(tail).slice(0, count);
  const { allocations, allocated } = allocateEvenly(
    picked,
    target,
    input.capBps,
  );
  return {
    allocations,
    totalAllocatedBps: allocated,
    shortfallBps: Math.max(0, target - allocated),
    reason: `Spread ${allocated} bps evenly across ${allocations.length} cluster(s) — reputation × liveness weighted, top bracket shuffled per-user.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Max Decentralization
// ─────────────────────────────────────────────────────────────────────────────

/** Route stake toward clusters with high geographic diversity + low
 *  correlated preference. The decentralization score (region count +
 *  inverse-reputation + independent-entity bonus) is computed once;
 *  the algorithm picks the top-N by score then shuffles within
 *  near-ties using the per-user seed. */
export function pickMaxDecentralization(input: AutovoteInput): AutovoteResult {
  const eligible = eligibleClusters(input.clusters);
  if (eligible.length === 0) {
    return emptyResult("no eligible clusters");
  }
  const target = Math.max(0, Math.min(input.targetTotalBps, MAX_TOTAL_BPS));
  const capImplied =
    input.capBps === null ? 1 : Math.ceil(target / Math.max(1, input.capBps));
  const wanted = Math.max(input.minDiversification, capImplied, 1);
  const count = Math.min(wanted, eligible.length);
  // Rank by decentralization score (descending). Tie-break with the
  // shuffled order so two delegators don't both pick the identical
  // top-N set.
  const ranked = eligible.slice().sort((a, b) => {
    const da = decentralizationScore(a);
    const db = decentralizationScore(b);
    return db - da;
  });
  // Group near-ties (score within 0.25) and shuffle each group.
  const groups: ClusterDirectoryEntry[][] = [];
  let currentGroupScore: number | null = null;
  for (const c of ranked) {
    const s = decentralizationScore(c);
    if (currentGroupScore === null || Math.abs(s - currentGroupScore) > 0.25) {
      groups.push([c]);
      currentGroupScore = s;
    } else {
      groups[groups.length - 1]!.push(c);
    }
  }
  for (let i = 0; i < groups.length; i++) {
    shuffle(groups[i]!, input.seed, `max-decent-group-${i}`);
  }
  const ordered = groups.flat();
  const picked = ordered.slice(0, count);
  const { allocations, allocated } = allocateEvenly(
    picked,
    target,
    input.capBps,
  );
  return {
    allocations,
    totalAllocatedBps: allocated,
    shortfallBps: Math.max(0, target - allocated),
    reason: `Spread ${allocated} bps across ${allocations.length} cluster(s) — geographic + entity-diverse, near-ties shuffled per-user.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom
// ─────────────────────────────────────────────────────────────────────────────

/** Pass through user-supplied allocations after enforcing the cap +
 *  the 10000 bps total ceiling. Allocations exceeding the per-cluster
 *  cap are clipped; total exceeding 10000 is clipped at the last
 *  allocation. Duplicate cluster ids are merged. */
export function pickCustom(input: CustomInput): AutovoteResult {
  const perClusterMax =
    input.capBps === null
      ? MAX_TOTAL_BPS
      : Math.max(0, Math.min(input.capBps, MAX_TOTAL_BPS));
  const merged = new Map<number, number>();
  for (const a of input.allocations) {
    if (!Number.isFinite(a.weightBps) || a.weightBps <= 0) continue;
    merged.set(a.cluster, (merged.get(a.cluster) ?? 0) + a.weightBps);
  }
  const allocations: AutovoteAllocation[] = [];
  let allocated = 0;
  for (const [cluster, total] of merged) {
    const slice = Math.min(total, perClusterMax, MAX_TOTAL_BPS - allocated);
    if (slice <= 0) continue;
    allocations.push({ cluster, weightBps: slice });
    allocated += slice;
    if (allocated >= MAX_TOTAL_BPS) break;
  }
  // Stable sort by cluster id so the result is deterministic regardless
  // of input ordering.
  allocations.sort((a, b) => a.cluster - b.cluster);
  const targetSum = Array.from(merged.values()).reduce((s, v) => s + v, 0);
  return {
    allocations,
    totalAllocatedBps: allocated,
    shortfallBps: Math.max(0, targetSum - allocated),
    reason: `Custom allocation across ${allocations.length} cluster(s).`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Empty result helper
// ─────────────────────────────────────────────────────────────────────────────

function emptyResult(reason: string): AutovoteResult {
  return { allocations: [], totalAllocatedBps: 0, shortfallBps: 0, reason };
}
