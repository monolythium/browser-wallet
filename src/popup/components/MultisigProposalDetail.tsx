// Phase 8 Commit 3 — MultisigProposalDetail.
//
// Renders one PendingProposal: action summary, who-approved /
// who-rejected, expiry countdown, and the (M of N) progress bar.
// The Approve / Reject CTAs land in Commit 4 — this component is
// rendering-only at Commit 3, with a `mode="readonly"` placeholder
// so the proposal detail page mounts cleanly even before the co-
// sign flow lands.
//
// Whitepaper §28.5 — every multisig tx must collect M signatures
// before executing. The wallet enforces M-of-N at the UI boundary;
// chain enforcement is a GAP (see shared/multisig.ts module doc).

import type { CSSProperties, ReactNode } from "react";

import { bech32mDisplay } from "../../shared/bech32m";
import {
  isExecutable,
  reconcileProposalStatus,
  type MultisigSigner,
  type PendingProposal,
} from "../../shared/multisig";
import {
  lythoshiToLythDecimal,
  parseHexQuantity,
} from "../../shared/native-amount";

export interface MultisigProposalDetailProps {
  proposal: PendingProposal;
  signers: readonly MultisigSigner[];
  threshold: number;
  /** Now-ish — passed in so the popup's animation frame controls
   *  re-renders rather than the component spinning its own timer.
   *  Defaults to Date.now() when omitted (for snapshot tests). */
  now?: number;
}

