// Phase 7 — staking-client. SW-side RPC wrappers for the §23 delegation
// surface. Every read goes through `sprintnetJsonRpc` so the existing
// operator-iteration + genesis-pin trust path (GAP #11) defends every
// staking read against orphan-fork operators.
//
// Each read returns a `StakingResult<T>` envelope:
//   - on transport / RPC error, falls back to MOCK_* fixtures with
//     `ok: true, data, via: "mock"` so the popup renders the realistic
//     architecture shape while Sprintnet is offline (Phase 7 phase-
//     start posture);
//   - on chain GAP (RPC doesn't exist in SDK yet), returns a typed
//     mock with `via: "mock"` and a clear `// TODO: chain GAP` comment
//     at the call site;
//   - on protocol-shape mismatch (the chain returned something we
//     don't recognise), returns `ok: false, reason`.
//
// The SW IPC dispatchers (service-worker.ts case "staking-*") consume
// the envelopes verbatim.
//
// Phase 7.1 — wire contract anchored to SDK. The `Raw*` types below are
// the wire form (everything optional + JSON-serialised bigints as string
// | number); the SDK exports the strict normalised shapes referenced in
// each block's `// SDK contract:` annotation. Aligning the cast targets
// to SDK types means a future chain-side shape change surfaces in the
// wallet typecheck the next time the SDK rebuilds.

import { sprintnetJsonRpc } from "./tx-mldsa.js";
import {
  MOCK_CLUSTER_APR_BPS,
  MOCK_CLUSTER_REPUTATION,
  MOCK_CLUSTERS,
  type ClusterDirectoryEntry,
  type ClusterDirectoryPage,
  type ClusterHealth,
  type ClusterMember,
  type ClusterStatus,
  type DelegationCap,
  type DelegationRow,
  type DelegationsView,
  type PendingRewardsRow,
  type PendingRewardsView,
  type RedemptionQueueView,
  type StakingResult,
} from "../shared/staking.js";

// SDK-contract anchors live in `staking-client.test.ts` as typed fixtures
// (`const sdkShape: ClusterDirectoryPageResponse = ...`). When Nayiem
// rotates a chain-side field name and the SDK re-exports the new shape,
// those fixtures fail to typecheck before the wallet ships against a
// stale contract. The `Raw*` types below are the loosened wire form
// (optional everywhere, bigint admitted as string | number) so a
// misbehaving operator can't crash the parser; the runtime checks
// further down validate before normalisation.

// ─────────────────────────────────────────────────────────────────────────────
// Cluster directory
// ─────────────────────────────────────────────────────────────────────────────

// SDK contract: ClusterDirectoryPageResponse + ClusterDirectoryEntryResponse.
// The wire form below is the SDK shape with every field optional so a
// misbehaving operator can't crash the parser; the runtime check below
// validates `clusters` is an array before any normalisation.
interface RawClusterDirectoryPage {
  page?: number;
  limit?: number;
  totalClusters?: number;
  clusters?: ReadonlyArray<RawClusterDirectoryEntry>;
}

interface RawClusterDirectoryEntry {
  clusterId?: number;
  size?: number;
  threshold?: number;
  aggregateHealth?: string;
  regionDiversity?: ReadonlyArray<string> | null;
  active?: boolean;
}

// SDK contract: ClusterEntityResponse (bindings — not top-level exported).
// Wire form keeps every field optional; the chain side's strict shape is
// { cluster: number, entity: string, entityCode: number, block: unknown }
// per `mono-core-sdk/packages/ts/src/bindings/ClusterEntityResponse.ts`.
interface RawClusterEntity {
  cluster?: number;
  entity?: string;
}

function normaliseHealth(raw: unknown): ClusterHealth {
  if (raw === "healthy" || raw === "degraded" || raw === "offline") return raw;
  return "unknown";
}

function normaliseDirectoryEntry(
  raw: RawClusterDirectoryEntry,
  entityByCluster: Map<number, string>,
): ClusterDirectoryEntry | null {
  if (typeof raw.clusterId !== "number") return null;
  return {
    clusterId: raw.clusterId,
    // §22.8 namingRegistry precompile (0x1106) hasn't surfaced a reader
    // in the SDK as of 0fd8a79. Once `lythResolveName(".cluster.mono")`
    // (or equivalent) lands, swap this null for a per-cluster lookup
    // batched with the entity fanout below. UI falls back to `cluster-<id>`.
    name: null,
    size: typeof raw.size === "number" ? raw.size : 0,
    threshold: typeof raw.threshold === "number" ? raw.threshold : 0,
    health: normaliseHealth(raw.aggregateHealth),
    regions: Array.isArray(raw.regionDiversity) ? raw.regionDiversity.slice() : [],
    active: raw.active === true,
    entity: entityByCluster.get(raw.clusterId) ?? null,
  };
}

