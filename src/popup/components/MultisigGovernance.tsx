// MultisigGovernance.
//
// Renders the current signer roster + threshold, surfaces governance
// proposals (add/remove/replace signer + change threshold), and wires
// the propose / sign / reject / execute IPCs. Same M-of-current-
// signers approval model as tx proposals (§28.5 Q75); enforced at
// the IPC boundary in the SW.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

import {
  hexToBytes,
  mlDsa65AddressFromPublicKey,
} from "@monolythium/core-sdk/crypto";

import { Icon } from "../Icon";
import { bech32mDisplay } from "../../shared/bech32m";
import {
  MAX_SIGNERS,
  defaultThreshold,
  isGovernanceExecutable,
  pickNextLocalVoter,
  reconcileGovernanceStatus,
  validateSignerInput,
  validateThreshold,
  type GovernanceAction,
  type GovernanceProposal,
  type MultisigSigner,
  type MultisigVaultMeta,
} from "../../shared/multisig";
import {
  bgMultisigExecuteGovernance,
  bgMultisigProposeGovernance,
  bgMultisigRejectGovernance,
  bgMultisigSignGovernance,
  bgVaultMultisigMeta,
} from "../bg";

const MAX_LABEL_LEN = 32;
const ML_DSA_65_PUBKEY_HEX_LEN = 2 + 1952 * 2;

export interface MultisigGovernanceProps {
  vaultId: string;
  onBack: () => void;
}

type ProposeMode =
  | { kind: "menu" }
  | { kind: "add-signer" }
  | { kind: "remove-signer" }
  | { kind: "replace-signer" }
  | { kind: "change-threshold" };

export function MultisigGovernance({ vaultId, onBack }: MultisigGovernanceProps) {
  const [meta, setMeta] = useState<MultisigVaultMeta | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [propose, setPropose] = useState<ProposeMode>({ kind: "menu" });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const r = await bgVaultMultisigMeta(vaultId);
    if (r.ok) setMeta(r.meta);
    setLoaded(true);
  }, [vaultId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const handleProposeAction = async (action: GovernanceAction) => {
    setError(null);
    try {
      const r = await bgMultisigProposeGovernance({ vaultId, action });
      if (!r.ok) {
        setError(r.reason ?? "Could not create governance proposal.");
        return;
      }
      setPropose({ kind: "menu" });
      await refresh();
    } catch (e) {
      setError((e as Error).message ?? "Could not create governance proposal.");
    }
  };

  const handleVote = async (
    proposalId: string,
    op: "sign" | "reject" | "execute",
  ) => {
    if (busyId !== null) return;
    setBusyId(proposalId);
    setError(null);
    try {
      const r =
        op === "sign"
          ? await bgMultisigSignGovernance({ vaultId, proposalId })
          : op === "reject"
            ? await bgMultisigRejectGovernance({ vaultId, proposalId })
            : await bgMultisigExecuteGovernance({ vaultId, proposalId });
      if (!r.ok) setError(r.reason ?? `${op} failed`);
    } catch (e) {
      setError((e as Error).message ?? `${op} failed`);
    } finally {
      setBusyId(null);
      await refresh();
    }
  };

  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div style={{ flex: 1, fontSize: 15, fontWeight: 600, textAlign: "center" }}>
          Multisig governance
        </div>
        <div style={{ width: 36 }} />
      </div>
      <div className="ext-body">
        {!loaded && <Hint>Loading…</Hint>}
        {loaded && meta === null && <Hint>This wallet is not a multisig wallet.</Hint>}
        {loaded && meta !== null && (
          <>
            <CurrentRoster meta={meta} />
            {propose.kind === "menu" && (
              <ProposeMenu
                meta={meta}
                onPick={(next) => {
                  setError(null);
                  setPropose(next);
                }}
              />
            )}
            {propose.kind !== "menu" && (
              <ProposeForm
                mode={propose}
                meta={meta}
                onCancel={() => setPropose({ kind: "menu" })}
                onSubmit={(action) => void handleProposeAction(action)}
                error={error}
              />
            )}
            <GovernanceQueue
              meta={meta}
              now={now}
              busyId={busyId}
              error={propose.kind === "menu" ? error : null}
              onVote={(id, op) => void handleVote(id, op)}
            />
          </>
        )}
      </div>
    </>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Current roster card
// ────────────────────────────────────────────────────────────────────────────

function CurrentRoster({ meta }: { meta: MultisigVaultMeta }) {
  return (
    <div style={cardStyle}>
      <SectionLabel>
        {meta.threshold} of {meta.signers.length} required
      </SectionLabel>
      {meta.signers.map((s, i) => (
        <div
          key={s.id}
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            padding: "4px 0",
          }}
        >
          <div style={signerNumStyle}>{i + 1}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: "var(--fg-100)" }}>{s.label}</div>
            <div
              style={{
                fontFamily: "var(--f-mono)",
                fontSize: 10,
                color: "var(--fg-400)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={s.address}
            >
              {bech32mDisplay(s.address)}
            </div>
          </div>
          <div style={roleTagStyle}>{s.role}</div>
        </div>
      ))}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Propose menu / forms
// ────────────────────────────────────────────────────────────────────────────

interface ProposeMenuProps {
  meta: MultisigVaultMeta;
  onPick: (next: ProposeMode) => void;
}

function ProposeMenu({ meta, onPick }: ProposeMenuProps) {
  const canAdd = meta.signers.length < MAX_SIGNERS;
  const canRemove = meta.signers.length > meta.threshold;
  return (
    <div style={cardStyle}>
      <SectionLabel>Propose change</SectionLabel>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 8,
        }}
      >
        <button
          type="button"
          onClick={() => onPick({ kind: "add-signer" })}
          disabled={!canAdd}
          style={canAdd ? btnSecondary : { ...btnSecondary, ...btnDisabled }}
        >
          Add signer
        </button>
        <button
          type="button"
          onClick={() => onPick({ kind: "remove-signer" })}
          disabled={!canRemove}
          style={canRemove ? btnSecondary : { ...btnSecondary, ...btnDisabled }}
        >
          Remove signer
        </button>
        <button
          type="button"
          onClick={() => onPick({ kind: "replace-signer" })}
          style={btnSecondary}
        >
          Replace signer
        </button>
        <button
          type="button"
          onClick={() => onPick({ kind: "change-threshold" })}
          style={btnSecondary}
        >
          Change threshold
        </button>
      </div>
      {!canRemove && (
        <Hint>
          Cannot remove signers while signer count equals current threshold —
          lower the threshold first.
        </Hint>
      )}
    </div>
  );
}

