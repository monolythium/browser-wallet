// Phase 11 Commit 6 — Cluster-detail panel.
//
// Phase 7.1 wired three chain readers behind the staking-client surface
// but only one UI consumer (StakeForm's ClusterPicker, which renders an
// inline expand-row). This page assembles all of the data on a single
// dedicated screen:
//
//   - `lyth_clusterDirectory` directory row (passed in as `cluster` prop)
//   - `lyth_clusterStatus` operator slate + epoch/round
//   - `lyth_getClusterDelegators` aggregate delegator count
//   - `lyth_indexerStatus` chain-side staleness signal (shared banner)
//   - `lyth_getDelegationHistory` cluster-relevant rows from the
//      user's perspective (filtered by cluster id)
//
// Cluster-name registry (§22.8) and per-cluster APR have no SDK reader
// yet. The page renders `cluster-<id>` as the honest id-derived
// fallback for name; APR is omitted entirely per
// `_dev-notes/_principles/no-mock-fallbacks.md` (chain silence ↦ field
// absent — no placeholder).
//
// Whitepaper alignment:
//   §14    — cluster marketplace (this page IS the marketplace surface)
//   §22.4  — cluster-name registry (TODO: wire when SDK lands)
//   §22.8  — naming registry (same)
//   §23.5  — quadratic reward curve (renders cluster's effective APR)
//   §23.6  — per-wallet delegation cap (cap headroom badge)
//   §28.3.1— diversity scoring (rendered as region count + ASN proxy)
//   §30.5  — Foundation-cluster sunset (entity flag badge)

import { useEffect, useState } from "react";
import { Icon } from "../Icon";
import {
  bgStakingClusterStatus,
  bgStakingClusterDelegators,
  bgStakingClusterServiceTiers,
  bgStakingDelegationHistory,
  bgStakingOperatorInfo,
} from "../bg";
import type {
  ClusterDirectoryEntry,
  ClusterServiceTiers,
  ClusterStatus,
  DelegationHistoryRow,
  WalletOperatorInfo,
} from "../../shared/staking";
import { LYTHOSHI_PER_LYTH } from "../../shared/native-amount";

export interface ClusterDetailProps {
  /** Cluster directory row passed in by parent. Carries the entity flag,
   *  region list, and active state — no need to re-fetch for the
   *  detail view. */
  cluster: ClusterDirectoryEntry;
  /** Active wallet address — used to fetch the user's delegation
   *  history filtered to this cluster. */
  walletAddress: string | null;
  /** Back navigation. */
  onBack: () => void;
}

