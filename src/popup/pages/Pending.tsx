// Pending multisig proposals dashboard.
//
// Shows the proposal queue for a single multisig vault: each row is a
// MultisigProposalDetail card plus Sign / Reject / Execute CTAs. The
// Execute path uses the multisig vault's own keypair to broadcast the
// underlying tx — the SW handles the active-vault swap + restore so
// the user's "looking at" state survives the round-trip.

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";

import { Icon } from "../Icon";
import { MultisigProposalDetail } from "../components/MultisigProposalDetail";
import {
  isExecutable,
  pickNextLocalVoter,
  type MultisigVaultMeta,
  type PendingProposal,
} from "../../shared/multisig";
import {
  bgMultisigExecute,
  bgMultisigExportProposal,
  bgMultisigImportProposal,
  bgMultisigReject,
  bgMultisigSign,
  bgVaultMultisigMeta,
} from "../bg";
import { multisigExecuteKeyParams, nextSendKey, type SendKeyState } from "../send-key";
import {
  submitThrowFailure,
  verbatimFailure,
  type SubmitFailure,
} from "../submit-failure";

export interface PendingProps {
  /** The multisig vault whose proposal queue this page renders. */
  vaultId: string;
  onBack: () => void;
}

type SortBucket = "pending" | "terminal";

