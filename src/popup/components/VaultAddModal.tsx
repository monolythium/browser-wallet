// Phase 5 Commit 4 — VaultAddModal. Two-mode modal driven by an
// `initialMode` prop ("fresh" | "import"); the picker decides which
// mode to enter from the dropdown footer CTAs and the modal skips the
// mode-picker screen entirely.
//
// Whitepaper §21.2.1 (PQM-1 v1) is the authority for the 24-word
// mnemonic format used in both flows. The popup never re-implements
// crypto — fresh generation routes through bgVaultAddFresh (which
// invokes the SDK's generatePqm1Mnemonic + ML-DSA-65 keygen in the
// service worker), and the import flow defers wordlist + checksum
// validation to pqm1MnemonicToMlDsa65Seed inside the SW. The popup
// only checks word count locally — same posture as the onboarding
// ImportWallet page.
//
// Password gate is conditional. The picker only renders inside the
// post-unlock chrome (Top → VaultPicker is gated by the App's
// unlocked path), so the container's MEK is normally cached and the
// modal goes straight to the label / paste step. The password step
// fires only when bgKeystoreStatus reports `unlocked: false` — which
// happens if auto-lock fires between the dropdown opening and the
// modal completing. In that race the modal calls the same
// bgKeystoreUnlock path the UnlockScreen uses (rate-limit + lockout
// counters are shared session keys at the SW).
//
// Fresh flow steps:
//   1. password (only if locked)
//   2. label  — auto-default "Vault N+1", user-editable
//   3. reveal — 24-word PQM-1 + bech32m address + backup checkbox
//
// Import flow steps:
//   1. password (only if locked)
//   2. paste   — textarea + label + Submit
//      duplicate-address rejection from the SW becomes inline
//      "This mnemonic is already imported"; the user can edit and
//      retry without losing modal state.
//
// Out of scope (per Commit 4 brief):
//   - mode picker screen (initialMode prop)
//   - mnemonic strength scoring
//   - QR scan
//   - hardware wallet
//   - per-vault color/icon

import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

import { Icon } from "../Icon";
import { bech32mDisplay } from "../../shared/bech32m";
import { Modal } from "./Modal";
import { MnemonicGrid } from "./MnemonicGrid";
import { explainImportError } from "../lib/import-error";
import {
  bgKeystoreStatus,
  bgKeystoreUnlock,
  bgVaultAddFresh,
  bgVaultAddImport,
} from "../bg";

const MAX_LABEL_LEN = 32;
const MNEMONIC_WORDS = 24;

export type VaultAddMode = "fresh" | "import";

export interface VaultAddModalProps {
  open: boolean;
  /** Which flow to skip directly into. The picker passes "fresh" for
   *  the New vault CTA and "import" for the Import existing CTA. */
  initialMode: VaultAddMode;
  /** Existing vault count, used to compute the default label
   *  `Vault ${vaultsCount + 1}`. */
  vaultsCount: number;
  /** Dismiss without committing (Cancel, backdrop click, Escape). */
  onClose: () => void;
  /** Successful add — caller refreshes the picker. */
  onComplete: () => void;
}

export function VaultAddModal({
  open,
  initialMode,
  vaultsCount,
  onClose,
  onComplete,
}: VaultAddModalProps) {
  if (!open) return null;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={initialMode === "fresh" ? "New wallet" : "Import existing"}
    >
      <VaultAddBody
        mode={initialMode}
        vaultsCount={vaultsCount}
        onClose={onClose}
        onComplete={onComplete}
      />
    </Modal>
  );
}

// ---- Body ----
//
// Split out so the step state machine can re-mount cleanly each time
// the modal opens (the parent renders <VaultAddModal open={true} ...
// /> only when active; closing the modal unmounts the body and resets
// every transient field, including the in-memory mnemonic).

interface VaultAddBodyProps {
  mode: VaultAddMode;
  vaultsCount: number;
  onClose: () => void;
  onComplete: () => void;
}

