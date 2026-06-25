// UnstakeForm — remove an existing delegation.
//
// The chain primitive `undelegate(uint32 cluster)` INSTANTLY removes the
// wallet's entire row for the cluster (full-row removal — there is no
// partial unstake on-chain). Delegation is non-custodial, so nothing was
// ever escrowed: there is no redemption queue, cooldown, or claim step —
// the weighting simply drops. The form reflects this: a single "Unstake all"
// confirmation, no amount input.
//
// Submitted as `undelegate(uint32 cluster)` via the same bgWalletSendTx
// path as stake (value = 0). Encoded by shared/staking-tx.ts:encodeUndelegate.

import type { CSSProperties } from "react";
import { Icon } from "../Icon";
import { hoverBg } from "../hover";
import type { ClusterDirectoryEntry } from "../../shared/staking";
import { LYTHOSHI_PER_LYTH, NATIVE_LYTH_DECIMALS } from "@monolythium/core-sdk";

export interface UnstakeFormProps {
  /** Cluster currently being unstaked from. */
  cluster: ClusterDirectoryEntry;
  /** Current delegation weight to this cluster (bps). Displayed; the
   *  whole row is removed regardless of amount. */
  currentWeightBps: number;
  /** Native lythoshi balance (18-decimal). Used to display the LYTH
   *  amount the current weight represents. */
  balanceLythoshi: bigint | null;
  onContinue: () => void;
  onBack: () => void;
}

// LYTHOSHI_PER_LYTH (10^18) is imported from the SDK above — single source of truth.

export function lythToLythoshi(amountStr: string): bigint | null {
  if (!/^\d+(\.\d+)?$/.test(amountStr)) return null;
  const dot = amountStr.indexOf(".");
  const intPart = dot < 0 ? amountStr : amountStr.slice(0, dot);
  const fracPart = dot < 0 ? "" : amountStr.slice(dot + 1);
  if (fracPart.length > NATIVE_LYTH_DECIMALS) return null;
  const padded =
    fracPart + "0".repeat(NATIVE_LYTH_DECIMALS - fracPart.length);
  try {
    return (
      BigInt(intPart) * LYTHOSHI_PER_LYTH +
      (padded.length > 0 ? BigInt(padded) : 0n)
    );
  } catch {
    return null;
  }
}

export function lythoshiToLyth(lythoshi: bigint, decimals = 4): string {
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

export function UnstakeForm({
  cluster,
  currentWeightBps,
  balanceLythoshi,
  onContinue,
  onBack,
}: UnstakeFormProps) {
  const currentDelegationLythoshi =
    balanceLythoshi !== null && currentWeightBps > 0
      ? (balanceLythoshi * BigInt(currentWeightBps)) / 10_000n
      : 0n;
  const hasDelegation = currentWeightBps > 0 && balanceLythoshi !== null;
  const aprBps = cluster.aprBps ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Source cluster summary */}
      <div style={sourceClusterCardStyle}>
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
                fontFamily: "var(--f-mono)",
                fontSize: 10,
                color: "var(--fg-400)",
                letterSpacing: "0.1em",
                textTransform: "uppercase",
              }}
            >
              Unstaking from
            </div>
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "var(--fg-100)",
                marginTop: 2,
              }}
            >
              {cluster.name ?? `cluster-${cluster.clusterId}`}
            </div>
          </div>
          <button
            onClick={onBack}
            style={changeBtnStyle}
            {...hoverBg("rgba(255,255,255,0.04)")}
          >
            Change
          </button>
        </div>
        <div
          style={{
            marginTop: 8,
            fontFamily: "var(--f-mono)",
            fontSize: 10,
            color: "var(--fg-400)",
            lineHeight: 1.6,
          }}
        >
          Effective weight {lythoshiToLyth(currentDelegationLythoshi)} LYTH (
          {(currentWeightBps / 100).toFixed(2)}% of balance) · APR{" "}
          {aprBps === null ? "—" : `${(aprBps / 100).toFixed(2)}%`}
        </div>
      </div>

      {/* Full-row removal notice — the chain has no partial unstake. */}
      <div className="ext-card" style={{ padding: 14 }}>
        <div style={cardLabel}>Undelegate all</div>
        <div style={fromHint}>
          {hasDelegation ? (
            <>
              Removes your <strong>entire</strong> delegation from this cluster
              (effective weight {lythoshiToLyth(currentDelegationLythoshi)} LYTH ·{" "}
              {(currentWeightBps / 100).toFixed(2)}%). The chain has no partial
              undelegation. This is <strong>instant</strong> — no cooldown or
              redemption queue, because your tokens were never locked. Re-delegate
              any percent afterward.
            </>
          ) : (
            <>You have no active delegation in this cluster to undelegate.</>
          )}
        </div>
      </div>

      <button
        className="ext-act prim-soft"
        onClick={onContinue}
        disabled={!hasDelegation}
        style={{
          width: "100%",
          padding: "12px",
          flexDirection: "row",
          gap: 8,
          opacity: hasDelegation ? 1 : 0.5,
          cursor: hasDelegation ? "pointer" : "default",
        }}
      >
        <Icon name="check" size={12} />
        {hasDelegation ? "Review undelegation (full)" : "No active delegation"}
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const sourceClusterCardStyle: CSSProperties = {
  padding: "10px 12px",
  borderRadius: 10,
  background: "rgba(220,80,80,0.05)",
  border: "1px solid rgba(220,80,80,0.3)",
};

const changeBtnStyle: CSSProperties = {
  padding: "5px 10px",
  borderRadius: 6,
  border: "1px solid var(--fg-700)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--fg-200)",
  fontFamily: "var(--f-mono)",
  fontSize: 9.5,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  cursor: "pointer",
  transition: "background 120ms",
};

const cardLabel: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 10,
  color: "var(--fg-400)",
  letterSpacing: "0.14em",
  textTransform: "uppercase",
};

const fromHint: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 10,
  color: "var(--fg-500)",
  marginTop: 8,
  lineHeight: 1.5,
};