interface ProposeFormProps {
  mode: ProposeMode;
  meta: MultisigVaultMeta;
  onCancel: () => void;
  onSubmit: (action: GovernanceAction) => void;
  error: string | null;
}

function ProposeForm(props: ProposeFormProps) {
  switch (props.mode.kind) {
    case "add-signer":
      return <AddSignerForm {...props} />;
    case "remove-signer":
      return <RemoveSignerForm {...props} />;
    case "replace-signer":
      return <ReplaceSignerForm {...props} />;
    case "change-threshold":
      return <ChangeThresholdForm {...props} />;
    case "menu":
      return null;
  }
}

function AddSignerForm({ onCancel, onSubmit, error }: ProposeFormProps) {
  const [label, setLabel] = useState("");
  const [pubkey, setPubkey] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const handleSubmit = () => {
    setLocalError(null);
    const trimmedLabel = label.trim();
    const trimmedPubkey = pubkey.trim().toLowerCase();
    if (trimmedLabel.length === 0 || trimmedLabel.length > MAX_LABEL_LEN) {
      setLocalError("Label must be 1–32 characters.");
      return;
    }
    if (
      trimmedPubkey.length !== ML_DSA_65_PUBKEY_HEX_LEN ||
      !/^0x[0-9a-f]+$/.test(trimmedPubkey)
    ) {
      setLocalError(
        `Pubkey must be 0x + ${ML_DSA_65_PUBKEY_HEX_LEN - 2} hex chars.`,
      );
      return;
    }
    const address = pubkeyToAddress(trimmedPubkey);
    const signer = {
      label: trimmedLabel,
      address,
      pubkey: trimmedPubkey,
      role: "external" as const,
    };
    try {
      validateSignerInput(signer);
    } catch (e) {
      setLocalError((e as Error).message);
      return;
    }
    onSubmit({ kind: "add-signer", signer });
  };

  return (
    <FormCard title="Propose: add signer" onCancel={onCancel}>
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
      <ErrorOr local={localError} remote={error} />
      <FormFooter onCancel={onCancel} onSubmit={handleSubmit} submitLabel="Propose" />
    </FormCard>
  );
}

