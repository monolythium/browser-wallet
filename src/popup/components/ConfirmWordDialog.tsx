// Shared typed-confirm destructive dialog.
//
// The wallet already asks the user to type a word before an irreversible wipe,
// in three places: Settings -> Reset wallet (ResetWallet's `confirm` step),
// Welcome -> Forgot password, and the unlock screen's
// I-don't-know-my-phrase path. All three use the same word and the same
// match rule. This is that pattern as one component, for per-item destructive
// actions that need it.
//
// Structure and copy are lifted from ResetWallet's confirm step (the warning
// card, the uppercase mono field label, the field styling) and NetworkDetail's
// delete modal (the per-item Modal shape and its Cancel / red-confirm footer).
// No new visual language.
//
// The word is WIPE_CONFIRM_WORD from shared/constants — the same constant the
// service worker validates `keystore-wipe-unauth` against. There is no literal
// and no second constant.
//
// ADDITIVE: no existing surface is migrated onto this here.

import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

import { WIPE_CONFIRM_WORD } from "../../shared/constants";
import { Icon } from "../Icon";
import { Modal } from "./Modal";

export { WIPE_CONFIRM_WORD };

/**
 * The match rule, verbatim from every existing consumer:
 *
 *   ResetWallet.tsx    confirmInput.trim().toUpperCase() !== CONFIRM_WORD
 *   ForgotPassword.tsx confirmText.trim().toUpperCase() === CONFIRM_WORD
 *   UnlockScreen.tsx   resetConfirmInput.trim().toUpperCase() === RESET_CONFIRM_WORD
 *
 * So: trimmed, then upper-cased — case-INSENSITIVE and whitespace-tolerant.
 * `delete`, `Delete` and `  DELETE  ` all pass. Exported pure so the rule is
 * testable without a DOM and cannot drift from the three existing surfaces.
 */
export function confirmWordMatches(input: string): boolean {
  return input.trim().toUpperCase() === WIPE_CONFIRM_WORD;
}

/**
 * The default warning body, verbatim from ResetWallet's confirm step. Split at
 * the <strong> boundary so the emphasis survives while the wording itself
 * stays pinnable: this component is portal-based (Modal -> createPortal into
 * document.body) and so is not statically rendered under the Node test env —
 * same posture as the auto-compound / passkey / SLH-DSA modals. Keeping the
 * copy in an exported constant is what lets a test guard it.
 *
 * This is a safety anchor. It is the only place the user is told that removal
 * is unrecoverable without the phrase; it must not be weakened silently.
 */
export const RECOVERY_PHRASE_WARNING = {
  lead: "Your funds are safe ",
  emphasis: "only if you have your 24-word recovery phrase",
  tail: ". This action cannot be undone.",
} as const;

export interface ConfirmWordDialogProps {
  open: boolean;
  /** Backdrop click, Escape, and Cancel all route here. */
  onClose: () => void;
  /** e.g. `Remove Wallet 2?` — the NetworkDetail per-item title shape. */
  title: ReactNode;
  /** Bold first line of the warning card. Name what is destroyed. */
  warningHeading: ReactNode;
  /** Body of the warning card. Defaults to ResetWallet's sentence, which is
   *  the correct wording for anything protected only by a recovery phrase. */
  warningBody?: ReactNode;
  /** Extra context rendered between the warning and the field — a balance, a
   *  multisig roster warning, an active-wallet note. */
  children?: ReactNode;
  /** Failure text from the caller's submit, rendered above the buttons. */
  error?: string | null;
  /** Red confirm button label, e.g. `Remove wallet`. */
  confirmLabel: string;
  /** In-flight label, e.g. `Removing…`. */
  busyLabel: string;
  submitting?: boolean;
  /** Fires only when the typed word matches AND a submit is not already in
   *  flight. The dialog re-checks both here, not just via `disabled`. */
  onConfirm: () => void;
}

export function ConfirmWordDialog({
  open,
  onClose,
  title,
  warningHeading,
  warningBody,
  children,
  error,
  confirmLabel,
  busyLabel,
  submitting = false,
  onConfirm,
}: ConfirmWordDialogProps) {
  const [confirmInput, setConfirmInput] = useState("");

  // Clear the typed word whenever the dialog closes, so reopening it never
  // starts pre-armed. Without this a user who cancelled at the last step would
  // find the confirm button already live on the next open.
  useEffect(() => {
    if (!open) setConfirmInput("");
  }, [open]);

  const matched = confirmWordMatches(confirmInput);
  const ready = matched && !submitting;

  const handleConfirm = () => {
    // Re-checked HERE and not only through the button's `disabled`, matching
    // ResetWallet.handleConfirmReset. Enter-key and any stale re-render route
    // through this same guard.
    if (submitting) return;
    if (!confirmWordMatches(confirmInput)) return;
    onConfirm();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <>
          <Icon name="warn" size={12} /> {title}
        </>
      }
      titleAccent="var(--err)"
    >
      <div style={WARNING_CARD_STYLE}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>{warningHeading}</div>
        {warningBody ?? (
          <>
            {RECOVERY_PHRASE_WARNING.lead}
            <strong>{RECOVERY_PHRASE_WARNING.emphasis}</strong>
            {RECOVERY_PHRASE_WARNING.tail}
          </>
        )}
      </div>

      {children}

      <label style={{ display: "block" }}>
        <div style={FIELD_LABEL_STYLE}>Type {WIPE_CONFIRM_WORD} to confirm</div>
        <input
          type="text"
          value={confirmInput}
          onChange={(e) => setConfirmInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleConfirm();
          }}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          disabled={submitting}
          aria-label={`Type ${WIPE_CONFIRM_WORD} to confirm`}
          style={FIELD_STYLE}
        />
      </label>

      {error && <div style={ERROR_STYLE}>{error}</div>}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 8,
          marginTop: 6,
        }}
      >
        <button onClick={onClose} disabled={submitting} style={CANCEL_STYLE}>
          Cancel
        </button>
        <button
          onClick={handleConfirm}
          disabled={!ready}
          style={{ ...CONFIRM_STYLE, opacity: ready ? 1 : 0.45 }}
        >
          {submitting ? busyLabel : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

const WARNING_CARD_STYLE: CSSProperties = {
  padding: 14,
  borderRadius: 12,
  background: "rgba(220,80,80,0.08)",
  border: "1px solid rgba(220,80,80,0.4)",
  color: "var(--fg-100)",
  fontSize: 12.5,
  lineHeight: 1.6,
};

const FIELD_LABEL_STYLE: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 10,
  color: "var(--fg-400)",
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  marginBottom: 6,
};

const FIELD_STYLE: CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 10,
  background: "rgba(0,0,0,0.3)",
  border: "1px solid var(--fg-700)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-mono)",
  fontSize: 13,
  outline: "none",
  boxSizing: "border-box",
  letterSpacing: "0.1em",
  textTransform: "uppercase",
};

const ERROR_STYLE: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 10,
  color: "var(--err)",
  marginTop: 6,
};

const CANCEL_STYLE: CSSProperties = {
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid var(--fg-700)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-sans)",
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
};

const CONFIRM_STYLE: CSSProperties = {
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid rgba(220,80,80,0.4)",
  background: "rgba(220,80,80,0.12)",
  color: "var(--err)",
  fontFamily: "var(--f-sans)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};
