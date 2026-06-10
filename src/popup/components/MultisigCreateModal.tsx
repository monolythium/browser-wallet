// MultisigCreateModal.
//
// Flow:
//   1. password (only if locked)
//   2. signers   — add 1..N signer entries; each entry is either
//                  "Use this vault" (resolves a local vault's pubkey
//                  via bgVaultPubkey) or "Paste pubkey" (raw 0x..3904
//                  hex from a co-signer who lives outside this wallet)
//   3. threshold — stepper, [1, N]; default = floor(N/2)+1
//   4. review    — confirm signer roster + threshold + executor mnemonic
//                  reveal warning
//   5. reveal    — show the multisig vault's own 24-word PQM-1 mnemonic +
//                  its bech32m address + backup checkbox
//
// The "executor mnemonic" is the recovery secret for the multisig
// vault's OWN keypair — the keypair that submits the final tx on-chain.
// It is FUND-CONTROLLING: in the v1 single-executor design the chain
// verifies only the executor's single signature, so a holder of this
// mnemonic can move the vault's funds without the M-of-N approvals
// (the threshold ceremony is enforced in the wallet UI, not on-chain
// today — see shared/multisig.ts). Same stakes as any other vault
// mnemonic, so we use the same backup-checkbox gate.
//
// Whitepaper §28.5 (multisig built-in for Beta) is the binding
// requirement. mono-core ships a native M-of-N multisig, but the TS SDK
// doesn't expose its witness-assembly API yet (see shared/multisig.ts +
// Nayiem ping S6-01), so for now the policy is enforced at the wallet
// boundary; the bgVaultAddMultisig IPC just persists the roster +
// threshold for the per-vault meta block.

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

import {
  hexToBytes,
  mlDsa65AddressFromPublicKey,
} from "@monolythium/core-sdk/crypto";

import { Icon } from "../Icon";
import { bech32mDisplay } from "../../shared/bech32m";
import { Modal } from "./Modal";
import { MnemonicGrid } from "./MnemonicGrid";
import {
  MAX_SIGNERS,
  defaultThreshold,
  validateSignerInput,
  validateThreshold,
} from "../../shared/multisig";
import type { MultisigSigner } from "../../shared/multisig";
import {
  bgKeystoreStatus,
  bgKeystoreUnlock,
  bgVaultAddMultisig,
  bgVaultPubkey,
  bgVaultsList,
  type VaultSummary,
} from "../bg";

const MAX_LABEL_LEN = 32;
const ML_DSA_65_PUBKEY_HEX_LEN = 2 + 1952 * 2;

export interface MultisigCreateModalProps {
  open: boolean;
  /** Current vault count, used to compute the default vault label
   *  `Multisig N+1`. Mirrors VaultAddModal's vaultsCount prop. */
  vaultsCount: number;
  onClose: () => void;
  onComplete: () => void;
}

