// AutoCompoundSection — the §23 auto-compound preference as a dedicated,
// explained section for the staking surfaces (the Delegate page + the
// Delegations dashboard). Single source of the Phase-6 toggle wiring (submit +
// strict re-read + confirm modal) so both pages share ONE logic path — the
// encoder, the `bgWalletSendTx → submitTrackedTx` submit, and the enable-claims
// confirm disclosure are unchanged from Phase 6.
//
// Visibility (no-mock): shown only for a LIVE pending-rewards read — never for a
// `via:"mock"` / illustrative fallback (we must not flip a fabricated flag) and
// never while loading. Shown with real data even at zero pending, so the user
// can set the preference for future rewards.

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";

import { AutoCompoundConfirmModal } from "./AutoCompoundConfirmModal";
import {
  bgWalletSendTx,
  bgWalletFeeSuggestion,
  type PendingRewardsView,
} from "../bg";
import {
  autoCompoundTxRequest,
  AUTO_COMPOUND_UNIT_LIMIT_HEX,
} from "../../shared/staking-tx";
import { lythoshiToLythDecimal, parseHexQuantity } from "../../shared/native-amount";

/** Pure visibility gate (unit-tested): show only for a LIVE read (not mock, not
 *  loading). Preserves the no-mock rule while surfacing the section with real
 *  reward/delegation data. */
export function autoCompoundSectionVisible(
  rewards: PendingRewardsView | null,
  isMock: boolean,
): boolean {
  return rewards !== null && !isMock;
}

export interface AutoCompoundSectionProps {
  rewards: PendingRewardsView | null;
  /** True when the pending-rewards read is the illustrative mock fallback. */
  isMock: boolean;
  chainId: string;
}

export function AutoCompoundSection({ rewards, isMock, chainId }: AutoCompoundSectionProps) {
  // acTarget !== null ⇒ the confirm modal is open for that TARGET value.
  const [acTarget, setAcTarget] = useState<boolean | null>(null);
  const [acSubmitting, setAcSubmitting] = useState(false);
  const [acError, setAcError] = useState<string | null>(null);
  const [acFeeDisplay, setAcFeeDisplay] = useState<string | null>(null);
  // The value we're awaiting the on-chain re-read to reflect (STRICT — the row
  // shows the actual `rewards.autoCompound` until the parent's poll confirms the
  // flip; never an optimistic lie). null ⇒ not in flight.
  const [acPendingTarget, setAcPendingTarget] = useState<boolean | null>(null);

  // Clear the in-flight state once the polled re-read reflects the target flag.
  useEffect(() => {
    if (acPendingTarget === null || rewards === null) return;
    if (rewards.autoCompound === acPendingTarget) setAcPendingTarget(null);
  }, [rewards, acPendingTarget]);

  const currentPendingLythoshi = useMemo(
    () => (rewards === null ? 0n : parseHexQuantity(rewards.totalAmountWei) ?? 0n),
    [rewards],
  );

  const openConfirm = (enabled: boolean) => {
    setAcTarget(enabled);
    setAcError(null);
    setAcFeeDisplay(null);
    // Best-effort fee estimate (limit × per-unit price). On any failure the
    // confirm shows an honest "fee applies" note — never a fabricated number.
    void (async () => {
      const r = await bgWalletFeeSuggestion(chainId);
      if (!r.ok) return;
      const price = parseHexQuantity(r.suggestion.maxPricePerExecutionUnitLythoshiHex);
      const limit = parseHexQuantity(AUTO_COMPOUND_UNIT_LIMIT_HEX);
      if (price === null || limit === null) return;
      setAcFeeDisplay(lythoshiToLythDecimal(price * limit));
    })();
  };

  const confirm = async () => {
    if (acTarget === null) return;
    const target = acTarget;
    setAcSubmitting(true);
    setAcError(null);
    try {
      const r = await bgWalletSendTx(autoCompoundTxRequest(target, chainId));
      if (r.ok) {
        setAcPendingTarget(target); // await the strict re-read
        setAcTarget(null); // close the modal
      } else {
        setAcError(r.reason ?? "Couldn't update auto-compound.");
      }
    } catch (e) {
      setAcError((e as Error).message ?? "Couldn't update auto-compound.");
    } finally {
      setAcSubmitting(false);
    }
  };

  if (!autoCompoundSectionVisible(rewards, isMock) || rewards === null) return null;
  const on = rewards.autoCompound;
  const pending = acPendingTarget !== null;

  return (
    <div className="ext-card" style={{ padding: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={cardLabel}>Auto-compound</div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="Toggle auto-compound"
          disabled={pending}
          onClick={() => openConfirm(!on)}
          style={{
            ...toggle,
            background: on ? "var(--gold-bg)" : "rgba(255,255,255,0.04)",
            borderColor: on ? "var(--gold)" : "var(--fg-700)",
            color: on ? "var(--gold)" : "var(--fg-300)",
            opacity: pending ? 0.5 : 1,
            cursor: pending ? "default" : "pointer",
          }}
        >
          {pending ? "Updating…" : on ? "On" : "Off"}
        </button>
      </div>
      <div style={explain}>
        Automatically restake your delegation rewards instead of leaving them to
        claim by hand — compounding your effective weight over time.{" "}
        <strong style={{ color: "var(--fg-200)" }}>
          Turning it on also claims your current pending rewards now.
        </strong>
      </div>

      <AutoCompoundConfirmModal
        open={acTarget !== null}
        enabling={acTarget ?? false}
        pendingLythoshi={currentPendingLythoshi}
        feeLythDisplay={acFeeDisplay}
        submitting={acSubmitting}
        error={acError}
        onConfirm={() => void confirm()}
        onCancel={() => setAcTarget(null)}
      />
    </div>
  );
}

const cardLabel: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 10,
  color: "var(--fg-400)",
  letterSpacing: "0.14em",
  textTransform: "uppercase",
};

const toggle: CSSProperties = {
  flexShrink: 0,
  padding: "5px 14px",
  borderRadius: 8,
  border: "1px solid",
  fontFamily: "var(--f-sans)",
  fontSize: 11,
  fontWeight: 600,
  minWidth: 58,
  transition: "all 150ms var(--e-out)",
};

const explain: CSSProperties = {
  marginTop: 8,
  fontSize: 11,
  color: "var(--fg-400)",
  lineHeight: 1.5,
};