export function Pending({ vaultId, onBack }: PendingProps) {
  const [meta, setMeta] = useState<MultisigVaultMeta | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<SubmitFailure | null>(null);
  // The key in flight for the CURRENT execute, and the proposal it was minted
  // against. Execute is the only op here that moves funds; sign and reject write
  // local metadata and never reach a submit.
  const [sendKey, setSendKey] = useState<SendKeyState>(null);
  // Which proposal's EXECUTE produced the error on screen, if any.
  //
  // Without this, an export or sign failure occurring while an execute key is
  // still held would render a "Try again" button that EXECUTES the proposal —
  // an affordance describing one failure and performing a different, funds-
  // moving operation. Cleared at the start of every action.
  const [failedExecuteId, setFailedExecuteId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [exportBlob, setExportBlob] = useState<{
    id: string;
    blob: string;
  } | null>(null);

  const refresh = useCallback(async () => {
    const r = await bgVaultMultisigMeta(vaultId);
    if (r.ok) setMeta(r.meta);
    setLoaded(true);
  }, [vaultId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Tick once a minute so expiry countdowns refresh without churn.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  // `opts.retry` is a PARAMETER rather than state: the Try-again button calls
  // straight back into this, and a `setState` immediately before a synchronous
  // call is still unapplied when the handler reads it — which would silently
  // mint a fresh key and defeat the mechanism.
  const handleAction = async (
    proposalId: string,
    op: "sign" | "reject" | "execute",
    opts?: { retry?: boolean },
  ) => {
    if (busyId !== null) return;
    setBusyId(proposalId);
    setError(null);
    setFailedExecuteId(null);
    try {
      if (op === "sign" || op === "reject") {
        // Local metadata only — no submit, so no key.
        const r =
          op === "sign"
            ? await bgMultisigSign({ vaultId, proposalId })
            : await bgMultisigReject({ vaultId, proposalId });
        if (!r.ok) setError(verbatimFailure(r.reason, `${op} failed`));
        return;
      }
      const keyParams = multisigExecuteKeyParams(vaultId, proposalId);
      const keyDecision = nextSendKey(
        sendKey,
        opts?.retry === true ? "retry" : "submit",
        keyParams,
        () => crypto.randomUUID(),
      );
      setSendKey(keyDecision.next);
      const r = await bgMultisigExecute({
        vaultId,
        proposalId,
        ...(keyDecision.use !== null
          ? { idempotencyKey: keyDecision.use }
          : {}),
      });
      if (!r.ok) {
        setError(verbatimFailure(r.reason, "execute failed"));
        setFailedExecuteId(proposalId);
      } else {
        // Released, so a genuine later execute of another proposal is
        // independent rather than replaying this one.
        setSendKey(null);
      }
    } catch (e) {
      // The call THREW, so nothing replied. `submitThrowFailure` separates a
      // chain refusal from an MV3 channel drop, where the transaction may
      // already have been broadcast — the one case where a retry can spend
      // twice, and the reason the key above matters most here.
      setError(submitThrowFailure(e));
      if (op === "execute") setFailedExecuteId(proposalId);
    } finally {
      setBusyId(null);
      await refresh();
    }
  };

  const handleExport = async (proposalId: string) => {
    setError(null);
    try {
      const r = await bgMultisigExportProposal({
        vaultId,
        proposalId,
        kind: "tx",
      });
      if (r.ok) {
        setExportBlob({ id: proposalId, blob: r.blob });
      } else {
        setError(verbatimFailure(r.reason, "export failed"));
      }
    } catch (e) {
      setError(submitThrowFailure(e));
    }
  };

  const handleImport = async (blob: string) => {
    setError(null);
    try {
      const r = await bgMultisigImportProposal({ vaultId, blob });
      if (!r.ok) {
        setError(verbatimFailure(r.reason, "import failed"));
        return false;
      }
      setImportOpen(false);
      await refresh();
      return true;
    } catch (e) {
      setError(submitThrowFailure(e));
      return false;
    }
  };

  // The proposal a Try-again would execute, or null for no affordance. Three
  // conditions, all required:
  //   - the error on screen came from an EXECUTE (not a sign/export/import),
  //   - a key is still held, so the retry actually replays rather than minting,
  //   - the key was minted against a proposal STILL in the list.
  // The last is checked by the same params comparison `nextSendKey` makes, so a
  // key that no longer matches anything offers nothing rather than retrying the
  // wrong proposal.
  const retryTargetId =
    failedExecuteId === null || sendKey === null
      ? null
      : (meta?.proposals.find(
          (p) =>
            p.id === failedExecuteId &&
            multisigExecuteKeyParams(vaultId, p.id) === sendKey.params,
        )?.id ?? null);

  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div style={{ flex: 1, fontSize: 15, fontWeight: 600, textAlign: "center" }}>
          Pending proposals
        </div>
        <div style={{ width: 36 }} />
      </div>
      <div className="ext-body">
        {loaded && meta !== null && (
          <div
            style={{
              display: "flex",
              gap: 8,
              justifyContent: "flex-end",
              marginBottom: 4,
            }}
          >
            <button
              type="button"
              onClick={() => setImportOpen(true)}
              style={btnSecondary}
            >
              Import shared
            </button>
          </div>
        )}
        {!loaded && (
          <div style={hintStyle} data-testid="pending-loading">
            Loading…
          </div>
        )}
        {loaded && meta === null && (
          <div style={hintStyle}>This wallet is not a multisig wallet.</div>
        )}
        {loaded && meta !== null && meta.proposals.length === 0 && (
          <div style={hintStyle}>No proposals yet.</div>
        )}
        {loaded && meta !== null && meta.proposals.length > 0 && (
          <ProposalList
            meta={meta}
            now={now}
            busyId={busyId}
            error={error}
            onAction={(id, op) => void handleAction(id, op)}
            onExport={(id) => void handleExport(id)}
            // Only an execute is retryable through the mechanism, and only while
            // a key is held — after a popup restart `sendKey` is null, so this
            // is absent and the failure renders without an affordance the
            // mechanism could not honour.
            onRetryExecute={
              retryTargetId !== null
                ? (id: string) => void handleAction(id, "execute", { retry: true })
                : undefined
            }
            retryTargetId={retryTargetId}
          />
        )}
        {importOpen && (
          <ImportBlobModal
            onCancel={() => setImportOpen(false)}
            onImport={async (blob) => handleImport(blob)}
            error={error}
          />
        )}
        {exportBlob !== null && (
          <ExportBlobModal
            blob={exportBlob.blob}
            onClose={() => setExportBlob(null)}
          />
        )}
      </div>
    </>
  );
}

interface ExportBlobModalProps {
  blob: string;
  onClose: () => void;
}

function ExportBlobModal({ blob, onClose }: ExportBlobModalProps) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(blob);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard may be unavailable in some embed contexts; ignore */
    }
  };
  return (
    <div style={overlayStyle} onClick={onClose}>
      <div
        style={modalStyle}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 10,
            color: "var(--fg-400)",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
          }}
        >
          Shared proposal blob
        </div>
        <div
          style={{
            fontSize: 11.5,
            color: "var(--fg-300)",
            lineHeight: 1.4,
          }}
        >
          Send this to your co-signers — they paste it into Import shared
          on their wallet to add signatures. It contains this transaction's
          details, so share it only with them.
        </div>
        <textarea
          readOnly
          value={blob}
          rows={6}
          style={{
            width: "100%",
            padding: "8px 10px",
            borderRadius: 8,
            background: "rgba(0,0,0,0.3)",
            border: "1px solid var(--fg-700)",
            color: "var(--fg-100)",
            fontFamily: "var(--f-mono)",
            fontSize: 10,
            outline: "none",
            resize: "vertical",
            boxSizing: "border-box",
          }}
        />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" onClick={handleCopy} style={btnSecondary}>
            {copied ? "Copied" : "Copy"}
          </button>
          <button type="button" onClick={onClose} style={btnPrimary}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