export function MultisigCreateModal({
  open,
  vaultsCount,
  onClose,
  onComplete,
}: MultisigCreateModalProps) {
  if (!open) return null;
  return (
    <Modal open={open} onClose={onClose} title="New multisig wallet">
      <MultisigBody
        vaultsCount={vaultsCount}
        onClose={onClose}
        onComplete={onComplete}
      />
    </Modal>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Body — step machine
// ────────────────────────────────────────────────────────────────────────────

type Step = "password" | "signers" | "threshold" | "review" | "reveal";

interface DraftSigner {
  /** Stable id used by the React list keying; replaced by the
   *  keystore-assigned signer id on commit. */
  draftId: string;
  label: string;
  source: "self" | "external";
  /** When source === "self": vaultId. */
  vaultId?: string;
  /** When source === "self": resolved pubkey from bgVaultPubkey. */
  selfPubkey?: string;
  /** When source === "self": cached address from the picker (no
   *  derivation roundtrip needed for display). */
  selfAddress?: string;
  /** When source === "external": user-pasted 0x-pubkey. */
  externalPubkey: string;
}

interface BodyProps {
  vaultsCount: number;
  onClose: () => void;
  onComplete: () => void;
}

function MultisigBody({ vaultsCount, onClose, onComplete }: BodyProps) {
  const [unlockKnown, setUnlockKnown] = useState(false);
  const [step, setStep] = useState<Step>("signers");

  const defaultLabel = `Multisig ${vaultsCount + 1}`;
  const [label, setLabel] = useState(defaultLabel);

  const [drafts, setDrafts] = useState<DraftSigner[]>([]);
  const [threshold, setThresholdState] = useState<number>(1);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  // Probe unlock state on mount; route to "password" step if locked.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await bgKeystoreStatus();
        if (cancelled) return;
        setStep(r.unlocked ? "signers" : "password");
      } catch {
        if (cancelled) return;
        setStep("password");
      } finally {
        if (!cancelled) setUnlockKnown(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-tune threshold whenever signer count changes — clamp to N
  // and snap to default when the user hasn't manually moved it.
  useEffect(() => {
    const n = drafts.length;
    if (n === 0) return;
    setThresholdState((cur) => {
      if (cur > n) return defaultThreshold(n);
      if (cur < 1) return 1;
      return cur;
    });
  }, [drafts.length]);

  // Drop the mnemonic from React state on unmount — same posture as
  // VaultAddModal's fresh flow.
  useEffect(() => {
    return () => setMnemonic(null);
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

  if (step === "password") {
    return (
      <PasswordStep
        submitLabel="Continue"
        onSuccess={() => setStep("signers")}
        onCancel={onClose}
      />
    );
  }

  if (step === "signers") {
    return (
      <SignersStep
        drafts={drafts}
        onDraftsChange={setDrafts}
        onCancel={onClose}
        onNext={() => {
          // Local validation mirroring the SW path so the user sees
          // errors before paying the IPC cost.
          try {
            const signers = draftsToSigners(drafts);
            for (const s of signers) validateSignerInput(s);
            validateThreshold(
              Math.min(threshold, signers.length || 1),
              signers.length,
            );
            setError(null);
            setStep("threshold");
          } catch (e) {
            setError((e as Error).message);
          }
        }}
        error={error}
      />
    );
  }

  if (step === "threshold") {
    const n = drafts.length;
    return (
      <ThresholdStep
        n={n}
        threshold={threshold}
        onChange={(t) => setThresholdState(t)}
        onBack={() => setStep("signers")}
        onNext={() => setStep("review")}
      />
    );
  }

  if (step === "review") {
    return (
      <ReviewStep
        defaultLabel={defaultLabel}
        label={label}
        onLabelChange={setLabel}
        drafts={drafts}
        threshold={threshold}
        submitting={submitting}
        error={error}
        onBack={() => setStep("threshold")}
        onCreate={async () => {
          if (submitting) return;
          const trimmedLabel = label.trim();
          if (
            trimmedLabel.length === 0 ||
            trimmedLabel.length > MAX_LABEL_LEN
          ) {
            setError("Label must be 1–32 characters.");
            return;
          }
          setSubmitting(true);
          setError(null);
          try {
            const signers = draftsToSigners(drafts);
            const r = await bgVaultAddMultisig({
              signers,
              threshold,
              label: trimmedLabel,
            });
            if (r.ok) {
              setMnemonic(r.mnemonic);
              setAddress(r.address);
              setStep("reveal");
              return;
            }
            setError(r.reason ?? "Could not create multisig wallet.");
          } catch (e) {
            setError((e as Error).message ?? "Could not create multisig wallet.");
          } finally {
            setSubmitting(false);
          }
        }}
      />
    );
  }

  // step === "reveal"
  if (!mnemonic || !address) return null;
  return (
    <RevealStep
      mnemonic={mnemonic}
      address={address}
      confirmed={confirmed}
      onConfirmChange={setConfirmed}
      onDone={() => {
        setMnemonic(null);
        setAddress(null);
        onComplete();
      }}
    />
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Step 2 — signers
// ────────────────────────────────────────────────────────────────────────────

interface SignersStepProps {
  drafts: DraftSigner[];
  onDraftsChange: (next: DraftSigner[]) => void;
  onCancel: () => void;
  onNext: () => void;
  error: string | null;
}

function SignersStep({
  drafts,
  onDraftsChange,
  onCancel,
  onNext,
  error,
}: SignersStepProps) {
  const [vaults, setVaults] = useState<VaultSummary[]>([]);
  const [vaultsLoaded, setVaultsLoaded] = useState(false);
  const [adding, setAdding] = useState<null | "self" | "external">(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await bgVaultsList();
        if (cancelled) return;
        if (r.ok) {
          // Only single-key vaults qualify as self-signers — multisig
          // vaults can't sign their own multisig, and including
          // another multisig as a member would create cycles.
          const eligible = (r.vaults ?? []).filter((v) => v.kind === "single");
          setVaults(eligible);
        }
      } finally {
        if (!cancelled) setVaultsLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const available = useMemo(() => {
    const usedVaultIds = new Set(
      drafts.filter((d) => d.source === "self").map((d) => d.vaultId),
    );
    return vaults.filter((v) => !usedVaultIds.has(v.id));
  }, [vaults, drafts]);

  const canAddMore = drafts.length < MAX_SIGNERS;
  const canProceed = drafts.length >= 1;

  const handleRemove = (draftId: string) => {
    onDraftsChange(drafts.filter((d) => d.draftId !== draftId));
  };

  const handleAddSelf = async (vaultId: string) => {
    const v = vaults.find((x) => x.id === vaultId);
    if (!v) return;
    const r = await bgVaultPubkey(vaultId);
    if (!r.ok) return;
    onDraftsChange([
      ...drafts,
      {
        draftId: crypto.randomUUID(),
        label: v.label,
        source: "self",
        vaultId,
        selfPubkey: r.pubkey,
        selfAddress: v.addr,
        externalPubkey: "",
      },
    ]);
    setAdding(null);
  };

  const handleAddExternal = (label: string, pubkey: string) => {
    onDraftsChange([
      ...drafts,
      {
        draftId: crypto.randomUUID(),
        label,
        source: "external",
        externalPubkey: pubkey,
      },
    ]);
    setAdding(null);
  };

  return (
    <div style={colStyle}>
      <div style={hintStyle}>
        Add 1–{MAX_SIGNERS} signers. Each signer approves transactions
        with their own ML-DSA-65 keypair. You can mix local vaults
        with externally-held co-signer pubkeys.
      </div>

      {drafts.length === 0 && (
        <div
          style={{
            padding: "8px 10px",
            border: "1px dashed var(--fg-700)",
            borderRadius: 8,
            color: "var(--fg-400)",
            fontSize: 12,
            textAlign: "center",
          }}
        >
          No signers yet.
        </div>
      )}

      {drafts.map((d, i) => (
        <SignerRow
          key={d.draftId}
          index={i + 1}
          draft={d}
          onRemove={() => handleRemove(d.draftId)}
        />
      ))}

      {canAddMore && adding === null && (
        <div
          style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
          data-testid="add-signer-buttons"
        >
          {vaultsLoaded && available.length > 0 && (
            <button
              type="button"
              onClick={() => setAdding("self")}
              style={btnSecondary}
            >
              + Use local vault
            </button>
          )}
          <button
            type="button"
            onClick={() => setAdding("external")}
            style={btnSecondary}
          >
            + Add external signer
          </button>
        </div>
      )}

      {adding === "self" && (
        <SelfSignerPicker
          options={available}
          onPick={(id) => void handleAddSelf(id)}
          onCancel={() => setAdding(null)}
        />
      )}

      {adding === "external" && (
        <ExternalSignerForm
          onCommit={handleAddExternal}
          onCancel={() => setAdding(null)}
        />
      )}

      {error && <ErrorLine>{error}</ErrorLine>}

      <FooterButtons>
        <button type="button" onClick={onCancel} style={btnSecondary}>
          Cancel
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={!canProceed}
          style={canProceed ? btnPrimary : { ...btnPrimary, ...btnDisabled }}
        >
          Next
        </button>
      </FooterButtons>
    </div>
  );
}

interface SignerRowProps {
  index: number;
  draft: DraftSigner;
  onRemove: () => void;
}

function SignerRow({ index, draft, onRemove }: SignerRowProps) {
  const addr =
    draft.source === "self"
      ? draft.selfAddress ?? ""
      : pubkeyToAddress(draft.externalPubkey);
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        alignItems: "center",
        padding: "6px 8px",
        borderRadius: 8,
        border: "1px solid var(--fg-700)",
        background: "rgba(0,0,0,0.18)",
      }}
    >
      <div
        style={{
          width: 18,
          height: 18,
          borderRadius: 9,
          background: "rgba(124,127,255,0.18)",
          color: "var(--fg-100)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 10,
          fontFamily: "var(--f-mono)",
        }}
      >
        {index}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: "var(--fg-100)" }}>{draft.label}</div>
        <div
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 10.5,
            color: "var(--fg-400)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={addr || ""}
        >
          {addr ? bech32mDisplay(addr) : ""}
        </div>
      </div>
      <div
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 9.5,
          color: "var(--fg-400)",
          textTransform: "uppercase",
          letterSpacing: "0.1em",
        }}
      >
        {draft.source === "self" ? "local" : "external"}
      </div>
      <button
        type="button"
        onClick={onRemove}
        style={{
          background: "transparent",
          border: "none",
          color: "var(--fg-400)",
          cursor: "pointer",
          fontSize: 11,
          padding: 2,
        }}
        aria-label="Remove signer"
      >
        ×
      </button>
    </div>
  );
}

interface SelfSignerPickerProps {
  options: VaultSummary[];
  onPick: (vaultId: string) => void;
  onCancel: () => void;
}

function SelfSignerPicker({
  options,
  onPick,
  onCancel,
}: SelfSignerPickerProps) {
  return (
    <div
      style={{
        padding: 8,
        borderRadius: 8,
        border: "1px solid var(--fg-700)",
        background: "rgba(0,0,0,0.18)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: "var(--fg-300)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        Pick a local vault
      </div>
      {options.map((v) => (
        <button
          key={v.id}
          type="button"
          onClick={() => onPick(v.id)}
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "6px 8px",
            background: "rgba(124,127,255,0.06)",
            border: "1px solid var(--fg-700)",
            borderRadius: 6,
            color: "var(--fg-100)",
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          <span>{v.label}</span>
          <span
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 10,
              color: "var(--fg-400)",
            }}
          >
            {bech32mDisplay(v.addr).slice(0, 14)}…
          </span>
        </button>
      ))}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button type="button" onClick={onCancel} style={btnSecondary}>
          Cancel
        </button>
      </div>
    </div>
  );
}

interface ExternalSignerFormProps {
  onCommit: (label: string, pubkey: string) => void;
  onCancel: () => void;
}

function ExternalSignerForm({ onCommit, onCancel }: ExternalSignerFormProps) {
  const [label, setLabel] = useState("");
  const [pubkey, setPubkey] = useState("");
  const [error, setError] = useState<string | null>(null);

  const trimmedLabel = label.trim();
  const trimmedPubkey = pubkey.trim();

  const handleAdd = () => {
    if (trimmedLabel.length === 0 || trimmedLabel.length > MAX_LABEL_LEN) {
      setError("Label must be 1–32 characters.");
      return;
    }
    if (
      trimmedPubkey.length !== ML_DSA_65_PUBKEY_HEX_LEN ||
      !/^0x[0-9a-fA-F]+$/.test(trimmedPubkey)
    ) {
      setError(
        `Pubkey must be 0x + ${ML_DSA_65_PUBKEY_HEX_LEN - 2} hex chars ` +
          `(${trimmedPubkey.length - 2} given).`,
      );
      return;
    }
    setError(null);
    onCommit(trimmedLabel, trimmedPubkey.toLowerCase());
  };

  return (
    <div
      style={{
        padding: 8,
        borderRadius: 8,
        border: "1px solid var(--fg-700)",
        background: "rgba(0,0,0,0.18)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: "var(--fg-300)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        External signer
      </div>
      <input
        type="text"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Label (e.g. Bob)"
        maxLength={MAX_LABEL_LEN}
        autoFocus
        style={inputStyle}
      />
      <textarea
        value={pubkey}
        onChange={(e) => setPubkey(e.target.value)}
        placeholder={`0x… (${ML_DSA_65_PUBKEY_HEX_LEN - 2} hex chars)`}
        rows={3}
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        style={{ ...inputStyle, fontFamily: "var(--f-mono)", fontSize: 10 }}
      />
      {error && <ErrorLine>{error}</ErrorLine>}
      <div
        style={{
          display: "flex",
          gap: 6,
          justifyContent: "flex-end",
        }}
      >
        <button type="button" onClick={onCancel} style={btnSecondary}>
          Cancel
        </button>
        <button type="button" onClick={handleAdd} style={btnPrimary}>
          Add
        </button>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Step 3 — threshold
// ────────────────────────────────────────────────────────────────────────────

interface ThresholdStepProps {
  n: number;
  threshold: number;
  onChange: (next: number) => void;
  onBack: () => void;
  onNext: () => void;
}

function ThresholdStep({
  n,
  threshold,
  onChange,
  onBack,
  onNext,
}: ThresholdStepProps) {
  const suggested = defaultThreshold(n);
  const isAllRequired = threshold === n;
  return (
    <div style={colStyle}>
      <div style={hintStyle}>
        How many of the {n} signers must approve each transaction?
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          justifyContent: "center",
          padding: "12px 0",
        }}
      >
        <button
          type="button"
          onClick={() => onChange(Math.max(1, threshold - 1))}
          disabled={threshold <= 1}
          style={threshold <= 1 ? { ...btnStepper, ...btnDisabled } : btnStepper}
          aria-label="Decrease threshold"
        >
          −
        </button>
        <div
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 22,
            color: "var(--fg-100)",
            minWidth: 80,
            textAlign: "center",
          }}
          data-testid="threshold-display"
        >
          {threshold} of {n}
        </div>
        <button
          type="button"
          onClick={() => onChange(Math.min(n, threshold + 1))}
          disabled={threshold >= n}
          style={threshold >= n ? { ...btnStepper, ...btnDisabled } : btnStepper}
          aria-label="Increase threshold"
        >
          +
        </button>
      </div>
      <div
        style={{
          fontSize: 11,
          color: "var(--fg-400)",
          textAlign: "center",
        }}
      >
        Suggested:{" "}
        <button
          type="button"
          onClick={() => onChange(suggested)}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--fg-200)",
            textDecoration: "underline",
            cursor: "pointer",
            fontSize: 11,
          }}
        >
          {suggested} of {n} (simple majority)
        </button>
      </div>
      {isAllRequired && (
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
          Requiring all {n} signers means losing any one signer locks
          the wallet until governance restores quorum.
        </div>
      )}
      <FooterButtons>
        <button type="button" onClick={onBack} style={btnSecondary}>
          Back
        </button>
        <button type="button" onClick={onNext} style={btnPrimary}>
          Next
        </button>
      </FooterButtons>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Step 4 — review