function RemoveSignerForm({ meta, onCancel, onSubmit, error }: ProposeFormProps) {
  const [signerId, setSignerId] = useState<string>("");
  const [localError, setLocalError] = useState<string | null>(null);

  const handleSubmit = () => {
    setLocalError(null);
    if (!signerId) {
      setLocalError("Pick a signer to remove.");
      return;
    }
    onSubmit({ kind: "remove-signer", signerId });
  };

  return (
    <FormCard title="Propose: remove signer" onCancel={onCancel}>
      <SignerPicker
        signers={meta.signers}
        value={signerId}
        onChange={setSignerId}
      />
      <ErrorOr local={localError} remote={error} />
      <FormFooter onCancel={onCancel} onSubmit={handleSubmit} submitLabel="Propose" />
    </FormCard>
  );
}

function ReplaceSignerForm({ meta, onCancel, onSubmit, error }: ProposeFormProps) {
  const [signerId, setSignerId] = useState<string>("");
  const [label, setLabel] = useState("");
  const [pubkey, setPubkey] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const handleSubmit = () => {
    setLocalError(null);
    if (!signerId) {
      setLocalError("Pick a signer to replace.");
      return;
    }
    const trimmedLabel = label.trim();
    const trimmedPubkey = pubkey.trim().toLowerCase();
    if (trimmedLabel.length === 0 || trimmedLabel.length > MAX_LABEL_LEN) {
      setLocalError("Label must be 1–32 characters.");
      return;
    }
    if (
      trimmedPubkey.length !== ML_DSA_65_PUBKEY_HEX_LEN ||
      !/^0x[0-9a-f]+$/.test(trimmedPubkey)
    ) {
      setLocalError(
        `Pubkey must be 0x + ${ML_DSA_65_PUBKEY_HEX_LEN - 2} hex chars.`,
      );
      return;
    }
    const replacement = {
      label: trimmedLabel,
      address: pubkeyToAddress(trimmedPubkey),
      pubkey: trimmedPubkey,
      role: "external" as const,
    };
    try {
      validateSignerInput(replacement);
    } catch (e) {
      setLocalError((e as Error).message);
      return;
    }
    onSubmit({ kind: "replace-signer", signerId, replacement });
  };

  return (
    <FormCard title="Propose: replace signer" onCancel={onCancel}>
      <SignerPicker
        signers={meta.signers}
        value={signerId}
        onChange={setSignerId}
      />
      <input
        type="text"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Replacement label"
        maxLength={MAX_LABEL_LEN}
        style={inputStyle}
      />
      <textarea
        value={pubkey}
        onChange={(e) => setPubkey(e.target.value)}
        placeholder={`Replacement pubkey (0x… ${ML_DSA_65_PUBKEY_HEX_LEN - 2} hex chars)`}
        rows={3}
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        style={{ ...inputStyle, fontFamily: "var(--f-mono)", fontSize: 10 }}
      />
      <ErrorOr local={localError} remote={error} />
      <FormFooter onCancel={onCancel} onSubmit={handleSubmit} submitLabel="Propose" />
    </FormCard>
  );
}

function ChangeThresholdForm({
  meta,
  onCancel,
  onSubmit,
  error,
}: ProposeFormProps) {
  const [threshold, setThreshold] = useState(meta.threshold);
  const [localError, setLocalError] = useState<string | null>(null);
  const n = meta.signers.length;
  const suggested = defaultThreshold(n);

  const handleSubmit = () => {
    setLocalError(null);
    try {
      validateThreshold(threshold, n);
    } catch (e) {
      setLocalError((e as Error).message);
      return;
    }
    if (threshold === meta.threshold) {
      setLocalError("Threshold is unchanged.");
      return;
    }
    onSubmit({ kind: "change-threshold", threshold });
  };

  return (
    <FormCard title="Propose: change threshold" onCancel={onCancel}>
      <Hint>
        Current threshold: {meta.threshold} of {n}. New threshold must be
        in [1, {n}].
      </Hint>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          padding: "8px 0",
        }}
      >
        <button
          type="button"
          onClick={() => setThreshold(Math.max(1, threshold - 1))}
          disabled={threshold <= 1}
          style={threshold <= 1 ? { ...btnStepper, ...btnDisabled } : btnStepper}
        >
          −
        </button>
        <div
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 18,
            color: "var(--fg-100)",
            minWidth: 60,
            textAlign: "center",
          }}
        >
          {threshold} of {n}
        </div>
        <button
          type="button"
          onClick={() => setThreshold(Math.min(n, threshold + 1))}
          disabled={threshold >= n}
          style={threshold >= n ? { ...btnStepper, ...btnDisabled } : btnStepper}
        >
          +
        </button>
      </div>
      <Hint>
        Suggested:{" "}
        <button
          type="button"
          onClick={() => setThreshold(suggested)}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--fg-200)",
            textDecoration: "underline",
            cursor: "pointer",
            fontSize: 11.5,
          }}
        >
          {suggested} of {n}
        </button>
      </Hint>
      <ErrorOr local={localError} remote={error} />
      <FormFooter onCancel={onCancel} onSubmit={handleSubmit} submitLabel="Propose" />
    </FormCard>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Governance queue