interface ImportBlobModalProps {
  onCancel: () => void;
  onImport: (blob: string) => Promise<boolean>;
  error: SubmitFailure | null;
}

function ImportBlobModal({ onCancel, onImport, error }: ImportBlobModalProps) {
  const [blob, setBlob] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const handleSubmit = async () => {
    if (submitting) return;
    setSubmitting(true);
    await onImport(blob.trim());
    setSubmitting(false);
  };
  return (
    <div style={overlayStyle} onClick={onCancel}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <div
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 10,
            color: "var(--fg-400)",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
          }}
        >
          Paste shared blob
        </div>
        <div
          style={{
            fontSize: 11.5,
            color: "var(--fg-300)",
            lineHeight: 1.4,
          }}
        >
          Paste a proposal blob from another signer. Signatures will be
          verified against the local signer roster before merging.
        </div>
        <textarea
          value={blob}
          onChange={(e) => setBlob(e.target.value)}
          rows={6}
          autoFocus
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          style={{
            width: "100%",
            padding: "8px 10px",
            borderRadius: 8,
            background: "rgba(0,0,0,0.3)",
            border: "1px solid var(--fg-700)",
            color: "var(--fg-100)",
            fontFamily: "var(--f-mono)",
            fontSize: 10,
            outline: "none",
            resize: "vertical",
            boxSizing: "border-box",
          }}
        />
        {error && <FailureBox failure={error} />}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={onCancel}
            style={btnSecondary}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            style={
              submitting || blob.trim().length === 0
                ? { ...btnPrimary, ...btnDisabled }
                : btnPrimary
            }
            disabled={submitting || blob.trim().length === 0}
          >
            {submitting ? "Importing…" : "Import"}
          </button>
        </div>
      </div>
    </div>
  );
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.5)",
  zIndex: 1000,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 12,
};

const modalStyle: CSSProperties = {
  background: "var(--ink-100, #15161a)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 12,
  padding: 16,
  maxWidth: 360,
  width: "100%",
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

/** The page's existing error box, given the two-line shape `SubmitFailure` uses
 *  (optional bold lead + detail). A `{ ok: false }` reply has no headline and
 *  renders exactly as it did before; a classified throw adds one. */
function FailureBox({
  failure,
  onRetry,
}: {
  failure: SubmitFailure;
  /** Adds the retry affordance — the same "Try again" control the other
   *  converted surfaces use. Its press is what tells the mechanism this is a
   *  retry of the attempt described above, rather than a fresh confirmation it
   *  cannot distinguish. */
  onRetry?: () => void;
}) {
  return (
    <div
      style={{
        padding: "8px 10px",
        borderRadius: 8,
        background: "rgba(255,90,95,0.08)",
        border: "1px solid rgba(255,90,95,0.4)",
        color: "var(--err)",
        fontSize: 11.5,
      }}
    >
      {failure.headline !== null && (
        <div style={{ fontWeight: 600, marginBottom: 3 }}>{failure.headline}</div>
      )}
      {failure.body}
      {onRetry !== undefined && (
        <button
          onClick={onRetry}
          className="ext-act prim-soft"
          style={{ marginTop: 8, padding: 8, width: "100%" }}
        >
          Try again
        </button>
      )}
    </div>
  );
}

interface ProposalListProps {
  meta: MultisigVaultMeta;
  now: number;
  busyId: string | null;
  error: SubmitFailure | null;
  onAction: (id: string, op: "sign" | "reject" | "execute") => void;
  onExport: (id: string) => void;
  /** Present only while a key is held for an execute that failed. */
  onRetryExecute?: ((id: string) => void) | undefined;
  /** The proposal that key belongs to, or null when it matches none. */
  retryTargetId?: string | null;
}

function ProposalList({
  meta,
  now,
  busyId,
  error,
  onAction,
  onExport,
  onRetryExecute,
  retryTargetId,
}: ProposalListProps) {
  const sorted = [...meta.proposals].sort((a, b) => {
    const ba = bucket(a, meta.threshold, now);
    const bb = bucket(b, meta.threshold, now);
    if (ba !== bb) return ba === "pending" ? -1 : 1;
    // Within the same bucket, newest first.
    return b.createdAt - a.createdAt;
  });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {error && (
        <FailureBox
          failure={error}
          {...(onRetryExecute !== undefined && retryTargetId !== null && retryTargetId !== undefined
            ? { onRetry: () => onRetryExecute(retryTargetId) }
            : {})}
        />
      )}
      {sorted.map((p) => (
        <ProposalCard
          key={p.id}
          proposal={p}
          meta={meta}
          now={now}
          busy={busyId === p.id}
          onAction={(op) => onAction(p.id, op)}
          onExport={() => onExport(p.id)}
        />
      ))}
    </div>
  );
}