type FreshStep = "password" | "label" | "reveal";
type ImportStep = "password" | "paste";

function VaultAddBody({
  mode,
  vaultsCount,
  onClose,
  onComplete,
}: VaultAddBodyProps) {
  // Round 5 TASK 4 — the default label uses the user-facing "Wallet"
  // terminology; the keystore container still keeps the "vault" lexicon
  // internally (storage keys, function names, types).
  const defaultLabel = `Wallet ${vaultsCount + 1}`;

  // Whether the unlock-status probe has resolved. Until it does we
  // render a small "Checking…" placeholder rather than flashing a
  // password prompt and then immediately replacing it with the label
  // step (the common case is unlocked).
  const [unlockKnown, setUnlockKnown] = useState(false);
  const [needsPassword, setNeedsPassword] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await bgKeystoreStatus();
        if (cancelled) return;
        setNeedsPassword(!r.unlocked);
      } catch {
        if (cancelled) return;
        // Conservative: if the status probe fails, force the password
        // gate. The user will get a clear error if the unlock itself
        // fails too.
        setNeedsPassword(true);
      } finally {
        if (!cancelled) setUnlockKnown(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!unlockKnown) {
    return (
      <div
        style={{
          padding: "8px 4px",
          fontSize: 12,
          color: "var(--fg-300)",
          textAlign: "center",
        }}
      >
        Checking…
      </div>
    );
  }

  if (mode === "fresh") {
    return (
      <FreshFlow
        defaultLabel={defaultLabel}
        startStep={needsPassword ? "password" : "label"}
        onClose={onClose}
        onComplete={onComplete}
      />
    );
  }
  return (
    <ImportFlow
      defaultLabel={defaultLabel}
      startStep={needsPassword ? "password" : "paste"}
      onClose={onClose}
      onComplete={onComplete}
    />
  );
}

// ---- Fresh flow ----

interface FreshFlowProps {
  defaultLabel: string;
  startStep: FreshStep;
  onClose: () => void;
  onComplete: () => void;
}