export function MultisigProposalDetail({
  proposal,
  signers,
  threshold,
  now = Date.now(),
}: MultisigProposalDetailProps) {
  const reconciledStatus = reconcileProposalStatus(proposal, threshold, now);
  const executable = isExecutable(proposal, threshold, now);
  const approvedIds = new Set(proposal.approvals.map((a) => a.signerId));
  const rejectedIds = new Set(proposal.rejections.map((r) => r.signerId));
  const remainingMs = Math.max(0, proposal.expiresAt - now);

  return (
    <div style={containerStyle}>
      <ActionSummary action={proposal.action} />
      <Progress
        approvals={proposal.approvals.length}
        rejections={proposal.rejections.length}
        threshold={threshold}
        n={signers.length}
        status={reconciledStatus}
        executable={executable}
      />
      <SignerList
        signers={signers}
        approvedIds={approvedIds}
        rejectedIds={rejectedIds}
        proposedBy={proposal.proposedBy}
      />
      <FooterMeta
        proposal={proposal}
        remainingMs={remainingMs}
        status={reconciledStatus}
      />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Action summary
// ────────────────────────────────────────────────────────────────────────────

function ActionSummary({
  action,
}: {
  action: PendingProposal["action"];
}) {
  const valueLythoshiHex =
    action.kind === "send" ? action.valueWeiHex : action.valueWeiHex ?? "0x0";
  const hasData =
    action.kind === "contract" ||
    (action.kind === "send" && action.data && action.data !== "0x");
  return (
    <div style={sectionStyle}>
      <SectionLabel>{action.kind === "send" ? "Send" : "Contract call"}</SectionLabel>
      <Row label="To">{bech32mDisplay(action.to)}</Row>
      <Row label="Value">{formatLythoshiValue(valueLythoshiHex)}</Row>
      <Row label="Chain">{action.chainIdHex}</Row>
      {hasData && action.kind === "contract" && (
        <Row label="Calldata">
          <Mono>{shortenHex(action.data)}</Mono>
        </Row>
      )}
      {action.kind === "send" && action.data && action.data !== "0x" && (
        <Row label="Calldata">
          <Mono>{shortenHex(action.data)}</Mono>
        </Row>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Approval progress
// ────────────────────────────────────────────────────────────────────────────

interface ProgressProps {
  approvals: number;
  rejections: number;
  threshold: number;
  n: number;
  status: PendingProposal["status"];
  executable: boolean;
}

function Progress({
  approvals,
  rejections,
  threshold,
  n,
  status,
  executable,
}: ProgressProps) {
  const ratio = Math.min(1, approvals / threshold);
  const tint =
    status === "rejected"
      ? "var(--err)"
      : status === "expired"
        ? "var(--fg-400)"
        : status === "executed"
          ? "var(--ok)"
          : executable
            ? "var(--ok)"
            : "rgba(124,127,255,0.6)";
  return (
    <div style={sectionStyle}>
      <SectionLabel>
        Approvals {approvals} / {threshold}{" "}
        <span style={{ color: "var(--fg-400)", fontWeight: 400 }}>(of {n})</span>
      </SectionLabel>
      <div
        style={{
          height: 6,
          borderRadius: 3,
          background: "rgba(0,0,0,0.3)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${ratio * 100}%`,
            height: "100%",
            background: tint,
            transition: "width 0.2s ease",
          }}
        />
      </div>
      {rejections > 0 && (
        <div
          style={{
            fontSize: 11,
            color: "var(--err)",
            marginTop: 4,
          }}
        >
          {rejections} rejection{rejections === 1 ? "" : "s"}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Signer list
// ────────────────────────────────────────────────────────────────────────────

interface SignerListProps {
  signers: readonly MultisigSigner[];
  approvedIds: Set<string>;
  rejectedIds: Set<string>;
  proposedBy: string;
}

function SignerList({
  signers,
  approvedIds,
  rejectedIds,
  proposedBy,
}: SignerListProps) {
  return (
    <div style={sectionStyle}>
      <SectionLabel>Signers</SectionLabel>
      {signers.map((s) => {
        const approved = approvedIds.has(s.id);
        const rejected = rejectedIds.has(s.id);
        const proposer = s.id === proposedBy;
        return (
          <div
            key={s.id}
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              padding: "4px 0",
            }}
          >
            <SignerDot approved={approved} rejected={rejected} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 12,
                  color: "var(--fg-100)",
                  display: "flex",
                  gap: 6,
                  alignItems: "center",
                }}
              >
                {s.label}
                {proposer && (
                  <span
                    style={{
                      fontFamily: "var(--f-mono)",
                      fontSize: 9.5,
                      color: "var(--fg-400)",
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                    }}
                  >
                    proposer
                  </span>
                )}
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
                title={s.address}
              >
                {bech32mDisplay(s.address)}
              </div>
            </div>
            <div
              style={{
                fontSize: 10.5,
                fontFamily: "var(--f-mono)",
                color: approved
                  ? "var(--ok)"
                  : rejected
                    ? "var(--err)"
                    : "var(--fg-500)",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
              }}
            >
              {approved ? "approved" : rejected ? "rejected" : "—"}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SignerDot({
  approved,
  rejected,
}: {
  approved: boolean;
  rejected: boolean;
}) {
  const bg = approved
    ? "var(--ok)"
    : rejected
      ? "var(--err)"
      : "var(--fg-700)";
  return (
    <div
      style={{
        width: 8,
        height: 8,
        borderRadius: 4,
        background: bg,
        flexShrink: 0,
      }}
    />
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Footer (status + expiry + tx hash)
// ────────────────────────────────────────────────────────────────────────────

interface FooterMetaProps {
  proposal: PendingProposal;
  remainingMs: number;
  status: PendingProposal["status"];
}

function FooterMeta({ proposal, remainingMs, status }: FooterMetaProps) {
  return (
    <div style={sectionStyle}>
      <SectionLabel>Status</SectionLabel>
      <div
        style={{
          fontSize: 11,
          color:
            status === "rejected"
              ? "var(--err)"
              : status === "executed"
                ? "var(--ok)"
                : "var(--fg-200)",
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          fontFamily: "var(--f-mono)",
        }}
      >
        {status}
      </div>
      {status === "pending" && (
        <Row label="Expires in">{formatRemaining(remainingMs)}</Row>
      )}
      {proposal.txHash && (
        <Row label="Tx hash">
          <Mono>{shortenHex(proposal.txHash)}</Mono>
        </Row>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Reusable bits + exported pure helpers
// ────────────────────────────────────────────────────────────────────────────

/** Human-friendly time-remaining string. Pure — exported for tests.
 *  Formats:
 *    > 1 d : "Nd Hh"
 *    > 1 h : "Hh Mm"
 *    > 1 m : "Mm"
 *    < 1 m : "<1m"
 *    < 0   : "expired"
 */
export function formatRemaining(ms: number): string {
  if (ms < 0) return "expired";
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return "<1m";
}

/** Format the compatibility `valueWeiHex` field as native LYTH. The field
 *  name is historical; for v4.1 native proposals it carries lythoshi. */
export function formatLythoshiValue(hexLythoshi: string): string {
  if (!hexLythoshi || hexLythoshi === "0x" || hexLythoshi === "0X") {
    return "0 LYTH";
  }
  const lythoshi = parseHexQuantity(hexLythoshi);
  if (lythoshi == null) return "? LYTH";
  return `${lythoshiToLythDecimal(lythoshi)} LYTH`;
}

/** Truncate a hex blob to "0xabcd…wxyz" for tight UI rows. Pure. */
export function shortenHex(hex: string | undefined): string {
  if (!hex) return "";
  if (hex.length <= 16) return hex;
  return `${hex.slice(0, 8)}…${hex.slice(-6)}`;
}

function Row({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
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

function Mono({ children }: { children: ReactNode }) {
  return (
    <span style={{ fontFamily: "var(--f-mono)", fontSize: 11 }}>{children}</span>
  );
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const sectionStyle: CSSProperties = {
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid var(--fg-700)",
  background: "rgba(0,0,0,0.18)",
};
