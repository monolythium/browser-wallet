// Phase 8 Commit 4 — Pending multisig proposals dashboard.
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
  bgMultisigReject,
  bgMultisigSign,
  bgVaultMultisigMeta,
} from "../bg";

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
  const [error, setError] = useState<string | null>(null);

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

  const handleAction = async (
    proposalId: string,
    op: "sign" | "reject" | "execute",
  ) => {
    if (busyId !== null) return;
    setBusyId(proposalId);
    setError(null);
    try {
      const r =
        op === "sign"
          ? await bgMultisigSign({ vaultId, proposalId })
          : op === "reject"
            ? await bgMultisigReject({ vaultId, proposalId })
            : await bgMultisigExecute({ vaultId, proposalId });
      if (!r.ok) {
        setError(r.reason ?? `${op} failed`);
      }
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
        <div style={{ flex: 1, fontSize: 13, fontWeight: 600, textAlign: "center" }}>
          Pending proposals
        </div>
        <div style={{ width: 28 }} />
      </div>
      <div className="ext-body">
        {!loaded && (
          <div style={hintStyle} data-testid="pending-loading">
            Loading…
          </div>
        )}
        {loaded && meta === null && (
          <div style={hintStyle}>This vault is not a multisig vault.</div>
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
          />
        )}
      </div>
    </>
  );
}

interface ProposalListProps {
  meta: MultisigVaultMeta;
  now: number;
  busyId: string | null;
  error: string | null;
  onAction: (id: string, op: "sign" | "reject" | "execute") => void;
}

function ProposalList({ meta, now, busyId, error, onAction }: ProposalListProps) {
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
          {error}
        </div>
      )}
      {sorted.map((p) => (
        <ProposalCard
          key={p.id}
          proposal={p}
          meta={meta}
          now={now}
          busy={busyId === p.id}
          onAction={(op) => onAction(p.id, op)}
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
}

function ProposalCard({
  proposal,
  meta,
  now,
  busy,
  onAction,
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