function FreshFlow({
  defaultLabel,
  startStep,
  onClose,
  onComplete,
}: FreshFlowProps) {
  const [step, setStep] = useState<FreshStep>(startStep);
  const [label, setLabel] = useState(defaultLabel);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  // Wipe the in-memory mnemonic on unmount. JS can't deterministically
  // zero a string, but releasing the React reference is what we can do.
  useEffect(() => {
    return () => setMnemonic(null);
  }, []);

  const handleAuthSuccess = () => setStep("label");

  const handleGenerate = async () => {
    if (submitting) return;
    const trimmed = label.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_LABEL_LEN) {
      setError("Label must be 1–32 characters.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const r = await bgVaultAddFresh(trimmed);
      if (r.ok) {
        setMnemonic(r.mnemonic);
        setAddress(r.address);
        setStep("reveal");
        return;
      }
      setError(r.reason ?? "Could not create wallet.");
    } catch (e) {
      setError((e as Error).message ?? "Could not create wallet.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDone = () => {
    setMnemonic(null);
    setAddress(null);
    onComplete();
  };

  if (step === "password") {
    return (
      <PasswordStep
        submitLabel="Continue"
        onSuccess={handleAuthSuccess}
        onCancel={onClose}
      />
    );
  }

  if (step === "label") {
    const trimmed = label.trim();
    const isValid = trimmed.length >= 1 && trimmed.length <= MAX_LABEL_LEN;
    return (
      <div style={colStyle}>
        <div style={hintStyle}>
          A new ML-DSA-65 keypair will be derived from a fresh PQM-1
          (24-word) mnemonic. You&apos;ll see the words on the next
          screen — write them down before continuing.
        </div>
        <LabelInput
          value={label}
          onChange={setLabel}
          autoFocus
          onSubmit={() => void handleGenerate()}
          disabled={submitting}
        />
        {error && <ErrorLine>{error}</ErrorLine>}
        <FooterButtons>
          <button
            type="button"
            onClick={onClose}
            style={btnSecondary}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleGenerate()}
            disabled={submitting || !isValid}
            style={
              submitting || !isValid
                ? { ...btnPrimary, ...btnDisabled }
                : btnPrimary
            }
          >
            {submitting ? "Generating…" : "Generate"}
          </button>
        </FooterButtons>
      </div>
    );
  }

  // step === "reveal"
  if (!mnemonic || !address) {
    return null;
  }
  return (
    <div style={colStyle}>
      <div
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 10,
          color: "var(--fg-400)",
          letterSpacing: "0.14em",
          textTransform: "uppercase",
        }}
      >
        PQM-1 · {MNEMONIC_WORDS} words
      </div>
      <MnemonicGrid mnemonic={mnemonic} />
      <div
        style={{
          padding: "8px 10px",
          borderRadius: 8,
          background: "rgba(242,180,65,0.08)",
          border: "1px solid rgba(242,180,65,0.4)",
          color: "var(--fg-100)",
          fontSize: 11.5,
          lineHeight: 1.5,
        }}
      >
        Anyone with these 24 words can spend from this vault. Write
        them down on paper. Don&apos;t screenshot, don&apos;t paste
        into chat.
      </div>
      <AddressBlock label="New wallet address" addr={address} />
      <label
        style={{
          display: "flex",
          gap: 8,
          alignItems: "flex-start",
          fontSize: 11.5,
          color: "var(--fg-200)",
          cursor: "pointer",
          padding: "4px 0",
        }}
      >
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          style={{ marginTop: 2 }}
        />
        <span>I&apos;ve backed up my mnemonic phrase.</span>
      </label>
      <FooterButtons>
        <button
          type="button"
          onClick={handleDone}
          disabled={!confirmed}
          style={
            confirmed ? btnPrimary : { ...btnPrimary, ...btnDisabled }
          }
        >
          Done
        </button>
      </FooterButtons>
    </div>
  );
}

// ---- Import flow ----

interface ImportFlowProps {
  defaultLabel: string;
  startStep: ImportStep;
  onClose: () => void;
  onComplete: () => void;
}

function ImportFlow({
  defaultLabel,
  startStep,
  onClose,
  onComplete,
}: ImportFlowProps) {
  const [step, setStep] = useState<ImportStep>(startStep);
  const [label, setLabel] = useState(defaultLabel);
  const [phrase, setPhrase] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cleaned = phrase.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const wordCount = cleaned.length;
  const trimmedLabel = label.trim();
  const labelValid =
    trimmedLabel.length >= 1 && trimmedLabel.length <= MAX_LABEL_LEN;
  const wordsValid = wordCount === MNEMONIC_WORDS;
  const canSubmit = labelValid && wordsValid && !submitting;

  const handleAuthSuccess = () => setStep("paste");

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await bgVaultAddImport(cleaned.join(" "), trimmedLabel);
      if (r.ok) {
        onComplete();
        return;
      }
      const reason = r.reason ?? "Could not import wallet.";
      setError(explainImportError(reason));
    } catch (e) {
      setError((e as Error).message ?? "Could not import vault.");
    } finally {
      setSubmitting(false);
    }
  };

  if (step === "password") {
    return (
      <PasswordStep
        submitLabel="Continue"
        onSuccess={handleAuthSuccess}
        onCancel={onClose}
      />
    );
  }

  // step === "paste"
  return (
    <div style={colStyle}>
      <div style={hintStyle}>
        Paste your 24-word PQM-1 recovery phrase. Words are space-
        separated; case is normalised on import.
      </div>
      <textarea
        value={phrase}
        onChange={(e) => {
          setPhrase(e.target.value);
          if (error) setError(null);
        }}
        rows={4}
        placeholder="word1 word2 word3 …"
        autoFocus
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        disabled={submitting}
        style={{
          width: "100%",
          padding: "8px 10px",
          borderRadius: 8,
          background: "rgba(0,0,0,0.3)",
          border: "1px solid var(--fg-700)",
          color: "var(--fg-100)",
          fontFamily: "var(--f-mono)",
          fontSize: 12,
          lineHeight: 1.5,
          outline: "none",
          resize: "vertical",
          boxSizing: "border-box",
        }}
      />
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontFamily: "var(--f-mono)",
          fontSize: 10.5,
          color: wordsValid
            ? "var(--ok)"
            : wordCount === 0
              ? "var(--fg-400)"
              : "var(--warn)",
        }}
      >
        <span>
          {wordCount} / {MNEMONIC_WORDS} words
        </span>
        {wordCount > 0 && !wordsValid && (
          <span style={{ color: "var(--fg-400)" }}>
            {wordCount < MNEMONIC_WORDS ? "keep going…" : "too many"}
          </span>
        )}
      </div>
      <LabelInput
        value={label}
        onChange={setLabel}
        autoFocus={false}
        onSubmit={() => void handleSubmit()}
        disabled={submitting}
      />
      {error && <ErrorLine>{error}</ErrorLine>}
      <FooterButtons>
        <button
          type="button"
          onClick={onClose}
          style={btnSecondary}
          disabled={submitting}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={!canSubmit}
          style={canSubmit ? btnPrimary : { ...btnPrimary, ...btnDisabled }}
        >
          {submitting ? "Importing…" : "Import"}
        </button>
      </FooterButtons>
    </div>
  );
}

