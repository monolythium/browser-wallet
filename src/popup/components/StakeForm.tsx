// Phase 7 — StakeForm. Amount input + selected-cluster context +
// cap-headroom check + Continue CTA. Dumb component: the parent
// (Stake page) owns the cluster pick, the wallet balance, and the
// chain submission.
//
// Cap-headroom logic (§23.6 + §23.7):
//   - The chain's per-cluster cap binds on capital per wallet. Phase 12
//     launch = 50% (5000 bps). The form enforces that requested-amount
//     + already-delegated <= cap × balance so the user can't construct
//     a transaction the chain will reject.
//   - Cap can be `null` (chain returned `u32::MAX` = disabled). When
//     disabled, the form skips the cap check entirely.
//
// MOCK fee: the wallet still uses the §22 native fee model for delegation tx;
// the form quotes a standard execution-unit budget plus a small native fee.
// Real fee suggestion arrives from `wallet-fee-suggestion` IPC at the parent.

import type { CSSProperties } from "react";
import { useMemo } from "react";
import { Icon } from "../Icon";
import {
  MOCK_CLUSTER_APR_BPS,
  type ClusterDirectoryEntry,
} from "../../shared/staking";
import { lythAmountToBps } from "../../shared/staking-tx";

export interface StakeFormProps {
  /** Cluster the user is about to delegate to. */
  cluster: ClusterDirectoryEntry;
  /** Current amount string. The parent owns this so it survives
   *  state transitions back to the picker. */
  amountStr: string;
  onAmountChange: (next: string) => void;
  /** Compatibility prop name retained for existing callers. Value is
   *  v4.1 native lythoshi, not 18-decimal EVM wei. `null` while the
   *  SW `wallet-balance` fetch is in flight. */
  balanceWei: bigint | null;
  /** Already-delegated weight to THIS cluster (bps). Used for the
   *  cap-headroom check — additions stack on top of existing weight. */
  existingWeightBps: number;
  /** Per-cluster cap in bps from `lyth_getDelegationCap`. `null` when
   *  the chain has disabled the cap (`u32::MAX`). */
  capBps: number | null;
  /** Continue → preview/sign. Parent gates this when `canContinue`
   *  is false; the button is still rendered for keyboard a11y. */
  onContinue: () => void;
  /** Back → cluster picker. */
  onBack: () => void;
}

const NATIVE_LYTH_DECIMALS = 8;
const LYTHOSHI_PER_LYTH = 10n ** BigInt(NATIVE_LYTH_DECIMALS);

/** Decimal-LYTH-amount string → lythoshi bigint. Kept inline so
 *  StakeForm stays self-contained at the compatibility boundary. */
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

/** Lythoshi → LYTH display string. Used for the
 *  balance + cap-headroom hint strings. */
export function lythoshiToLyth(lythoshi: bigint, decimals = 4): string {
  const whole = lythoshi / LYTHOSHI_PER_LYTH;
  const remainder = lythoshi % LYTHOSHI_PER_LYTH;
  if (decimals === 0 || remainder === 0n) return whole.toString();
  const remStr = remainder
    .toString()
    .padStart(NATIVE_LYTH_DECIMALS, "0")
    .slice(0, decimals);
  // Trim trailing zeros for compact display.
  const trimmed = remStr.replace(/0+$/, "");
  return trimmed.length === 0 ? whole.toString() : `${whole}.${trimmed}`;
}

export function StakeForm({
  cluster,
  amountStr,
  onAmountChange,
  balanceWei,
  existingWeightBps,
  capBps,
  onContinue,
  onBack,
}: StakeFormProps) {
  const amountLythoshi = useMemo(() => lythToLythoshi(amountStr), [amountStr]);

  // Compute the would-be total delegated weight after this stake.
  const additionalBps =
    amountLythoshi !== null && balanceWei !== null && balanceWei > 0n
      ? lythAmountToBps(amountLythoshi, balanceWei)
      : 0;
  const totalAfterBps = existingWeightBps + additionalBps;

  const overCap = capBps !== null && totalAfterBps > capBps;
  const insufficientFunds =
    amountLythoshi !== null &&
    balanceWei !== null &&
    amountLythoshi > balanceWei;
  const amountIsZero = amountLythoshi === null || amountLythoshi === 0n;

  const canContinue =
    amountLythoshi !== null &&
    amountLythoshi > 0n &&
    !overCap &&
    !insufficientFunds &&
    balanceWei !== null;

  const handleMax = () => {
    if (balanceWei === null) return;
    // Cap-aware max: if there's a cap and existing weight, only fill up
    // to the headroom, not to 100% of balance. If cap is disabled
    // (`capBps === null`), the max is the full balance.
    if (capBps === null) {
      onAmountChange(lythoshiToLyth(balanceWei, NATIVE_LYTH_DECIMALS));
      return;
    }
    const headroomBps = Math.max(0, capBps - existingWeightBps);
    if (headroomBps === 0) {
      onAmountChange("0");
      return;
    }
    // amount = balance * headroomBps / 10000
    const headroomLythoshi = (balanceWei * BigInt(headroomBps)) / 10_000n;
    onAmountChange(
      lythoshiToLyth(headroomLythoshi, NATIVE_LYTH_DECIMALS),
    );
  };

  const aprBps = MOCK_CLUSTER_APR_BPS[cluster.clusterId] ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Selected-cluster summary */}
      <div style={selectedClusterCardStyle}>
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
              Delegating to
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
          APR {aprBps === null ? "—" : `${(aprBps / 100).toFixed(2)}%`} ·{" "}
          {cluster.threshold}-of-{cluster.size} threshold · health{" "}
          {cluster.health}
        </div>
      </div>

      {/* Amount input */}
      <div className="ext-card" style={{ padding: 14 }}>
        <div style={cardLabel}>Amount</div>
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
            disabled={balanceWei === null}
            style={{
              ...inlineBtnStyle,
              opacity: balanceWei === null ? 0.5 : 1,
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
        {insufficientFunds && (
          <div style={inlineErr}>Amount exceeds available balance.</div>
        )}
        {overCap && capBps !== null && (
          <div style={inlineErr}>
            Stake would exceed the per-cluster cap (
            {(capBps / 100).toFixed(0)}%) by{" "}
            {((totalAfterBps - capBps) / 100).toFixed(2)}%.
          </div>
        )}
        <div style={fromHint}>
          {balanceWei === null ? (
            "Balance loading…"
          ) : (
            <>
              available {lythoshiToLyth(balanceWei)} LYTH · existing{" "}
              {(existingWeightBps / 100).toFixed(2)}% in this cluster
              {capBps !== null && (
                <>
                  {" "}
                  · cap {(capBps / 100).toFixed(0)}%
                </>
              )}
            </>
          )}
        </div>
      </div>

      {/* Continue */}
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
          : overCap
            ? "Reduce to cap"
            : insufficientFunds
              ? "Reduce amount"
              : "Review delegation"}
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const selectedClusterCardStyle: CSSProperties = {
  padding: "10px 12px",
  borderRadius: 10,
  background: "rgba(244,201,122,0.06)",
  border: "1px solid rgba(244,201,122,0.4)",
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
