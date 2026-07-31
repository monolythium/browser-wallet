// Confirm dialog for the §23 auto-compound toggle.
//
// WYSIWYS + the safety anchor: ENABLING auto-compound also CLAIMS the wallet's
// pending rewards immediately in the same tx (chain `auto_claim_if_enabled` —
// the whole pending amount is withdrawn to balance). This modal discloses that
// PROMINENTLY when enabling with a pending reward — it is fund-relevant, not a
// passive setting flip. Disabling has no such effect. Pure/presentational; the
// parent owns the submit + the strict post-tx re-read.

import type { CSSProperties } from "react";

import { Modal } from "./Modal";
import { formatLythoshiAsLyth } from "./RewardCard";
import type { SubmitFailure } from "../submit-failure";

/**
 * The fund-relevant disclosure (the safety anchor), extracted as a pure helper
 * so it's unit-testable without the portal DOM. Returns the claim-warning
 * sentence when — and ONLY when — the toggle is being ENABLED and there is a
 * pending reward that enabling will immediately claim; else `null`. Disabling
 * and enabling-with-zero-pending never claim.
 */
export function autoCompoundClaimDisclosure(
  enabling: boolean,
  pendingLythoshi: bigint,
): string | null {
  if (!enabling || pendingLythoshi <= 0n) return null;
  return `This also claims your pending ${formatLythoshiAsLyth(pendingLythoshi, 4)} LYTH now.`;
}

/** The network-fee line copy — an exact figure when quoted, else an honest
 *  generic note (never a fabricated/`null` number). */
export function autoCompoundFeeLine(feeLythDisplay: string | null): string {
  return feeLythDisplay !== null ? `${feeLythDisplay} LYTH` : "applies (paid in LYTH)";
}

export interface AutoCompoundConfirmModalProps {
  open: boolean;
  /** The TARGET state being confirmed (true = turning on). */
  enabling: boolean;
  /** Current pending reward (lythoshi) — drives the enable-claims disclosure. */
  pendingLythoshi: bigint;
  /** Formatted network fee in LYTH, or `null` when the fee couldn't be quoted
   *  (→ an honest generic note, never a fabricated number). */
  feeLythDisplay: string | null;
  submitting: boolean;
  /** Classified failure of the previous attempt, or null. Its presence is also
   *  what turns the primary button into the retry affordance — the parent treats
   *  the next press as a retry of the attempt this describes. */
  error: SubmitFailure | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function AutoCompoundConfirmModal({
  open,
  enabling,
  pendingLythoshi,
  feeLythDisplay,
  submitting,
  error,
  onConfirm,
  onCancel,
}: AutoCompoundConfirmModalProps) {
  const claimNote = autoCompoundClaimDisclosure(enabling, pendingLythoshi);

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={enabling ? "Turn on auto-compound" : "Turn off auto-compound"}
      description={
        enabling
          ? "Future rewards will be claimed and delegated back automatically."
          : "Rewards will stop compounding — claim them manually."
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {claimNote !== null && (
          <div style={claimWarnBox}>
            <strong>{claimNote}</strong> Turning on auto-compound settles and pays
            out your current rewards to your balance in the same transaction.
          </div>
        )}

        <div style={feeLine}>
          <span style={{ color: "var(--fg-400)" }}>Network fee</span>
          <span style={{ fontFamily: "var(--f-mono)" }}>
            {autoCompoundFeeLine(feeLythDisplay)}
          </span>
        </div>

        {error !== null && (
          <div style={errBox}>
            {error.headline !== null && (
              <div style={{ fontWeight: 600, marginBottom: 3 }}>{error.headline}</div>
            )}
            {error.body}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            style={{ ...ghostBtn, flex: 1, opacity: submitting ? 0.5 : 1 }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={submitting}
            style={{ ...primaryBtn, flex: 1, opacity: submitting ? 0.6 : 1 }}
          >
            {/* With an error showing, this control IS the retry affordance —
                same wording Send and Stake use, rather than a third button. The
                parent reads the same `error !== null` to decide the next submit
                carries the key instead of minting a fresh one. */}
            {submitting
              ? "Submitting…"
              : error !== null
                ? "Try again"
                : enabling
                  ? "Enable"
                  : "Disable"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

const claimWarnBox: CSSProperties = {
  fontSize: 11.5,
  lineHeight: 1.5,
  color: "var(--fg-100)",
  padding: 10,
  borderRadius: 8,
  border: "1px solid rgba(var(--gold-glow), 0.5)",
  background: "rgba(var(--gold-glow), 0.1)",
};

const feeLine: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  fontSize: 11.5,
  padding: "6px 2px",
};

const errBox: CSSProperties = {
  fontSize: 11,
  color: "var(--err)",
  padding: 8,
  border: "1px solid rgba(220,80,80,0.4)",
  borderRadius: 8,
  background: "rgba(220,80,80,0.08)",
};

const ghostBtn: CSSProperties = {
  padding: "9px 16px",
  borderRadius: 8,
  border: "1px solid var(--fg-700)",
  background: "transparent",
  color: "var(--fg-100)",
  fontFamily: "var(--f-sans)",
  fontSize: 12.5,
  fontWeight: 600,
  cursor: "pointer",
};

const primaryBtn: CSSProperties = {
  padding: "9px 16px",
  borderRadius: 8,
  border: "1px solid var(--gold)",
  background: "var(--gold-bg)",
  color: "var(--gold)",
  fontFamily: "var(--f-sans)",
  fontSize: 12.5,
  fontWeight: 600,
  cursor: "pointer",
};