// ---- Password step ----
//
// Mirrors the rate-limit + lockout countdown handling from
// UnlockScreen + RevealPhrase. Successful unlock sets the container's
// MEK cache; the parent then proceeds to the next step.

interface PasswordStepProps {
  submitLabel: string;
  onSuccess: () => void;
  onCancel: () => void;
}

function PasswordStep({ submitLabel, onSuccess, onCancel }: PasswordStepProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [secondsRemaining, setSecondsRemaining] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (secondsRemaining <= 0) return;
    const t = setInterval(() => {
      setSecondsRemaining((s) => {
        const next = s - 1;
        if (next <= 0) {
          setError(null);
          return 0;
        }
        return next;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [secondsRemaining]);

  const handleSubmit = async () => {
    if (submitting || secondsRemaining > 0 || password.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await bgKeystoreUnlock(password);
      if (r.ok) {
        setPassword("");
        onSuccess();
        return;
      }
      const remaining =
        typeof r.secondsRemaining === "number" ? r.secondsRemaining : 0;
      if (r.reason === "rate_limited") {
        setError(`Too many attempts. Try again in ${remaining}s.`);
        setSecondsRemaining(remaining);
      } else if (r.reason === "wrong_password") {
        if (remaining > 0) {
          setError(`Wrong password. Locked for ${remaining}s.`);
          setSecondsRemaining(remaining);
        } else {
          setError("Wrong password.");
        }
      } else {
        setError(r.reason ?? "Unlock failed.");
      }
    } catch (e) {
      setError((e as Error).message ?? "Unlock failed.");
    } finally {
      setSubmitting(false);
    }
  };

  const disabled =
    submitting || secondsRemaining > 0 || password.length === 0;

  return (
    <div style={colStyle}>
      <div style={hintStyle}>
        Your container is locked. Enter your master password to
        continue.
      </div>
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void handleSubmit();
        }}
        autoFocus
        disabled={secondsRemaining > 0}
        placeholder="Master password"
        style={{
          width: "100%",
          padding: "8px 10px",
          borderRadius: 8,
          background: "rgba(0,0,0,0.3)",
          border: "1px solid var(--fg-700)",
          color: "var(--fg-100)",
          fontFamily: "var(--f-mono)",
          fontSize: 12,
          outline: "none",
          boxSizing: "border-box",
          opacity: secondsRemaining > 0 ? 0.5 : 1,
        }}
      />
      {error && (
        <ErrorLine>
          {secondsRemaining > 0
            ? `Too many attempts. Try again in ${secondsRemaining}s.`
            : error}
        </ErrorLine>
      )}
      <FooterButtons>
        <button type="button" onClick={onCancel} style={btnSecondary}>
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={disabled}
          style={disabled ? { ...btnPrimary, ...btnDisabled } : btnPrimary}
        >
          {submitting ? "Checking…" : submitLabel}
        </button>
      </FooterButtons>
    </div>
  );
}

// ---- Reusable bits ----

interface LabelInputProps {
  value: string;
  onChange: (next: string) => void;
  autoFocus: boolean;
  onSubmit: () => void;
  disabled: boolean;
}

function LabelInput({
  value,
  onChange,
  autoFocus,
  onSubmit,
  disabled,
}: LabelInputProps) {
  const trimmed = value.trim();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 10,
          color: "var(--fg-400)",
          letterSpacing: "0.1em",
          textTransform: "uppercase",
        }}
      >
        Label
      </div>
      <input
        type="text"
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit();
        }}
        maxLength={MAX_LABEL_LEN}
        disabled={disabled}
        style={{
          padding: "8px 10px",
          borderRadius: 8,
          border: "1px solid var(--fg-700)",
          background: "rgba(0,0,0,0.3)",
          color: "var(--fg-100)",
          fontFamily: "var(--f-sans)",
          fontSize: 12,
          outline: "none",
          opacity: disabled ? 0.5 : 1,
        }}
      />
      <div
        style={{
          fontSize: 10,
          color: "var(--fg-400)",
          fontFamily: "var(--f-mono)",
          textAlign: "right",
        }}
      >
        {trimmed.length}/{MAX_LABEL_LEN}
      </div>
    </div>
  );
}