// ────────────────────────────────────────────────────────────────────────────

interface GovernanceQueueProps {
  meta: MultisigVaultMeta;
  now: number;
  busyId: string | null;
  error: string | null;
  onVote: (id: string, op: "sign" | "reject" | "execute") => void;
}

function GovernanceQueue({
  meta,
  now,
  busyId,
  error,
  onVote,
}: GovernanceQueueProps) {
  const sorted = useMemo(() => {
    return [...meta.governance].sort((a, b) => {
      const sa = reconcileGovernanceStatus(a, meta.threshold, now);
      const sb = reconcileGovernanceStatus(b, meta.threshold, now);
      const aActive = sa === "pending";
      const bActive = sb === "pending";
      if (aActive !== bActive) return aActive ? -1 : 1;
      return b.createdAt - a.createdAt;
    });
  }, [meta.governance, meta.threshold, now]);
  if (sorted.length === 0) {
    return (
      <Hint>
        No governance proposals yet.
      </Hint>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {error && (
        <div style={errorBlockStyle}>{error}</div>
      )}
      {sorted.map((g) => (
        <GovernanceCard
          key={g.id}
          proposal={g}
          meta={meta}
          now={now}
          busy={busyId === g.id}
          onVote={(op) => onVote(g.id, op)}
        />
      ))}
    </div>
  );
}

interface GovernanceCardProps {
  proposal: GovernanceProposal;
  meta: MultisigVaultMeta;
  now: number;
  busy: boolean;
  onVote: (op: "sign" | "reject" | "execute") => void;
}

function GovernanceCard({
  proposal,
  meta,
  now,
  busy,
  onVote,
}: GovernanceCardProps) {
  const status = reconcileGovernanceStatus(proposal, meta.threshold, now);
  const approvedIds = new Set(proposal.approvals.map((a) => a.signerId));
  const rejectedIds = new Set(proposal.rejections.map((r) => r.signerId));
  const nextVoter = pickNextLocalVoter(meta.signers, approvedIds, rejectedIds);
  const canVote = status === "pending" && nextVoter !== undefined;
  const executable = isGovernanceExecutable(proposal, meta.threshold, now);
  return (
    <div style={cardStyle}>
      <SectionLabel>{describeAction(proposal.action, meta.signers)}</SectionLabel>
      <Row label="Status">
        <span
          style={{
            fontFamily: "var(--f-mono)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color:
              status === "rejected"
                ? "var(--err)"
                : status === "applied"
                  ? "var(--ok)"
                  : "var(--fg-200)",
          }}
        >
          {status}
        </span>
      </Row>
      <Row label="Approvals">
        {proposal.approvals.length} / {meta.threshold}
        {proposal.rejections.length > 0 && (
          <span style={{ color: "var(--err)", marginLeft: 8 }}>
            ({proposal.rejections.length} rejected)
          </span>
        )}
      </Row>
      <div
        style={{
          display: "flex",
          gap: 8,
          justifyContent: "flex-end",
          marginTop: 6,
          flexWrap: "wrap",
        }}
      >
        {canVote && (
          <button
            type="button"
            onClick={() => onVote("reject")}
            disabled={busy}
            style={busy ? { ...btnSecondary, ...btnDisabled } : btnSecondary}
          >
            Reject
          </button>
        )}
        {canVote && (
          <button
            type="button"
            onClick={() => onVote("sign")}
            disabled={busy}
            style={busy ? { ...btnPrimary, ...btnDisabled } : btnPrimary}
          >
            Approve
          </button>
        )}
        {executable && (
          <button
            type="button"
            onClick={() => onVote("execute")}
            disabled={busy}
            style={busy ? { ...btnPrimary, ...btnDisabled } : btnPrimary}
          >
            Apply
          </button>
        )}
      </div>
    </div>
  );
}

/** Human-readable description of a governance action. Pure; exported
 *  for tests. */
export function describeAction(
  action: GovernanceAction,
  signers: readonly MultisigSigner[],
): string {
  switch (action.kind) {
    case "add-signer":
      return `Add signer · ${action.signer.label}`;
    case "remove-signer": {
      const target = signers.find((s) => s.id === action.signerId);
      return `Remove signer · ${target?.label ?? "unknown"}`;
    }
    case "replace-signer": {
      const target = signers.find((s) => s.id === action.signerId);
      return `Replace · ${target?.label ?? "unknown"} → ${action.replacement.label}`;
    }
    case "change-threshold":
      return `Change threshold → ${action.threshold}`;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Local helpers
// ────────────────────────────────────────────────────────────────────────────

/** Derive ADR-0038 address bytes from a 0x-prefixed ML-DSA-65 pubkey hex.
 *  Mirrors the helper in MultisigCreateModal; duplicated here so the
 *  governance component is self-contained. Exported for tests. */
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

function SignerPicker({
  signers,
  value,
  onChange,
}: {
  signers: readonly MultisigSigner[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {signers.map((s) => (
        <label
          key={s.id}
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            cursor: "pointer",
            padding: "6px 8px",
            borderRadius: 6,
            border: "1px solid var(--fg-700)",
            background:
              value === s.id ? "rgba(124,127,255,0.08)" : "transparent",
          }}
        >
          <input
            type="radio"
            name="signer"
            checked={value === s.id}
            onChange={() => onChange(s.id)}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: "var(--fg-100)" }}>{s.label}</div>
            <div
              style={{
                fontFamily: "var(--f-mono)",
                fontSize: 10,
                color: "var(--fg-400)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {bech32mDisplay(s.address)}
            </div>
          </div>
        </label>
      ))}
    </div>
  );
}

function FormCard({
  title,
  onCancel,
  children,
}: {
  title: string;
  onCancel: () => void;
  children: ReactNode;
}) {
  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <SectionLabel>{title}</SectionLabel>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={onCancel}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--fg-400)",
            cursor: "pointer",
            fontSize: 11,
            padding: 2,
          }}
        >
          ×
        </button>
      </div>
      {children}
    </div>
  );
}

