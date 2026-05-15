// Phase 7 commit 6 — Delegations dashboard. Read-only summary of the
// user's active stake + pending rewards, with per-row "Manage" CTAs
// that route back into the Stake page's existing unstake / redelegate
// flows.
//
// The Stake page already surfaces this data on its pick step (it has
// to — the user needs to see existing weights to decide where to add
// more). Delegations is the focused entry: skip the cluster picker
// and autovote-selector noise, land directly on the user's existing
// positions. Reach this view from Settings → Staking; the Stake
// page → pick step continues to host the same data inline for the
// stake-new flow.

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Icon } from "../Icon";
import { RewardCard } from "../components/RewardCard";
import {
  bgStakingClusterDirectory,
  bgStakingDelegations,
  bgStakingPendingRewards,
  bgWalletBalance,
  bgWalletSendTx,
  type ClusterDirectoryEntry,
  type DelegationsView,
  type PendingRewardsView,
} from "../bg";
import type { Account } from "../demo-data";
import {
  DELEGATION_PRECOMPILE,
  encodeClaimRewards,
} from "../../shared/staking-tx";

interface DelegationsProps {
  account: Account;
  chainId: string;
  onBack: () => void;
  /** Route to the Stake page in unstake-from / redelegate-from-this-
   *  cluster mode. The Stake page reads `selectedClusterId` from
   *  navigation params (set by the parent App state) and skips
   *  directly to the appropriate form step. */
  onUnstake: (clusterId: number) => void;
  onRedelegate: (clusterId: number) => void;
  /** Route to the Stake page in stake-more mode. */
  onStakeMore: () => void;
}