interface AddressBlockProps {
  label: string;
  addr: string;
}

function AddressBlock({ label, addr }: AddressBlockProps) {
  const display = bech32mDisplay(addr);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 10,
          color: "var(--fg-400)",
          letterSpacing: "0.1em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      <div
        style={{
          padding: "8px 10px",
          borderRadius: 8,
          border: "1px solid var(--fg-700)",
          background: "rgba(0,0,0,0.3)",
          color: "var(--fg-100)",
          fontFamily: "var(--f-mono)",
          fontSize: 11,
          wordBreak: "break-all",
          lineHeight: 1.45,
        }}
        title={display}
      >
        {display}
      </div>
    </div>
  );
}

function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontFamily: "var(--f-mono)",
        fontSize: 11,
        color: "var(--err)",
        lineHeight: 1.4,
        display: "flex",
        alignItems: "flex-start",
        gap: 6,
      }}
    >
      <span style={{ flexShrink: 0, marginTop: 1, color: "var(--err)" }}>
        <Icon name="warn" size={11} />
      </span>
      <span>{children}</span>
    </div>
  );
}

function FooterButtons({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        justifyContent: "flex-end",
        marginTop: 4,
      }}
    >
      {children}
    </div>
  );
}

// ---- Style tokens (kept inline to match the surrounding popup) ----

const colStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const hintStyle: CSSProperties = {
  fontSize: 12,
  color: "var(--fg-300)",
  lineHeight: 1.5,
};

const btnPrimary: CSSProperties = {
  padding: "6px 12px",
  borderRadius: 8,
  border: "1px solid rgba(124,127,255,0.6)",
  background: "rgba(124,127,255,0.18)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-sans)",
  fontSize: 11.5,
  fontWeight: 600,
  cursor: "pointer",
};

const btnSecondary: CSSProperties = {
  padding: "6px 12px",
  borderRadius: 8,
  border: "1px solid var(--fg-700)",
  background: "transparent",
  color: "var(--fg-100)",
  fontFamily: "var(--f-sans)",
  fontSize: 11.5,
  cursor: "pointer",
};

const btnDisabled: CSSProperties = {
  background: "rgba(124,127,255,0.06)",
  color: "var(--fg-500)",
  cursor: "not-allowed",
};
