// RewardCard. Pending-rewards summary + per-cluster breakdown
// + "Claim all" button.
//
// Data source: bgStakingPendingRewards reads `lyth_pendingRewards`
// first. When an older/offline operator cannot serve that method, the
// card surfaces `via: "mock"` with an explicit illustrative banner so
// fallback figures don't look like live reward state.
//
// Claim path: `claim()` is a selector-only precompile call (no args;
// SDK encodeClaimCalldata). Encoded via shared/staking-tx.ts:encodeClaimRewards()
// and routed through bgWalletSendTx exactly like delegate/undelegate.
// One tx claims across every active delegation.

import type { CSSProperties } from "react";
import { useMemo } from "react";
import { Icon } from "../Icon";
import {
  type ClusterDirectoryEntry,
  type PendingRewardsView,
} from "../../shared/staking";
import { LYTHOSHI_PER_LYTH, NATIVE_LYTH_DECIMALS } from "@monolythium/core-sdk";

interface RewardCardProps {
  /** Compatibility reward fields are still named `*Wei` in
   *  PendingRewardsView; values rendered here are native lythoshi (now
   *  18-decimal — 1 lythoshi == 1 wei after the chain's 8 → 18 migration). */
  rewards: PendingRewardsView | null;
  /** Set to the fetch-failure reason when the pending-rewards read returned
   *  `ok: false` (a hard error — malformed/schema-mismatched response, or an
   *  RPC error not classified as "method absent"). When set, the card renders
   *  honest absence ("unavailable") instead of perpetual "Loading…" — and
   *  NOT mock figures. `null` while genuinely loading or on success. The
   *  method-absent `via: "mock"` path is separate (see `isMock`). */
  error?: string | null;
  /** `true` when the SW returned fallback mock data. */
  isMock: boolean;
  clusters: ReadonlyArray<ClusterDirectoryEntry>;
  /** Called when the user taps "Claim all". The parent owns the SW
   *  submission flow + tx-confirm UX, mirroring the pattern from
   *  Stake.tsx's other delegation actions. */
  onClaim: () => void;
  /** Disable the claim button while a previous claim is in flight or
   *  the wallet has zero accrued rewards. */
  claimDisabled: boolean;
  /** When `false`, hide the per-cluster breakdown +
   *  effective-APR annotations ("advanced reward analytics" per
   *  §28.5 Q29's TRADING_INTERFACE flag). The total reward + claim
   *  button stay visible. Default `true` so existing call sites
   *  that haven't been retrofitted with the feature flag render as
   *  before. */
  showAdvancedAnalytics?: boolean;
}

export function RewardCard({
  rewards,
  error = null,
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

  // Hard fetch failure (ok:false) → honest absence per no-mock-fallback:
  // never perpetual "Loading…" and never illustrative mock figures. Takes
  // precedence over the null/loading check so a stuck fetch can't hide it.
  if (error != null) {
    return (
      <div className="ext-card" style={{ padding: 12 }}>
        <div style={cardLabel}>Pending rewards</div>
        <div style={errorBannerStyle}>Pending rewards unavailable.</div>
      </div>
    );
  }

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

  const totalLythoshi = (() => {
    try {
      return BigInt(rewards.totalAmountWei);
    } catch {
      return 0n;
    }
  })();
  const totalIsZero = totalLythoshi === 0n;

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
        <div style={cardLabel}>Pending rewards</div>
        {isMock && (
          <span style={mockBadgeStyle} title="Live pending-rewards read is unavailable from this operator; figures are derived locally from active delegations × cluster APR.">
            illustrative
          </span>
        )}
      </div>

      {/* Total + Claim — same row, button to the right of the amount */}
      <div
        style={{
          marginTop: 8,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 6,
            minWidth: 0,
          }}
        >
          <span
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 20,
              fontWeight: 600,
              color: totalIsZero ? "var(--fg-400)" : "var(--gold)",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {formatLythoshiAsLyth(totalLythoshi, 4)}
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
        <button
          onClick={onClaim}
          disabled={claimDisabled || totalIsZero}
          className={totalIsZero ? undefined : "ext-act prim"}
          style={{
            flexShrink: 0,
            padding: "7px 12px",
            ...(totalIsZero
              ? {
                  borderRadius: 8,
                  border: "1px solid var(--fg-700)",
                  background: "rgba(255,255,255,0.04)",
                  color: "var(--fg-400)",
                  fontFamily: "var(--f-sans)",
                  fontSize: 11,
                  cursor: "default",
                }
              : {
                  flexDirection: "row" as const,
                  gap: 6,
                  fontSize: 11.5,
                  opacity: claimDisabled ? 0.5 : 1,
                  cursor: claimDisabled ? "default" : "pointer",
                }),
          }}
        >
          {!totalIsZero && <Icon name="check" size={11} />}
          {totalIsZero ? "No rewards yet" : "Claim all"}
        </button>
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
            let rowLythoshi = 0n;
            try {
              rowLythoshi = BigInt(row.amountWei);
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
                  {formatLythoshiAsLyth(rowLythoshi, 4)} LYTH
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
          These are estimated figures — rewards still settle on-chain.
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers + styles
// ─────────────────────────────────────────────────────────────────────────────

// LYTHOSHI_PER_LYTH (10^18) is imported from the SDK above — single source of truth.

export function formatLythoshiAsLyth(
  lythoshi: bigint,
  decimals: number,
): string {
  if (lythoshi <= 0n) return "0";
  const whole = lythoshi / LYTHOSHI_PER_LYTH;
  const rem = lythoshi % LYTHOSHI_PER_LYTH;
  if (rem === 0n || decimals === 0) return whole.toString();
  const remStr = rem
    .toString()
    .padStart(NATIVE_LYTH_DECIMALS, "0")
    .slice(0, decimals);
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

// Staking-read failure banner.
const errorBannerStyle: CSSProperties = {
  marginTop: 8,
  padding: "8px 10px",
  borderRadius: 8,
  background: "rgba(220,80,80,0.08)",
  border: "1px solid rgba(220,80,80,0.4)",
  color: "var(--err)",
  fontFamily: "var(--f-mono)",
  fontSize: 10.5,
  lineHeight: 1.5,
  wordBreak: "break-word",
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