interface ProposalCardProps {
  proposal: PendingProposal;
  meta: MultisigVaultMeta;
  now: number;
  busy: boolean;
  onAction: (op: "sign" | "reject" | "execute") => void;
  onExport: () => void;
}

function ProposalCard({
  proposal,
  meta,
  now,
  busy,
  onAction,
  onExport,
}: ProposalCardProps) {
  const approvedIds = new Set(proposal.approvals.map((a) => a.signerId));
  const rejectedIds = new Set(proposal.rejections.map((r) => r.signerId));
  const nextVoter = pickNextLocalVoter(meta.signers, approvedIds, rejectedIds);
  const canVote = proposal.status === "pending" && nextVoter !== undefined;
  const executable = isExecutable(proposal, meta.threshold, now);
  return (
    <div style={cardStyle}>
      <MultisigProposalDetail
        proposal={proposal}
        signers={meta.signers}
        threshold={meta.threshold}
        now={now}
      />
      <div
        style={{
          display: "flex",
          gap: 8,
          justifyContent: "flex-end",
          marginTop: 6,
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          onClick={onExport}
          disabled={busy}
          style={busy ? { ...btnSecondary, ...btnDisabled } : btnSecondary}
          data-testid={`export-${proposal.id}`}
        >
          Export
        </button>
        {canVote && (
          <button
            type="button"
            onClick={() => onAction("reject")}
            disabled={busy}
            style={busy ? { ...btnSecondary, ...btnDisabled } : btnSecondary}
            data-testid={`reject-${proposal.id}`}
          >
            Reject
          </button>
        )}
        {canVote && (
          <button
            type="button"
            onClick={() => onAction("sign")}
            disabled={busy}
            style={busy ? { ...btnPrimary, ...btnDisabled } : btnPrimary}
            data-testid={`sign-${proposal.id}`}
          >
            Approve
          </button>
        )}
        {executable && (
          <button
            type="button"
            onClick={() => onAction("execute")}
            disabled={busy}
            style={busy ? { ...btnPrimary, ...btnDisabled } : btnPrimary}
            data-testid={`execute-${proposal.id}`}
          >
            Execute
          </button>
        )}
      </div>
    </div>
  );
}

/** Pure bucket — used by the list sort. Exported for tests. */
export function bucket(
  proposal: PendingProposal,
  threshold: number,
  now: number,
): SortBucket {
  if (proposal.status !== "pending") return "terminal";
  if (proposal.expiresAt <= now) return "terminal";
  if (proposal.rejections.length >= threshold) return "terminal";
  return "pending";
}

const cardStyle: CSSProperties = {
  padding: 12,
  borderRadius: 10,
  border: "1px solid var(--fg-700)",
  background: "rgba(0,0,0,0.18)",
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const hintStyle: CSSProperties = {
  fontSize: 12,
  color: "var(--fg-300)",
  textAlign: "center",
  padding: "20px 8px",
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
