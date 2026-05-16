// Phase 7 — RewardCard. Pending-rewards summary + per-cluster breakdown
// + "Claim all" button.
//
// Data source: bgStakingPendingRewards returns a mock-derived view
// today (chain GAP — no `lyth_pendingRewards` reader yet in the SDK
// at 0fd8a79). The card surfaces `via: "mock"` with an explicit
// "illustrative — chain side pending" banner so the figures don't
// mislead.
//
// Claim path: `claimRewards()` is a selector-only precompile call
// (no args). Encoded via shared/staking-tx.ts:encodeClaimRewards()
// and routed through bgWalletSendTx exactly like delegate/undelegate.
// One tx claims across every active delegation.

import type { CSSProperties } from "react";
import { useMemo } from "react";
import { Icon } from "../Icon";
import {
  type ClusterDirectoryEntry,
  type PendingRewardsView,
} from "../../shared/staking";

interface RewardCardProps {
  rewards: PendingRewardsView | null;
  /** `true` when the SW returned mock data (chain side not yet live). */
  isMock: boolean;
  clusters: ReadonlyArray<ClusterDirectoryEntry>;
  /** Called when the user taps "Claim all". The parent owns the SW
   *  submission flow + tx-confirm UX, mirroring the pattern from
   *  Stake.tsx's other delegation actions. */
  onClaim: () => void;
  /** Disable the claim button while a previous claim is in flight or
   *  the wallet has zero accrued rewards. */
  claimDisabled: boolean;
  /** Phase 9 — when `false`, hide the per-cluster breakdown +
   *  effective-APR annotations ("advanced reward analytics" per
   *  §28.5 Q29's TRADING_INTERFACE flag). The total reward + claim
   *  button stay visible. Default `true` so existing call sites
   *  that haven't been retrofitted with the feature flag render as
   *  before. */
  showAdvancedAnalytics?: boolean;
}

export function RewardCard({
  rewards,
  isMock,
  clusters,
  onClaim,
  claimDisabled,
  showAdvancedAnalytics = true,
}: RewardCardProps) {
  const clusterById = useMemo(() => {
    const m = new Map<number, ClusterDirectoryEntry>();
    for (const c of clusters) m.set(c.clusterId, c);
    return m;
  }, [clusters]);

  if (rewards === null) {
    return (
      <div className="ext-card" style={{ padding: 12 }}>
        <div style={cardLabel}>Pending rewards</div>
        <div
          style={{
            marginTop: 8,
            fontSize: 11,
            color: "var(--fg-400)",
            fontFamily: "var(--f-mono)",
          }}
        >
          Loading…
        </div>
      </div>
    );
  }

  const totalWei = (() => {
    try {
      return BigInt(rewards.totalAmountWei);
    } catch {
      return 0n;
    }
  })();
  const totalIsZero = totalWei === 0n;

  return (
    <div className="ext-card" style={{ padding: 12 }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={cardLabel}>Pending rewards · §23.4</div>
        {isMock && (
          <span style={mockBadgeStyle} title="Chain side has not yet surfaced a pending-rewards reader; figures derived locally from active delegations × cluster APR.">
            illustrative
          </span>
        )}
      </div>

      {/* Total */}
      <div
        style={{
          marginTop: 8,
          display: "flex",
          alignItems: "baseline",
          gap: 8,
        }}
      >
        <span
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 20,
            fontWeight: 600,
            color: totalIsZero ? "var(--fg-400)" : "var(--gold)",
          }}
        >
          {formatLyth(totalWei, 6)}
        </span>
        <span
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 10.5,
            color: "var(--fg-400)",
            letterSpacing: "0.06em",
          }}
        >
          LYTH
        </span>
      </div>

      {/* Per-cluster breakdown — gated behind TRADING_INTERFACE
          (§28.5 Q29). When the flag is off, only the total + claim
          button stay visible. */}
      {showAdvancedAnalytics && rewards.rows.length > 0 && (
        <div
          style={{
            marginTop: 10,
            display: "flex",
            flexDirection: "column",
            gap: 4,
            maxHeight: 140,
            overflowY: "auto",
          }}
        >
          {rewards.rows.map((row) => {
            const c = clusterById.get(row.cluster);
            let weiVal = 0n;
            try {
              weiVal = BigInt(row.amountWei);
            } catch {
              // malformed mock entry — skip the row content
            }
            return (
              <div
                key={row.cluster}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "4px 8px",
                  fontSize: 11,
                  borderRadius: 6,
                  background: "rgba(255,255,255,0.02)",
                  border: "1px solid var(--fg-700)",
                }}
              >
                <span
                  style={{
                    fontFamily: "var(--f-mono)",
                    color: "var(--fg-300)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {c?.name ?? `cluster-${row.cluster}`}
                </span>
                <span
                  style={{
                    fontFamily: "var(--f-mono)",
                    fontSize: 10.5,
                    color: "var(--fg-200)",
                  }}
                >
                  {formatLyth(weiVal, 6)} LYTH
                  {row.effectiveAprBps !== null && (
                    <span style={{ color: "var(--fg-500)", marginLeft: 6 }}>
                      · APR {(row.effectiveAprBps / 100).toFixed(2)}%
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Claim button */}
      <button
        onClick={onClaim}
        disabled={claimDisabled || totalIsZero}
        className={totalIsZero ? undefined : "ext-act prim"}
        style={{
          marginTop: 10,
          width: "100%",
          padding: 10,
          ...(totalIsZero
            ? {
                borderRadius: 8,
                border: "1px solid var(--fg-700)",
                background: "rgba(255,255,255,0.04)",
                color: "var(--fg-400)",
                fontFamily: "var(--f-sans)",
                fontSize: 11.5,
                cursor: "default",
              }
            : {
                flexDirection: "row" as const,
                gap: 8,
                opacity: claimDisabled ? 0.5 : 1,
                cursor: claimDisabled ? "default" : "pointer",
              }),
        }}
      >
        {!totalIsZero && <Icon name="check" size={12} />}
        {totalIsZero ? "No rewards yet" : "Claim all"}
      </button>

      {isMock && (
        <div
          style={{
            marginTop: 8,
            fontFamily: "var(--f-mono)",
            fontSize: 9.5,
            color: "var(--fg-500)",
            lineHeight: 1.5,
          }}
        >
          Chain side has not yet exposed a pending-rewards reader; the
          claim tx still routes to the delegation precompile and accrues
          on-chain rewards correctly once the gate activates.
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers + styles
// ─────────────────────────────────────────────────────────────────────────────

function formatLyth(wei: bigint, decimals: number): string {
  if (wei <= 0n) return "0";
  const whole = wei / 10n ** 18n;
  const rem = wei % 10n ** 18n;
  if (rem === 0n || decimals === 0) return whole.toString();
  const remStr = rem.toString().padStart(18, "0").slice(0, decimals);
  const trimmed = remStr.replace(/0+$/, "");
  return trimmed.length === 0 ? whole.toString() : `${whole}.${trimmed}`;
}

const cardLabel: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 10,
  color: "var(--fg-400)",
  letterSpacing: "0.14em",
  textTransform: "uppercase",
};

const mockBadgeStyle: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 8.5,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  padding: "1px 5px",
  borderRadius: 3,
  background: "rgba(244,201,122,0.08)",
  border: "1px solid rgba(244,201,122,0.4)",
  color: "var(--warn)",
};