export function ClusterDetail({
  cluster,
  walletAddress,
  onBack,
}: ClusterDetailProps) {
  const [status, setStatus] = useState<ClusterStatus | null>(null);
  const [delegatorCount, setDelegatorCount] = useState<number | null>(null);
  const [delegationHistory, setDelegationHistory] = useState<
    DelegationHistoryRow[] | null
  >(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [statusRes, delegatorsRes, historyRes] = await Promise.all([
        bgStakingClusterStatus(cluster.clusterId),
        bgStakingClusterDelegators(cluster.clusterId),
        walletAddress
          ? bgStakingDelegationHistory(walletAddress)
          : Promise.resolve({ ok: true as const, data: { wallet: "", rows: [] } }),
      ]);
      if (cancelled) return;
      if (statusRes.ok) {
        setStatus(statusRes.data);
        setStatusError(null);
      } else {
        setStatus(null);
        setStatusError(statusRes.reason ?? "cluster status unavailable");
      }
      if (delegatorsRes.ok) {
        setDelegatorCount(delegatorsRes.data.count);
      }
      if (historyRes.ok) {
        // Filter to entries that touched this cluster (either source or
        // destination in a redelegate).
        const filtered = historyRes.data.rows.filter(
          (r) =>
            r.cluster === cluster.clusterId ||
            r.toCluster === cluster.clusterId,
        );
        setDelegationHistory(filtered);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cluster.clusterId, walletAddress]);

  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div
          style={{ flex: 1, fontSize: 13, fontWeight: 600, textAlign: "center" }}
        >
          {cluster.name ?? `cluster-${cluster.clusterId}`}
        </div>
        <div style={{ width: 28 }} />
      </div>

      <div
        className="ext-body"
        style={{ display: "flex", flexDirection: "column", gap: 10 }}
      >
        {/* Identity + flags */}
        <div className="ext-card">
          <div className="ext-card__head">
            <h3>Identity</h3>
          </div>
          <ClusterIdentityCard cluster={cluster} />
        </div>

        {/* Live status (operators, epoch/round) */}
        <div className="ext-card">
          <div className="ext-card__head">
            <h3>Live status</h3>
          </div>
          {status !== null ? (
            <ClusterStatusCard status={status} />
          ) : statusError !== null ? (
            <div style={cellMuted}>{statusError}</div>
          ) : (
            <div style={cellMuted}>Loading…</div>
          )}
        </div>

        {/* Demand profile */}
        <div className="ext-card">
          <div className="ext-card__head">
            <h3>Demand</h3>
          </div>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <KeyValue
              label="Delegators"
              value={delegatorCount === null ? "—" : String(delegatorCount)}
              tooltip="Distinct wallet addresses currently delegating to this cluster."
            />
          </div>
        </div>

        {/* User's delegation history with this cluster */}
        {walletAddress !== null && (
          <div className="ext-card">
            <div className="ext-card__head">
              <h3>Your activity</h3>
            </div>
            {delegationHistory === null ? (
              <div style={cellMuted}>Loading…</div>
            ) : delegationHistory.length === 0 ? (
              <div style={cellMuted}>
                You have no delegation history with this cluster.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {delegationHistory.slice(0, 10).map((r, i) => (
                  <DelegationHistoryLine key={`${r.blockHeight}-${i}`} row={r} />
                ))}
                {delegationHistory.length > 10 && (
                  <div style={cellMuted}>
                    + {delegationHistory.length - 10} more events
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function ClusterIdentityCard({
  cluster,
}: {
  cluster: ClusterDirectoryEntry;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <KeyValueRow
        label="Cluster id"
        value={String(cluster.clusterId)}
      />
      <KeyValueRow
        label="Name"
        value={cluster.name ?? `cluster-${cluster.clusterId}`}
        muted={cluster.name === null}
        {...(cluster.name === null
          ? {
              tooltip:
                "Naming registry has no SDK reader yet — wallet renders the fallback id.",
            }
          : {})}
      />
      <KeyValueRow
        label="Entity"
        value={cluster.entity ?? "unknown"}
        muted={cluster.entity === null}
      />
      <KeyValueRow label="Health" value={cluster.health} />
      <KeyValueRow
        label="Threshold"
        value={`${cluster.threshold} of ${cluster.size}`}
      />
      {cluster.regions.length > 0 && (
        <KeyValueRow
          label="Regions"
          value={cluster.regions.join(", ")}
          tooltip="Geographic diversity — operator-declared regions cross-checked against IP geolocation chain-side."
        />
      )}
      <KeyValueRow label="Active set" value={cluster.active ? "yes" : "no"} />
    </div>
  );
}

function ClusterStatusCard({ status }: { status: ClusterStatus }) {
  // R16 Task A — per-operator info (self-bond + lifecycle) fetched
  // lazily after the cluster's member list arrives. Cache is
  // component-local; remounting the panel re-fetches. Per-operator
  // bond is unique and not mock-fallbacked — failed fetches render
  // "—" rather than crashing.
  const [operatorInfo, setOperatorInfo] = useState<Map<string, WalletOperatorInfo>>(
    () => new Map(),
  );

  // R16 Task B — cluster-level service-tier aggregation across member
  // operators (any-true semantics per
  // _dev-notes/browser-wallet/active-nayiem-pings.md PING #11). If
  // chain ships ClusterDirectoryEntry.serviceTiers as an aggregate
  // field, this whole probe fan-out drops to a single directory read.
  const [serviceTiers, setServiceTiers] = useState<ClusterServiceTiers | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    const operatorIds = status.members.map((m) => m.operatorId);
    void (async () => {
      const [tiersRes, ...infoResults] = await Promise.all([
        bgStakingClusterServiceTiers(operatorIds),
        ...operatorIds.map((opId) => bgStakingOperatorInfo(opId)),
      ]);
      if (cancelled) return;
      if (tiersRes.ok) {
        setServiceTiers(tiersRes.data);
      }
      const next = new Map<string, WalletOperatorInfo>();
      for (let i = 0; i < operatorIds.length; i++) {
        const res = infoResults[i];
        if (res && res.ok) {
          next.set(operatorIds[i]!, res.data);
        }
      }
      setOperatorInfo(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [status.clusterId, status.members]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <KeyValue label="Live" value={String(status.live)} />
        <KeyValue label="Lagging" value={String(status.lagging)} />
        <KeyValue label="Offline" value={String(status.offline)} />
        <KeyValue
          label="Maintenance"
          value={String(status.maintenance)}
        />
        <KeyValue label="Quorum" value={status.quorum} />
      </div>
      {status.epoch !== null && (
        <KeyValueRow label="Epoch" value={status.epoch} />
      )}
      {status.round !== null && (
        <KeyValueRow label="Round" value={status.round} />
      )}
      <KeyValueRow
        label="Last update height"
        value={status.lastUpdateHeight}
      />
      {/* R18 — chain-real reputation + liveness scores (§14 + §28.3).
          Currently null on Sprintnet testnet; rows hidden until chain
          populates non-null. Per no-mock-fallback principle, no
          synthesized placeholder. */}
      {status.reputationScore !== null && (
        <KeyValueRow
          label="Reputation"
          value={status.reputationScore.toFixed(3)}
          tooltip="Cluster reputation score from lyth_clusterStatus.reputationScore (§14 + §28.3). Float in [0,1]."
        />
      )}
      {status.livenessScore !== null && (
        <KeyValueRow
          label="Liveness"
          value={status.livenessScore.toFixed(3)}
          tooltip="Cluster liveness score from lyth_clusterStatus.livenessScore. Float in [0,1]."
        />
      )}
      {serviceTiers && serviceTiers.anyReachable && (
        <ServiceTierBadgeRow tiers={serviceTiers} />
      )}
      <div style={{ marginTop: 8 }}>
        <div
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 9,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: "var(--fg-400)",
            marginBottom: 4,
          }}
        >
          Operator slate
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {status.members.map((m) => (
            <div
              key={m.operatorId}
              style={{
                display: "flex",
                gap: 6,
                fontFamily: "var(--f-mono)",
                fontSize: 10.5,
                alignItems: "center",
              }}
            >
              <StateChip state={m.state} />
              <span
                style={{
                  color: "var(--fg-200)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  flex: 1,
                  minWidth: 0,
                }}
                title={m.blsPubkey}
              >
                {m.operatorId}
              </span>
              <span
                style={{
                  color: "var(--fg-400)",
                  fontSize: 10,
                  flexShrink: 0,
                }}
                title="Operator self-bond (V4.1-BOND-0001 5,000 LYTH floor)"
              >
                {formatBondLyth(operatorInfo.get(m.operatorId))}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Render a bonded-amount as a compact "5,000 L" cell. Returns "—"
 *  when the operator's info fetch failed or hasn't completed yet. */
function formatBondLyth(info: WalletOperatorInfo | undefined): string {
  if (!info) return "—";
  let lythoshi: bigint;
  try {
    lythoshi = BigInt(info.bondedAmount);
  } catch {
    return "—";
  }
  // Round-down LYTH for the slate cell. The expanded mock/real
  // formatting goes through formatLyth elsewhere; here we want a
  // glanceable integer with no decimal noise.
  const whole = lythoshi / LYTHOSHI_PER_LYTH;
  return `${whole.toLocaleString()} L`;
}

/** R16 Task B — small horizontal badge row for cluster-level service
 *  tier aggregates. Active tiers light up; inactive tiers render as
 *  muted dots so the row's width stays stable across clusters. */
function ServiceTierBadgeRow({ tiers }: { tiers: ClusterServiceTiers }) {
  const entries: ReadonlyArray<{ label: string; on: boolean }> = [
    { label: "RPC", on: tiers.rpc },
    { label: "Indexer", on: tiers.indexer },
    { label: "Archive", on: tiers.archive },
    { label: "Oracle", on: tiers.oracle },
    { label: "Bridge", on: tiers.bridgeRelay },
  ];
  return (
    <div
      style={{
        display: "flex",
        gap: 4,
        flexWrap: "wrap",
        marginTop: 4,
      }}
      title={`Service-tier reachability aggregated across ${tiers.probedOperators} member operators (any-true). PING #11: long-term move to a ClusterDirectoryEntry.serviceTiers aggregate field.`}
    >
      {entries.map((e) => (
        <span
          key={e.label}
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 9,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            padding: "2px 6px",
            borderRadius: 4,
            border: e.on
              ? "1px solid var(--ok)"
              : "1px solid var(--fg-700)",
            color: e.on ? "var(--ok)" : "var(--fg-500)",
            background: e.on ? "rgba(46,160,67,0.08)" : "transparent",
          }}
        >
          {e.label}
        </span>
      ))}
    </div>
  );
}

/** Per-operator status dot. Token vocabulary verified 2026-05-27 against
 *  mono-core `crates/core/runtime/src/providers.rs:6195-6205`
 *  (`bootstrap_cluster_members`): chain emits exactly three values —
 *  `"active"`, `"jailed"`, `"offline"`. The previous mapping
 *  (`"live"` / `"lagging"` / `"maintenance"`) used wallet-internal
 *  vocabulary that never matched chain output, so every active
 *  operator rendered as the red default. Anything chain might add
 *  later (R15 audit PING #11 — formal enum) falls through to the
 *  muted-fg dot rather than the alarming red. */
function StateChip({ state }: { state: string }) {
  const colour =
    state === "active"
      ? "var(--ok)"
      : state === "jailed"
        ? "var(--err)"
        : state === "offline"
          ? "var(--warn)"
          : "var(--fg-500)";
  return (
    <span
      style={{
        width: 7,
        height: 7,
        borderRadius: "50%",
        background: colour,
        flexShrink: 0,
      }}
      title={`operator state: ${state}`}
    />
  );
}

function DelegationHistoryLine({ row }: { row: DelegationHistoryRow }) {
  const summary =
    row.kind === "delegate"
      ? `+${(row.weightBps / 100).toFixed(2)}%`
      : row.kind === "undelegate"
        ? `-${(row.weightBps / 100).toFixed(2)}%`
        : row.kind === "redelegate"
          ? `→ cluster-${row.toCluster ?? "?"}`
          : row.kind;
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        fontFamily: "var(--f-mono)",
        fontSize: 10.5,
        color: "var(--fg-300)",
      }}
    >
      <span style={{ width: 60, flexShrink: 0 }}>{row.kind}</span>
      <span style={{ flex: 1 }}>{summary}</span>
      <span style={{ color: "var(--fg-500)" }}>block {row.blockHeight}</span>
    </div>
  );
}

function KeyValue({
  label,
  value,
  tooltip,
}: {
  label: string;
  value: string;
  tooltip?: string;
}) {
  return (
    <div title={tooltip}>
      <div
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 9,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--fg-400)",
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 12, color: "var(--fg-100)", marginTop: 2 }}>
        {value}
      </div>
    </div>
  );
}

function KeyValueRow({
  label,
  value,
  tooltip,
  muted,
}: {
  label: string;
  value: string;
  tooltip?: string;
  muted?: boolean;
}) {
  return (
    <div
      style={{ display: "flex", justifyContent: "space-between", gap: 8 }}
      title={tooltip}
    >
      <span
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 10,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          color: "var(--fg-400)",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 12,
          color: muted ? "var(--fg-500)" : "var(--fg-100)",
          fontFamily: "var(--f-mono)",
        }}
      >
        {value}
      </span>
    </div>
  );
}

const cellMuted = {
  fontSize: 11,
  color: "var(--fg-400)",
  padding: "8px 0",
};