export function Delegations({
  account,
  chainId,
  onBack,
  onUnstake,
  onRedelegate,
  onStakeMore,
}: DelegationsProps) {
  const [clusters, setClusters] = useState<ClusterDirectoryEntry[]>([]);
  const [delegations, setDelegations] = useState<DelegationsView | null>(null);
  const [balanceWei, setBalanceWei] = useState<bigint | null>(null);
  const [rewards, setRewards] = useState<PendingRewardsView | null>(null);
  const [rewardsMock, setRewardsMock] = useState(true);
  const [claimSubmitting, setClaimSubmitting] = useState(false);
  const [claimResult, setClaimResult] = useState<
    | { ok: true; txHash: string }
    | { ok: false; reason: string }
    | null
  >(null);

  // Load active delegations + cluster directory + balance + rewards on
  // mount. The fan-out is identical to the Stake page's pick-step
  // load; the wallet doesn't share that state across screens because
  // each page should be cheap to enter cold.
  useEffect(() => {
    if (!account.addr.startsWith("0x")) return;
    let cancelled = false;
    void (async () => {
      const [dirR, delR, balR] = await Promise.all([
        bgStakingClusterDirectory(),
        bgStakingDelegations(account.addr),
        bgWalletBalance(account.addr, chainId),
      ]);
      if (cancelled) return;
      if (dirR.ok) setClusters(dirR.data.clusters.slice());
      if (delR.ok) setDelegations(delR.data);
      if (balR.ok) {
        try {
          setBalanceWei(BigInt(balR.balanceHex));
        } catch {
          // malformed hex — render with null
        }
      }
      if (delR.ok) {
        const rewR = await bgStakingPendingRewards(account.addr, delR.data.rows);
        if (!cancelled && rewR.ok) {
          setRewards(rewR.data);
          setRewardsMock(rewR.via === "mock");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account.addr, chainId]);

  const clusterById = useMemo(() => {
    const m = new Map<number, ClusterDirectoryEntry>();
    for (const c of clusters) m.set(c.clusterId, c);
    return m;
  }, [clusters]);

  const totalDelegatedWei = useMemo(() => {
    if (delegations === null || balanceWei === null) return null;
    return (balanceWei * BigInt(delegations.totalBps)) / 10_000n;
  }, [delegations, balanceWei]);

  // Claim handler — same encoded selector + tx envelope as Stake.tsx
  // but inlined here so the Delegations page doesn't depend on the
  // Stake page's state machine to fire a claim.
  const handleClaim = async () => {
    setClaimSubmitting(true);
    setClaimResult(null);
    try {
      const r = await bgWalletSendTx({
        to: DELEGATION_PRECOMPILE,
        valueWeiHex: "0x0",
        chainIdHex: chainId,
        data: encodeClaimRewards(),
        gasLimitHex: "0x14820",
      });
      if (r.ok) setClaimResult({ ok: true, txHash: r.result.txHash });
      else setClaimResult({ ok: false, reason: r.reason ?? "claim rejected" });
    } catch (e) {
      setClaimResult({ ok: false, reason: (e as Error).message ?? "claim failed" });
    } finally {
      setClaimSubmitting(false);
    }
  };

  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div
          style={{ flex: 1, fontSize: 13, fontWeight: 600, textAlign: "center" }}
        >
          Delegations
        </div>
        <div style={{ width: 28 }} />
      </div>

      <div className="ext-body">
        {/* Summary */}
        <div className="ext-card" style={{ padding: 12 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 12,
            }}
          >
            <KvStack
              label="Active delegations"
              value={
                delegations === null
                  ? "—"
                  : delegations.rows.length === 0
                    ? "0 clusters"
                    : `${delegations.rows.length} cluster${delegations.rows.length === 1 ? "" : "s"}`
              }
              tone="var(--fg-100)"
            />
            <KvStack
              label="Staked"
              value={
                totalDelegatedWei === null
                  ? "—"
                  : `${formatWei(totalDelegatedWei)} LYTH (${((delegations?.totalBps ?? 0) / 100).toFixed(2)}%)`
              }
              tone="var(--gold)"
            />
          </div>
        </div>

        {/* Pending rewards card */}
        {delegations !== null && delegations.rows.length > 0 && (
          <RewardCard
            rewards={rewards}
            isMock={rewardsMock}
            clusters={clusters}
            onClaim={() => void handleClaim()}
            claimDisabled={claimSubmitting}
          />
        )}

        {/* Claim result toast */}
        {claimResult !== null && (
          <div
            style={
              claimResult.ok
                ? {
                    padding: "10px 12px",
                    borderRadius: 10,
                    background: "rgba(80,200,120,0.08)",
                    border: "1px solid rgba(80,200,120,0.4)",
                    fontFamily: "var(--f-mono)",
                    fontSize: 10.5,
                    color: "var(--ok)",
                    lineHeight: 1.5,
                  }
                : {
                    padding: "10px 12px",
                    borderRadius: 10,
                    background: "rgba(220,80,80,0.08)",
                    border: "1px solid rgba(220,80,80,0.4)",
                    fontFamily: "var(--f-mono)",
                    fontSize: 10.5,
                    color: "var(--err)",
                    lineHeight: 1.5,
                  }
            }
          >
            {claimResult.ok ? (
              <>
                Claim submitted ·{" "}
                <span style={{ color: "var(--fg-200)" }}>
                  {claimResult.txHash.slice(0, 10)}…{claimResult.txHash.slice(-6)}
                </span>
              </>
            ) : (
              claimResult.reason
            )}
          </div>
        )}

        {/* Active delegation rows or empty state */}
        {delegations === null ? (
          <div
            style={{
              padding: 18,
              textAlign: "center",
              fontSize: 12,
              color: "var(--fg-400)",
              fontFamily: "var(--f-mono)",
            }}
          >
            Loading delegations…
          </div>
        ) : delegations.rows.length === 0 ? (
          <div className="ext-card" style={{ padding: 14, textAlign: "center" }}>
            <div
              style={{
                fontSize: 12.5,
                color: "var(--fg-200)",
                lineHeight: 1.5,
                marginBottom: 12,
              }}
            >
              You have no active delegations.
            </div>
            <button
              onClick={onStakeMore}
              className="ext-act prim"
              style={{
                padding: 10,
                width: "100%",
                flexDirection: "row",
                gap: 8,
              }}
            >
              <Icon name="stake" size={12} /> Stake LYTH
            </button>
          </div>
        ) : (
          <>
            <div className="ext-card" style={{ padding: 12 }}>
              <div style={cardLabelStyle}>Per-cluster breakdown</div>
              <div
                style={{
                  marginTop: 8,
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                {delegations.rows.map((row) => {
                  const c = clusterById.get(row.cluster);
                  const amountWei =
                    balanceWei !== null
                      ? (balanceWei * BigInt(row.weightBps)) / 10_000n
                      : null;
                  return (
                    <div
                      key={row.cluster}
                      style={{
                        padding: "10px 12px",
                        borderRadius: 8,
                        border: "1px solid var(--fg-700)",
                        background: "rgba(255,255,255,0.02)",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 8,
                        }}
                      >
                        <div style={{ minWidth: 0 }}>
                          <div
                            style={{
                              fontSize: 12.5,
                              fontWeight: 600,
                              color: "var(--fg-100)",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {c?.name ?? `cluster-${row.cluster}`}
                          </div>
                          <div
                            style={{
                              fontFamily: "var(--f-mono)",
                              fontSize: 10,
                              color: "var(--fg-400)",
                              marginTop: 2,
                            }}
                          >
                            {(row.weightBps / 100).toFixed(2)}%
                            {amountWei !== null && (
                              <> · {formatWei(amountWei)} LYTH</>
                            )}
                          </div>
                        </div>
                      </div>
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "1fr 1fr",
                          gap: 6,
                          marginTop: 8,
                        }}
                      >
                        <button
                          onClick={() => onUnstake(row.cluster)}
                          style={rowActionBtnStyle}
                        >
                          Unstake
                        </button>
                        <button
                          onClick={() => onRedelegate(row.cluster)}
                          style={rowActionBtnStyle}
                        >
                          Redelegate
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Stake more CTA */}
            <button
              onClick={onStakeMore}
              className="ext-act"
              style={{
                padding: 10,
                flexDirection: "row",
                gap: 8,
                width: "100%",
              }}
            >
              <Icon name="plus" size={12} /> Stake more
            </button>
          </>
        )}
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers + styles
// ─────────────────────────────────────────────────────────────────────────────

function KvStack({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: string;
}) {
  return (
    <div>
      <div
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 9.5,
          color: "var(--fg-500)",
          letterSpacing: "0.1em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 13,
          fontWeight: 600,
          color: tone,
          marginTop: 2,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function formatWei(wei: bigint, decimals = 4): string {
  if (wei <= 0n) return "0";
  const whole = wei / 10n ** 18n;
  const rem = wei % 10n ** 18n;
  if (rem === 0n || decimals === 0) return whole.toString();
  const remStr = rem.toString().padStart(18, "0").slice(0, decimals);
  const trimmed = remStr.replace(/0+$/, "");
  return trimmed.length === 0 ? whole.toString() : `${whole}.${trimmed}`;
}

const cardLabelStyle: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 10,
  color: "var(--fg-400)",
  letterSpacing: "0.14em",
  textTransform: "uppercase",
};

const rowActionBtnStyle: CSSProperties = {
  padding: "6px 8px",
  borderRadius: 6,
  border: "1px solid var(--fg-700)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-mono)",
  fontSize: 10,
  cursor: "pointer",
  letterSpacing: "0.06em",
  textTransform: "uppercase",
};