function FormFooter({
  onCancel,
  onSubmit,
  submitLabel,
}: {
  onCancel: () => void;
  onSubmit: () => void;
  submitLabel: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        justifyContent: "flex-end",
        marginTop: 4,
      }}
    >
      <button type="button" onClick={onCancel} style={btnSecondary}>
        Cancel
      </button>
      <button type="button" onClick={onSubmit} style={btnPrimary}>
        {submitLabel}
      </button>
    </div>
  );
}

function ErrorOr({
  local,
  remote,
}: {
  local: string | null;
  remote: string | null;
}) {
  const message = local ?? remote;
  if (!message) return null;
  return <div style={errorBlockStyle}>{message}</div>;
}

function Hint({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11.5,
        color: "var(--fg-300)",
        lineHeight: 1.4,
      }}
    >
      {children}
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontFamily: "var(--f-mono)",
        fontSize: 10,
        color: "var(--fg-400)",
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        marginBottom: 4,
      }}
    >
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        fontSize: 11.5,
        padding: "2px 0",
      }}
    >
      <div style={{ width: 80, color: "var(--fg-400)", flexShrink: 0 }}>
        {label}
      </div>
      <div
        style={{
          color: "var(--fg-100)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {children}
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  padding: 12,
  borderRadius: 10,
  border: "1px solid var(--fg-700)",
  background: "rgba(0,0,0,0.18)",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const signerNumStyle: CSSProperties = {
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
  flexShrink: 0,
};

const roleTagStyle: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 9.5,
  color: "var(--fg-400)",
  textTransform: "uppercase",
  letterSpacing: "0.1em",
  flexShrink: 0,
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
  width: 32,
  height: 32,
  borderRadius: 6,
  border: "1px solid var(--fg-700)",
  background: "rgba(124,127,255,0.06)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-mono)",
  fontSize: 14,
  cursor: "pointer",
};

const errorBlockStyle: CSSProperties = {
  padding: "8px 10px",
  borderRadius: 8,
  background: "rgba(255,90,95,0.08)",
  border: "1px solid rgba(255,90,95,0.4)",
  color: "var(--err)",
  fontSize: 11.5,
};