/** Read the chain's cluster directory. Falls back to MOCK_CLUSTERS on any
 *  transport or shape error. */
export async function readClusterDirectory(
  page: number,
  limit: number,
): Promise<StakingResult<ClusterDirectoryPage>> {
  try {
    const { result, via } = await sprintnetJsonRpc<RawClusterDirectoryPage>(
      "lyth_clusters",
      [page, limit],
    );
    if (
      !result ||
      typeof result !== "object" ||
      !Array.isArray(result.clusters)
    ) {
      return { ok: false, reason: "malformed lyth_clusters response" };
    }
    // Best-effort: fan out per-cluster `lyth_getClusterEntity` so each row
    // carries its Foundation / community badge. Failures are silent —
    // entity flag goes null rather than fail-the-whole-directory.
    const entityByCluster = new Map<number, string>();
    await Promise.all(
      result.clusters
        .filter((c): c is RawClusterDirectoryEntry => typeof c?.clusterId === "number")
        .map(async (c) => {
          try {
            const { result: raw } = await sprintnetJsonRpc<RawClusterEntity>(
              "lyth_getClusterEntity",
              [c.clusterId!],
            );
            if (typeof raw?.entity === "string") {
              entityByCluster.set(c.clusterId!, raw.entity);
            }
          } catch {
            // entity lookup is best-effort
          }
        }),
    );
    const clusters = result.clusters
      .map((c) => normaliseDirectoryEntry(c, entityByCluster))
      .filter((c): c is ClusterDirectoryEntry => c !== null);
    return {
      ok: true,
      via,
      data: {
        page: typeof result.page === "number" ? result.page : page,
        limit: typeof result.limit === "number" ? result.limit : limit,
        totalClusters:
          typeof result.totalClusters === "number"
            ? result.totalClusters
            : clusters.length,
        clusters,
      },
    };
  } catch (e) {
    // Sprintnet-offline fallback. Pre-mainnet posture: the UI renders
    // the realistic architecture rather than empty state.
    const _reason = (e as Error)?.message ?? "lyth_clusters unreachable";
    void _reason;
    return {
      ok: true,
      via: "mock",
      data: {
        page,
        limit,
        totalClusters: MOCK_CLUSTERS.length,
        clusters: MOCK_CLUSTERS.slice(),
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cluster status
// ─────────────────────────────────────────────────────────────────────────────

// SDK contract: ClusterMemberResponse + ClusterStatusResponse.
// Wire form: bigints are serialised as `string | number` over JSON-RPC;
// the SDK normalises to `bigint`. The wallet stringifies back for IPC
// transparency (popup never sees a bigint). Optional everywhere defends
// against malformed operator responses.
interface RawClusterMember {
  operatorId?: string;
  blsPubkey?: string;
  state?: string;
}

interface RawClusterStatus {
  clusterId?: number;
  threshold?: number;
  size?: number;
  live?: number;
  lagging?: number;
  offline?: number;
  maintenance?: number;
  members?: ReadonlyArray<RawClusterMember>;
  epoch?: string | number | bigint | null;
  round?: string | number | bigint | null;
  quorum?: string;
  reputationScore?: number | null;
  livenessScore?: number | null;
  lastUpdateHeight?: string | number | bigint;
}

function normaliseMember(raw: RawClusterMember): ClusterMember | null {
  if (
    typeof raw.operatorId !== "string" ||
    typeof raw.blsPubkey !== "string" ||
    typeof raw.state !== "string"
  ) {
    return null;
  }
  return {
    operatorId: raw.operatorId,
    blsPubkey: raw.blsPubkey,
    state: raw.state,
  };
}

/** Read the canonical cluster status envelope. */
export async function readClusterStatus(
  clusterId: number,
): Promise<StakingResult<ClusterStatus>> {
  try {
    const { result, via } = await sprintnetJsonRpc<RawClusterStatus>(
      "lyth_clusterStatus",
      [clusterId],
    );
    if (!result || typeof result !== "object" || typeof result.clusterId !== "number") {
      return { ok: false, reason: "malformed lyth_clusterStatus response" };
    }
    const members = Array.isArray(result.members)
      ? result.members
          .map(normaliseMember)
          .filter((m): m is ClusterMember => m !== null)
      : [];
    return {
      ok: true,
      via,
      data: {
        clusterId: result.clusterId,
        threshold: result.threshold ?? 7,
        size: result.size ?? 10,
        live: result.live ?? 0,
        lagging: result.lagging ?? 0,
        offline: result.offline ?? 0,
        maintenance: result.maintenance ?? 0,
        members,
        epoch:
          result.epoch === null || result.epoch === undefined
            ? null
            : String(result.epoch),
        round:
          result.round === null || result.round === undefined
            ? null
            : String(result.round),
        quorum: result.quorum ?? `${result.threshold ?? 7}-of-${result.size ?? 10}`,
        reputationScore:
          typeof result.reputationScore === "number" ? result.reputationScore : null,
        livenessScore:
          typeof result.livenessScore === "number" ? result.livenessScore : null,
        lastUpdateHeight: String(result.lastUpdateHeight ?? 0),
      },
    };
  } catch (e) {
    const reason = (e as Error)?.message ?? "lyth_clusterStatus unreachable";
    return { ok: false, reason };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Delegations + cap
// ─────────────────────────────────────────────────────────────────────────────

// SDK contract: DelegationsResponse + DelegationRow (bindings, not top-
// level exported). Strict chain shape:
//   DelegationsResponse: { wallet, rows: DelegationRow[], totalBps, block }
//   DelegationRow:       { cluster, weightBps }
// `block` is an opaque block selector echoed by the node; the wallet
// doesn't surface it because the popup's chain-status banner already
// covers staleness.
interface RawDelegationsResponse {
  wallet?: string;
  rows?: ReadonlyArray<{ cluster?: number; weightBps?: number }>;
  totalBps?: number;
}

/** Read active delegations for a wallet. Falls back to an empty envelope
 *  on transport error — a wallet with no on-chain delegations is also
 *  empty, so the popup's render path doesn't differentiate. */
export async function readDelegations(
  wallet: string,
): Promise<StakingResult<DelegationsView>> {
  try {
    const { result, via } = await sprintnetJsonRpc<RawDelegationsResponse>(
      "lyth_getDelegations",
      [wallet],
    );
    if (!result || typeof result !== "object") {
      return { ok: false, reason: "malformed lyth_getDelegations response" };
    }
    const rows: DelegationRow[] = (Array.isArray(result.rows) ? result.rows : [])
      .filter(
        (r): r is { cluster: number; weightBps: number } =>
          typeof r?.cluster === "number" && typeof r?.weightBps === "number",
      )
      .map((r) => ({ cluster: r.cluster, weightBps: r.weightBps }));
    return {
      ok: true,
      via,
      data: {
        wallet: typeof result.wallet === "string" ? result.wallet : wallet,
        rows,
        totalBps: typeof result.totalBps === "number" ? result.totalBps : 0,
      },
    };
  } catch {
    // Empty delegations is a legitimate read for an unstaked wallet —
    // the popup renders the empty-state CTA. Sprintnet-offline gets the
    // same shape; the user sees "no active delegations" + can still
    // drill into the cluster directory.
    return {
      ok: true,
      via: "mock",
      data: { wallet, rows: [], totalBps: 0 },
    };
  }
}

// SDK contract: DelegationCapResponse (binding, not top-level exported).
// Strict shape: { capBps: u32, lastChangedAtHeight: bigint, blockNumber: bigint }.
// Wire form receives bigints as `string | number` over JSON; the wallet
// stringifies to preserve precision.
interface RawDelegationCap {
  capBps?: number;
  lastChangedAtHeight?: string | number | bigint;
}

/** Chain encodes "cap disabled" as `u32::MAX`. The wallet normalises that
 *  to `null` so the UI can branch cleanly on `capBps !== null`. */
const CHAIN_CAP_DISABLED = 0xffffffff;

/** Read the per-cluster delegation cap (§23.6). */
export async function readDelegationCap(): Promise<StakingResult<DelegationCap>> {
  try {
    const { result, via } = await sprintnetJsonRpc<RawDelegationCap>(
      "lyth_getDelegationCap",
      [],
    );
    if (!result || typeof result !== "object" || typeof result.capBps !== "number") {
      return { ok: false, reason: "malformed lyth_getDelegationCap response" };
    }
    return {
      ok: true,
      via,
      data: {
        capBps: result.capBps === CHAIN_CAP_DISABLED ? null : result.capBps,
        lastChangedAtHeight: String(result.lastChangedAtHeight ?? 0),
      },
    };
  } catch {
    // Pre-mainnet posture: whitepaper §23.6 Phase 12 launch cap = 50%
    // (`5000` bps). Mocking this is the cleanest way to render the
    // stake form's cap-headroom badge during cluster-offline windows;
    // when Sprintnet returns, the chain value supersedes the mock.
    return {
      ok: true,
      via: "mock",
      data: { capBps: 5000, lastChangedAtHeight: "0" },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rewards + redemption queue (chain GAPs)
// ─────────────────────────────────────────────────────────────────────────────

/** Per-account pending rewards. The SDK at 0fd8a79 (Phase 7.1 head) does
 *  NOT yet expose a `lyth_pendingRewards` reader; the wallet returns a
 *  mock derived from the active delegations + MOCK_CLUSTER_APR_BPS until
 *  Nayiem surfaces the chain side.
 *
 *  Mock derivation: for each active delegation row, the wallet computes
 *  a small fake reward proportional to the weight × APR / (365 × 24 × 12)
 *  — i.e. "as if 5 minutes of accrual at the cluster's nominal APR." This
 *  is purely a render-shape hint; the UI labels the figures `MOCK` until
 *  the chain side lands. */
export async function readPendingRewards(
  wallet: string,
  delegations: ReadonlyArray<DelegationRow>,
): Promise<StakingResult<PendingRewardsView>> {
  // TODO: chain GAP — needs Nayiem
  // ────────────────────────────────
  // Once `lyth_pendingRewards` (or an equivalent indexer aggregate) ships
  // in the SDK, replace this body with a direct call via
  // `sprintnetJsonRpc` and drop the mock derivation below.

  let total = 0n;
  const rows: PendingRewardsRow[] = [];
  for (const d of delegations) {
    const aprBps = MOCK_CLUSTER_APR_BPS[d.cluster] ?? null;
    if (aprBps === null) {
      rows.push({ cluster: d.cluster, amountWei: "0x0", effectiveAprBps: null });
      continue;
    }
    // Illustrative-only: amount ≈ weight × APR / (365 × 288) where 288
    // is the 5-minute-tick count in a day. Numbers stay small enough to
    // render but visually plausible.
    const wei = (BigInt(d.weightBps) * BigInt(aprBps) * 100n) / (365n * 288n);
    total += wei;
    rows.push({
      cluster: d.cluster,
      amountWei: "0x" + wei.toString(16),
      effectiveAprBps: aprBps,
    });
  }

  return {
    ok: true,
    via: "mock",
    data: {
      wallet,
      totalAmountWei: "0x" + total.toString(16),
      rows,
      blockHeight: null,
    },
  };
}

/** Redemption queue. Per whitepaper §23.2 ("zero unbonding period"),
 *  there is no redemption delay for delegators — direct unstake clears
 *  instantly. The shape exists to cover any future chain-side change to
 *  that policy (which would be a constitutional-layer hard fork per
 *  §30.6 and is therefore unlikely pre-mainnet). For now we return an
 *  empty queue. */
export async function readRedemptionQueue(
  wallet: string,
): Promise<StakingResult<RedemptionQueueView>> {
  // TODO: chain GAP — needs Nayiem
  // ────────────────────────────────
  // No `lyth_redemptionQueue` reader exists in the SDK. Per §23.2 the
  // queue is vestigial; the wallet returns an empty envelope rather
  // than failing the UI render.
  return {
    ok: true,
    via: "mock",
    data: { wallet, rows: [] },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers re-exported for service-worker.ts test fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** Mock reputation table — exposed so the SW IPC handlers can stitch a
 *  per-cluster reputation hint into the directory response when the
 *  chain doesn't surface one. */
export { MOCK_CLUSTER_APR_BPS, MOCK_CLUSTER_REPUTATION };