// ────────────────────────────────────────────────────────────────────────────

interface ReviewStepProps {
  defaultLabel: string;
  label: string;
  onLabelChange: (next: string) => void;
  drafts: DraftSigner[];
  threshold: number;
  submitting: boolean;
  error: string | null;
  onBack: () => void;
  onCreate: () => Promise<void>;
}

function ReviewStep({
  label,
  onLabelChange,
  drafts,
  threshold,
  submitting,
  error,
  onBack,
  onCreate,
}: ReviewStepProps) {
  const trimmed = label.trim();
  const isValid = trimmed.length >= 1 && trimmed.length <= MAX_LABEL_LEN;
  return (
    <div style={colStyle}>
      <div style={hintStyle}>
        Review the multisig configuration. After creation, signers can
        be added or replaced via existing-signer approval.
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={labelHintStyle}>Wallet label</div>
        <input
          type="text"
          value={label}
          onChange={(e) => onLabelChange(e.target.value)}
          maxLength={MAX_LABEL_LEN}
          disabled={submitting}
          style={inputStyle}
        />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={labelHintStyle}>
          Threshold ({threshold} of {drafts.length})
        </div>
        <div
          style={{
            ...inputStyle,
            fontFamily: "var(--f-mono)",
            fontSize: 12,
            cursor: "default",
          }}
        >
          {threshold} signer{threshold === 1 ? "" : "s"} must approve each tx
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={labelHintStyle}>Signers</div>
        {drafts.map((d, i) => {
          const addr =
            d.source === "self"
              ? d.selfAddress ?? ""
              : pubkeyToAddress(d.externalPubkey);
          return (
            <div
              key={d.draftId}
              style={{
                padding: "6px 8px",
                borderRadius: 6,
                border: "1px solid var(--fg-700)",
                background: "rgba(0,0,0,0.18)",
                display: "flex",
                gap: 8,
              }}
            >
              <span
                style={{
                  fontFamily: "var(--f-mono)",
                  color: "var(--fg-400)",
                  fontSize: 11,
                  width: 16,
                }}
              >
                {i + 1}.
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, color: "var(--fg-100)" }}>
                  {d.label}
                </div>
                <div
                  style={{
                    fontFamily: "var(--f-mono)",
                    fontSize: 10,
                    color: "var(--fg-400)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={addr || ""}
                >
                  {addr ? bech32mDisplay(addr) : ""}
                </div>
              </div>
              <div
                style={{
                  fontFamily: "var(--f-mono)",
                  fontSize: 9.5,
                  color: "var(--fg-400)",
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                }}
              >
                {d.source}
              </div>
            </div>
          );
        })}
      </div>

      <div
        style={{
          padding: "8px 10px",
          borderRadius: 8,
          background: "rgba(124,127,255,0.06)",
          border: "1px solid rgba(124,127,255,0.4)",
          color: "var(--fg-100)",
          fontSize: 11,
          lineHeight: 1.5,
        }}
      >
        The wallet will generate a fresh ML-DSA-65 keypair for the
        multisig wallet. You&apos;ll see the executor mnemonic on the
        next screen — write it down before continuing.
      </div>

      {error && <ErrorLine>{error}</ErrorLine>}

      <FooterButtons>
        <button
          type="button"
          onClick={onBack}
          style={btnSecondary}
          disabled={submitting}
        >
          Back
        </button>
        <button
          type="button"
          onClick={() => void onCreate()}
          disabled={submitting || !isValid}
          style={
            submitting || !isValid
              ? { ...btnPrimary, ...btnDisabled }
              : btnPrimary
          }
        >
          {submitting ? "Creating…" : "Create"}
        </button>
      </FooterButtons>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Step 5 — reveal
// ────────────────────────────────────────────────────────────────────────────

interface RevealStepProps {
  mnemonic: string;
  address: string;
  confirmed: boolean;
  onConfirmChange: (next: boolean) => void;
  onDone: () => void;
}

function RevealStep({
  mnemonic,
  address,
  confirmed,
  onConfirmChange,
  onDone,
}: RevealStepProps) {
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
        Executor mnemonic · PQM-1 · 24 words
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
        This 24-word phrase recovers the multisig wallet&apos;s own
        keypair — the executor that submits this wallet&apos;s
        transactions. Anyone who holds it can move this wallet&apos;s
        funds, so back it up and protect it as carefully as your
        main recovery phrase.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={labelHintStyle}>Wallet address</div>
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
        >
          {bech32mDisplay(address)}
        </div>
      </div>
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
          onChange={(e) => onConfirmChange(e.target.checked)}
          style={{ marginTop: 2 }}
        />
        <span>I&apos;ve backed up the executor mnemonic.</span>
      </label>
      <FooterButtons>
        <button
          type="button"
          onClick={onDone}
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

// ────────────────────────────────────────────────────────────────────────────
// Password step (mirrors VaultAddModal's PasswordStep)
// ────────────────────────────────────────────────────────────────────────────

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
        style={inputStyle}
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

// ────────────────────────────────────────────────────────────────────────────
// Helpers — exported for tests
// ────────────────────────────────────────────────────────────────────────────

/** A draft signer entry — the in-flight shape the modal's `signers`
 *  step builds. Exported for the modal's vitest suite so tests can
 *  construct + transform drafts without rendering React. */
export type { DraftSigner };

/** Convert a list of in-flight DraftSigner entries to the canonical
 *  MultisigSigner shape the IPC contract expects. Each draft gets a
 *  fresh crypto.randomUUID() id; addresses for external signers are
 *  derived from the pasted pubkey via ADR-0038 BLAKE3 domain+algo
 *  derivation. Throws if a self-signer's local fields are missing. */
export function draftsToSigners(drafts: DraftSigner[]): MultisigSigner[] {
  return drafts.map((d) => {
    if (d.source === "self") {
      if (!d.vaultId || !d.selfPubkey || !d.selfAddress) {
        throw new Error("self signer is missing local vault details");
      }
      return {
        id: crypto.randomUUID(),
        label: d.label.trim(),
        address: d.selfAddress,
        pubkey: d.selfPubkey,
        role: "self" as const,
        vaultId: d.vaultId,
      };
    }
    const pubkey = d.externalPubkey.trim().toLowerCase();
    return {
      id: crypto.randomUUID(),
      label: d.label.trim(),
      address: pubkeyToAddress(pubkey),
      pubkey,
      role: "external" as const,
    };
  });
}

/** Derive ADR-0038 address bytes from a 0x-prefixed ML-DSA-65 pubkey
 *  hex string. Returns "" when the input is not a well-formed pubkey
 *  (caller renders a blank address). */
export function pubkeyToAddress(pubkeyHex: string): string {
  if (
    pubkeyHex.length !== ML_DSA_65_PUBKEY_HEX_LEN ||
    !/^0x[0-9a-fA-F]+$/.test(pubkeyHex)
  ) {
    return "";
  }
  try {
    return mlDsa65AddressFromPublicKey(hexToBytes(pubkeyHex, "ML-DSA-65 public key"));
  } catch {
    return "";
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Reusable bits
// ────────────────────────────────────────────────────────────────────────────

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

const labelHintStyle: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 10,
  color: "var(--fg-400)",
  letterSpacing: "0.1em",
  textTransform: "uppercase",
};

const inputStyle: CSSProperties = {
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid var(--fg-700)",
  background: "rgba(0,0,0,0.3)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-sans)",
  fontSize: 12,
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
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

const btnStepper: CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: 8,
  border: "1px solid var(--fg-700)",
  background: "rgba(124,127,255,0.06)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-mono)",
  fontSize: 16,
  cursor: "pointer",
};
