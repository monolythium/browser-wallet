// Phase 7 — UnstakeForm. Drop weight from an existing delegation.
//
// Per whitepaper §23.2 ("zero unbonding period for delegators"), the
// chain releases delegated weight instantly. There is no redemption
// queue, no countdown, no waiting period. The form's UX language
// is explicit about this — the user sees "Available immediately"
// rather than a misleading lockup countdown.
//
// Submitted as `undelegate(uint256 clusterId, uint256 weightBps)` via
// the same bgWalletSendTx path as stake. Encoded by
// shared/staking-tx.ts:encodeUndelegate.

import type { CSSProperties } from "react";
import { useMemo } from "react";
import { Icon } from "../Icon";
import {
  MOCK_CLUSTER_APR_BPS,
  type ClusterDirectoryEntry,
} from "../../shared/staking";
import { lythAmountToBps } from "../../shared/staking-tx";

export interface UnstakeFormProps {
  /** Cluster currently being unstaked from. */
  cluster: ClusterDirectoryEntry;
  /** Current delegation weight to this cluster (bps). The form's max
   *  enforcement uses this directly. */
  currentWeightBps: number;
  /** Amount string. The parent owns it so a transition back to the
   *  delegation list and back doesn't lose typing. */
  amountStr: string;
  onAmountChange: (next: string) => void;
  /** Compatibility prop name retained for existing callers. Value is
   *  v4.1 native lythoshi, not 18-decimal EVM wei. Used to display
   *  the LYTH amount the bps weight represents. */
  balanceWei: bigint | null;
  onContinue: () => void;
  onBack: () => void;
}

const NATIVE_LYTH_DECIMALS = 8;
const LYTHOSHI_PER_LYTH = 10n ** BigInt(NATIVE_LYTH_DECIMALS);

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
  amountStr,
  onAmountChange,
  balanceWei,
  onContinue,
  onBack,
}: UnstakeFormProps) {
  const amountLythoshi = useMemo(() => lythToLythoshi(amountStr), [amountStr]);
  const currentDelegationLythoshi =
    balanceWei !== null && currentWeightBps > 0
      ? (balanceWei * BigInt(currentWeightBps)) / 10_000n
      : 0n;
  const removeBps =
    amountLythoshi !== null && balanceWei !== null && balanceWei > 0n
      ? lythAmountToBps(amountLythoshi, balanceWei)
      : 0;

  const exceedsDelegation = removeBps > currentWeightBps;
  const amountIsZero = amountLythoshi === null || amountLythoshi === 0n;
  const canContinue = !amountIsZero && !exceedsDelegation && balanceWei !== null;

  const handleMax = () => {
    if (balanceWei === null || currentWeightBps <= 0) return;
    // Max = full current delegation amount in this cluster.
    onAmountChange(
      lythoshiToLyth(currentDelegationLythoshi, NATIVE_LYTH_DECIMALS),
    );
  };

  const aprBps = MOCK_CLUSTER_APR_BPS[cluster.clusterId] ?? null;

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
          <button onClick={onBack} style={changeBtnStyle}>
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
          Currently delegating {lythoshiToLyth(currentDelegationLythoshi)} LYTH (
          {(currentWeightBps / 100).toFixed(2)}%) · APR{" "}
          {aprBps === null ? "—" : `${(aprBps / 100).toFixed(2)}%`}
        </div>
      </div>

      {/* Amount input */}
      <div className="ext-card" style={{ padding: 14 }}>
        <div style={cardLabel}>Amount to remove</div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 6,
          }}
        >
          <input
            type="text"
            value={amountStr}
            onChange={(e) => onAmountChange(e.target.value.trim())}
            placeholder="0.0"
            inputMode="decimal"
            style={amountInputStyle}
          />
          <button
            onClick={handleMax}
            disabled={balanceWei === null || currentWeightBps <= 0}
            style={{
              ...inlineBtnStyle,
              opacity: balanceWei === null || currentWeightBps <= 0 ? 0.5 : 1,
            }}
            type="button"
          >
            Max
          </button>
          <div
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 11,
              color: "var(--fg-400)",
            }}
          >
            LYTH
          </div>
        </div>
        {exceedsDelegation && (
          <div style={inlineErr}>
            Amount exceeds your current delegation in this cluster (
            {lythoshiToLyth(currentDelegationLythoshi)} LYTH).
          </div>
        )}
        <div style={fromHint}>
          Available immediately — §23.2 zero-unbond for delegators.
          {amountLythoshi !== null &&
            amountLythoshi > 0n &&
            !exceedsDelegation && (
              <>
                {" "}
                Removing {(removeBps / 100).toFixed(2)}% · leaves{" "}
                {((currentWeightBps - removeBps) / 100).toFixed(2)}% delegated.
              </>
            )}
        </div>
      </div>

      <button
        className="ext-act prim"
        onClick={onContinue}
        disabled={!canContinue}
        style={{
          width: "100%",
          padding: "12px",
          flexDirection: "row",
          gap: 8,
          opacity: canContinue ? 1 : 0.5,
          cursor: canContinue ? "pointer" : "default",
        }}
      >
        <Icon name="check" size={12} />
        {amountIsZero
          ? "Enter an amount"
          : exceedsDelegation
            ? "Reduce amount"
            : "Review unstake"}
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
};

const cardLabel: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 10,
  color: "var(--fg-400)",
  letterSpacing: "0.14em",
  textTransform: "uppercase",
};

const amountInputStyle: CSSProperties = {
  flex: 1,
  padding: "10px 12px",
  borderRadius: 10,
  background: "rgba(0,0,0,0.3)",
  border: "1px solid var(--fg-700)",
  color: "var(--fg-100)",
  fontSize: 13,
  fontFamily: "var(--f-mono)",
  boxSizing: "border-box",
};

const inlineBtnStyle: CSSProperties = {
  padding: "8px 12px",
  borderRadius: 10,
  border: "1px solid var(--fg-700)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-sans)",
  fontSize: 11,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const inlineErr: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 10,
  color: "var(--err)",
  marginTop: 6,
};

const fromHint: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 10,
  color: "var(--fg-500)",
  marginTop: 8,
  lineHeight: 1.5,
};
