// Phase 11 Commit 6 — Cluster-detail panel.
//
// Phase 7.1 wired three chain readers behind the staking-client surface
// but only one UI consumer (StakeForm's ClusterPicker, which renders an
// inline expand-row). This page assembles all of the data on a single
// dedicated screen:
//
//   - `lyth_clusters` directory row (passed in as `cluster` prop)
//   - `lyth_clusterStatus` operator slate + epoch/round
//   - `lyth_getClusterDelegators` aggregate delegator count
//   - `lyth_indexerStatus` chain-side staleness signal (shared banner)
//   - `lyth_getDelegationHistory` cluster-relevant rows from the
//      user's perspective (filtered by cluster id)
//
// Cluster-name registry (§22.8) and per-cluster APR are still mocked —
// no SDK reader has shipped. The page renders `cluster-<id>` and the
// MOCK_CLUSTER_APR_BPS value with a small "MOCK" affordance.
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
import {
  bgStakingClusterStatus,
  bgStakingClusterDelegators,
  bgStakingDelegationHistory,
} from "../bg";
import type {
  ClusterDirectoryEntry,
  ClusterStatus,
  DelegationHistoryRow,
} from "../../shared/staking";
import {
  MOCK_CLUSTER_APR_BPS,
  MOCK_CLUSTER_REPUTATION,
} from "../../shared/staking";

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

  const aprBps = MOCK_CLUSTER_APR_BPS[cluster.clusterId] ?? null;
  const reputation = MOCK_CLUSTER_REPUTATION[cluster.clusterId] ?? null;

  return (
    <div className="ext-app">
      <div className="ext-app__top">
        <button
          type="button"
          className="ext-btn ext-btn--ghost"
          onClick={onBack}
          aria-label="Back"
        >
          ← Back
        </button>
        <div className="ext-app__title">
          {cluster.name ?? `cluster-${cluster.clusterId}`}
        </div>
        <div />
      </div>

      <div
        className="ext-app__body"
        style={{ display: "flex", flexDirection: "column", gap: 10 }}
      >
        {/* Identity + flags */}
        <div className="ext-card">
          <div className="ext-card__head">
            <h3>Identity</h3>
          </div>
          <ClusterIdentityCard cluster={cluster} reputation={reputation} />
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
            <KeyValue
              label="APR (mock)"
              value={
                aprBps === null
                  ? "—"
                  : `${(aprBps / 100).toFixed(2)}%`
              }
              tooltip="Per §23.5 quadratic reward curve. APR is a mock — chain has no lyth_clusterApr reader yet."
            />
            <KeyValue
              label="Reputation (mock)"
              value={
                reputation === null ? "—" : `${(reputation * 100).toFixed(0)}/100`
              }
              tooltip="Cluster reputation aggregate. Indexer-side aggregation is forthcoming; current value is illustrative."
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
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function ClusterIdentityCard({
  cluster,
  reputation,
}: {
  cluster: ClusterDirectoryEntry;
  reputation: number | null;
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
                "Naming registry §22.8 has no SDK reader yet — wallet renders the fallback id.",
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
      <KeyValueRow
        label="Regions"
        value={cluster.regions.length === 0 ? "—" : cluster.regions.join(", ")}
        tooltip="Geographic diversity per §28.3.1 — operator-declared regions cross-checked against IP geolocation chain-side."
      />
      <KeyValueRow label="Active set" value={cluster.active ? "yes" : "no"} />
      {reputation !== null && (
        <KeyValueRow
          label="Reputation"
          value={`${(reputation * 100).toFixed(0)}/100 (mock)`}
        />
      )}
    </div>
  );
}

function ClusterStatusCard({ status }: { status: ClusterStatus }) {
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
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StateChip({ state }: { state: string }) {
  const colour =
    state === "live"
      ? "var(--ok)"
      : state === "lagging" || state === "maintenance"
        ? "var(--warn)"
        : "var(--err)";
  return (
    <span
      style={{
        width: 7,
        height: 7,
        borderRadius: "50%",
        background: colour,
        flexShrink: 0,
      }}
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
