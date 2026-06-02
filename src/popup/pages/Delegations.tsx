// Delegations dashboard. Read-only summary of the
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
import { ExternalLink } from "../components/ExternalLink";
import { monoscanTxUrl } from "../../shared/build-info";
import { RedemptionQueueCard } from "../components/RedemptionQueueCard";
import { RewardCard } from "../components/RewardCard";
import {
  bgStakingClusterDirectory,
  bgStakingDelegations,
  bgStakingPendingRewards,
  bgStakingRedemptionQueue,
  bgWalletBalance,
  bgWalletSendTx,
  type ClusterDirectoryEntry,
  type DelegationsView,
  type PendingRewardsView,
  type RedemptionQueueView,
} from "../bg";
import type { Account } from "../demo-data";
import {
  DELEGATION_PRECOMPILE,
  encodeClaimRewards,
  encodeCompleteRedemption,
} from "../../shared/staking-tx";
import {
  lythoshiToLythDecimal,
  parseHexQuantity,
} from "../../shared/native-amount";

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
  /** Route to the cluster-detail panel for a
   *  specific cluster. */
  onShowClusterDetail?: (cluster: ClusterDirectoryEntry) => void;
}

export function Delegations({
  account,
  chainId,
  onBack,
  onUnstake,
  onRedelegate,
  onStakeMore,
  onShowClusterDetail,
}: DelegationsProps) {
  const [clusters, setClusters] = useState<ClusterDirectoryEntry[]>([]);
  const [delegations, setDelegations] = useState<DelegationsView | null>(null);
  const [balanceLythoshi, setBalanceLythoshi] = useState<bigint | null>(null);
  const [rewards, setRewards] = useState<PendingRewardsView | null>(null);
  const [rewardsMock, setRewardsMock] = useState(true);
  const [redemptionQueue, setRedemptionQueue] =
    useState<RedemptionQueueView | null>(null);
  const [redemptionQueueMock, setRedemptionQueueMock] = useState(false);
  const [redemptionQueueError, setRedemptionQueueError] =
    useState<string | null>(null);
  const [claimSubmitting, setClaimSubmitting] = useState(false);
  const [claimResult, setClaimResult] = useState<
    | { ok: true; txHash: string }
    | { ok: false; reason: string }
    | null
  >(null);
  const [completingIndex, setCompletingIndex] = useState<number | null>(null);
  const [redemptionResult, setRedemptionResult] = useState<
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
    setRedemptionQueue(null);
    setRedemptionQueueMock(false);
    setRedemptionQueueError(null);
    void (async () => {
      const [dirR, delR, balR, queueR] = await Promise.all([
        bgStakingClusterDirectory(),
        bgStakingDelegations(account.addr),
        bgWalletBalance(account.addr, chainId),
        bgStakingRedemptionQueue(account.addr),
      ]);
      if (cancelled) return;
      if (dirR.ok) setClusters(dirR.data.clusters.slice());
      if (delR.ok) setDelegations(delR.data);
      if (balR.ok) {
        const parsedBalance = parseHexQuantity(balR.balanceHex);
        if (parsedBalance !== null) setBalanceLythoshi(parsedBalance);
      }
      if (queueR.ok) {
        setRedemptionQueue(queueR.data);
        setRedemptionQueueMock(queueR.via === "mock");
      } else {
        setRedemptionQueueError(queueR.reason);
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

  const totalDelegatedLythoshi = useMemo(() => {
    if (delegations === null || balanceLythoshi === null) return null;
    return (balanceLythoshi * BigInt(delegations.totalBps)) / 10_000n;
  }, [delegations, balanceLythoshi]);

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
        executionUnitLimitHex: "0x14820", // 84000 — selector-only allowance
        opKind: "claim",
      });
      if (r.ok) setClaimResult({ ok: true, txHash: r.result.txHash });
      else setClaimResult({ ok: false, reason: r.reason ?? "claim rejected" });
    } catch (e) {
      setClaimResult({ ok: false, reason: (e as Error).message ?? "claim failed" });
    } finally {
      setClaimSubmitting(false);
    }
  };

  // Complete-redemption handler — submits `completeRedemption(index)`
  // for a matured ticket through the same bgWalletSendTx envelope as
  // claim/undelegate. With liquid bonding the ticket matures at the
  // undelegate height, so a mature ticket is immediately redeemable;
  // the call returns the queued principal to the wallet balance and
  // prunes the ticket. Selector-only calldata (one uint64 arg).
  const handleCompleteRedemption = async (ticketIndex: number) => {
    setCompletingIndex(ticketIndex);
    setRedemptionResult(null);
    try {
      const r = await bgWalletSendTx({
        to: DELEGATION_PRECOMPILE,
        valueWeiHex: "0x0",
        chainIdHex: chainId,
        data: encodeCompleteRedemption(ticketIndex),
        executionUnitLimitHex: "0x186A0", // 100000 — single-arg precompile call
        opKind: "complete-redemption",
      });
      if (r.ok) {
        setRedemptionResult({ ok: true, txHash: r.result.txHash });
        // Refresh the queue so the redeemed ticket drops out.
        const queueR = await bgStakingRedemptionQueue(account.addr);
        if (queueR.ok) {
          setRedemptionQueue(queueR.data);
          setRedemptionQueueMock(queueR.via === "mock");
        }
      } else {
        setRedemptionResult({
          ok: false,
          reason: r.reason ?? "redemption rejected",
        });
      }
    } catch (e) {
      setRedemptionResult({
        ok: false,
        reason: (e as Error).message ?? "redemption failed",
      });
    } finally {
      setCompletingIndex(null);
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
                totalDelegatedLythoshi === null
                  ? "—"
                  : `${formatLythoshi(totalDelegatedLythoshi)} LYTH (${((delegations?.totalBps ?? 0) / 100).toFixed(2)}%)`
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

        {account.addr.startsWith("0x") && (
          <RedemptionQueueCard
            queue={redemptionQueue}
            isMock={redemptionQueueMock}
            error={redemptionQueueError}
            clusters={clusters}
            onComplete={
              redemptionQueueMock
                ? undefined
                : (ticketIndex) => void handleCompleteRedemption(ticketIndex)
            }
            completingIndex={completingIndex}
          />
        )}

        {/* Redemption result toast */}
        {redemptionResult !== null && (
          <div
            style={
              redemptionResult.ok
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
            {redemptionResult.ok ? (
              <>
                <div>Redemption submitted</div>
                {/* Full tx hash + ↗ + Monoscan link — mirrors the
                   emergency-recovery (SLH-DSA backup) result display. */}
                <ExternalLink
                  href={monoscanTxUrl(redemptionResult.txHash)}
                  title={redemptionResult.txHash}
                  style={{ color: "var(--fg-200)", marginTop: 4 }}
                >
                  {redemptionResult.txHash}
                </ExternalLink>
              </>
            ) : (
              redemptionResult.reason
            )}
          </div>
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
                  const amountLythoshi =
                    balanceLythoshi !== null
                      ? (balanceLythoshi * BigInt(row.weightBps)) / 10_000n
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
                            {amountLythoshi !== null && (
                              <> · {formatLythoshi(amountLythoshi)} LYTH</>
                            )}
                          </div>
                        </div>
                      </div>
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: onShowClusterDetail
                            ? "1fr 1fr 1fr"
                            : "1fr 1fr",
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
                        {onShowClusterDetail && (
                          <button
                            onClick={() => {
                              const c = clusters.find(
                                (cc) => cc.clusterId === row.cluster,
                              );
                              if (c) onShowClusterDetail(c);
                            }}
                            style={rowActionBtnStyle}
                            aria-label={`View details for cluster ${row.cluster}`}
                          >
                            Details
                          </button>
                        )}
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

export function formatLythoshi(lythoshi: bigint, decimals = 4): string {
  return lythoshiToLythDecimal(lythoshi, decimals);
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
