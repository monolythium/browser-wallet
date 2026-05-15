// Phase 7 — Stake page. Top-level orchestrator for the cluster
// directory → form → preview → submitting → success | error flow.
//
// Replaces the legacy placeholder Stake exported from components.tsx
// (which was a static four-button strategy mock with no chain wiring).
// AutovoteSelector + the four-button §23.9 path lands in Commit 3 as
// an alternative entry into the same submit step.
//
// Chain wiring: the form's Continue → preview → Confirm flow encodes a
// `delegate(uint256,uint256)` calldata via shared/staking-tx.ts and
// submits through the existing `bgWalletSendTx` IPC. The delegation
// precompile (`0x000000000000000000000000000000000000100A`) is
// code-complete in mono-core but verified inactive on Sprintnet at
// Phase 7 phase-start — the wallet surfaces the typed error the chain
// returns when the gate refuses the call. Once activated, the same
// flow goes live with no UI change.

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Icon } from "../Icon";
import { ClusterPicker } from "../components/ClusterPicker";
import { StakeForm } from "../components/StakeForm";
import {
  bgStakingClusterDirectory,
  bgStakingDelegationCap,
  bgStakingDelegations,
  bgWalletBalance,
  bgWalletSendTx,
  type ClusterDirectoryEntry,
  type DelegationsView,
} from "../bg";
import type { Account } from "../demo-data";
import {
  DELEGATION_PRECOMPILE,
  encodeDelegate,
  lythAmountToBps,
} from "../../shared/staking-tx";
import { MOCK_CLUSTER_APR_BPS } from "../../shared/staking";

type Step = "pick" | "form" | "preview" | "submitting" | "success" | "error";

interface StakeProps {
  account: Account;
  /** Active chain id (hex). Submitter routes through `bgWalletSendTx`
   *  with this id so the SW knows to take the ML-DSA-65 envelope path
   *  on Sprintnet. */
  chainId: string;
  onBack: () => void;
}

export function Stake({ account, chainId, onBack }: StakeProps) {
  const [step, setStep] = useState<Step>("pick");

  // Cluster directory state.
  const [clusters, setClusters] = useState<ClusterDirectoryEntry[]>([]);
  const [clustersMock, setClustersMock] = useState(false);
  const [clustersError, setClustersError] = useState<string | null>(null);

  // Delegation context state.
  const [delegations, setDelegations] = useState<DelegationsView | null>(null);
  const [capBps, setCapBps] = useState<number | null>(null);
  const [balanceWei, setBalanceWei] = useState<bigint | null>(null);

  // Selection + form state.
  const [selectedClusterId, setSelectedClusterId] = useState<number | null>(null);
  const [amountStr, setAmountStr] = useState("");

  // Submission state.
  const [txHash, setTxHash] = useState<string | null>(null);
  const [hashCopied, setHashCopied] = useState(false);
  const [submitError, setSubmitError] = useState<{
    message: string;
    code: number | null;
    method: string | null;
    via: string | null;
  } | null>(null);

  // Load the cluster directory on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await bgStakingClusterDirectory();
        if (cancelled || !r.ok) {
          if (!cancelled && !r.ok) setClustersError(r.reason);
          return;
        }
        setClusters(r.data.clusters.slice());
        setClustersMock(r.via === "mock");
      } catch (e) {
        if (cancelled) return;
        setClustersError((e as Error).message ?? "directory fetch failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load active delegations + cap when the account changes.
  useEffect(() => {
    if (!account.addr.startsWith("0x")) return;
    let cancelled = false;
    void (async () => {
      const [delR, capR, balR] = await Promise.all([
        bgStakingDelegations(account.addr),
        bgStakingDelegationCap(),
        bgWalletBalance(account.addr, chainId),
      ]);
      if (cancelled) return;
      if (delR.ok) setDelegations(delR.data);
      if (capR.ok) setCapBps(capR.data.capBps);
      if (balR.ok) {
        try {
          setBalanceWei(BigInt(balR.balanceHex));
        } catch {
          // malformed hex — render with null
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account.addr, chainId]);

  // Existing weight in the selected cluster.
  const existingWeightBps = useMemo(() => {
    if (selectedClusterId === null || delegations === null) return 0;
    return delegations.rows.find((r) => r.cluster === selectedClusterId)?.weightBps ?? 0;
  }, [selectedClusterId, delegations]);

  const selectedCluster = useMemo(
    () =>
      selectedClusterId === null
        ? null
        : (clusters.find((c) => c.clusterId === selectedClusterId) ?? null),
    [selectedClusterId, clusters],
  );

  // Submission. Encodes `delegate(uint256,uint256)` calldata and routes
  // through bgWalletSendTx; the SW wraps it into the ML-DSA-65 envelope
  // path for Sprintnet.
  const handleConfirm = async () => {
    if (selectedCluster === null || balanceWei === null) return;
    setStep("submitting");
    setSubmitError(null);
    setTxHash(null);
    try {
      // Parse the amount once.
      const amountWei = parseLythAmount(amountStr);
      if (amountWei === null) {
        setSubmitError({
          message: "invalid amount",
          code: null,
          method: null,
          via: null,
        });
        setStep("error");
        return;
      }
      const addBps = lythAmountToBps(amountWei, balanceWei);
      const data = encodeDelegate(selectedCluster.clusterId, addBps);
      const r = await bgWalletSendTx({
        to: DELEGATION_PRECOMPILE,
        valueWeiHex: "0x0",
        chainIdHex: chainId,
        data,
        // The delegation precompile's gas budget isn't measured yet
        // (chain GAP — needs Nayiem). Use a generous overhead-aware
        // estimate; once the chain side activates, the SW's
        // `wallet-fee-suggestion` covers the per-method limit.
        gasLimitHex: "0x186A0", // 100000
      });
      if (r.ok) {
        setTxHash(r.result.txHash);
        setStep("success");
      } else {
        setSubmitError({
          message: r.reason ?? "delegation rejected",
          code: typeof r.code === "number" ? r.code : null,
          method: typeof r.method === "string" ? r.method : null,
          via: typeof r.via === "string" ? r.via : null,
        });
        setStep("error");
      }
    } catch (e) {
      setSubmitError({
        message: (e as Error).message ?? "delegation failed",
        code: null,
        method: null,
        via: null,
      });
      setStep("error");
    }
  };

  const handleCopyHash = async () => {
    if (txHash === null) return;
    try {
      await navigator.clipboard.writeText(txHash);
      setHashCopied(true);
      setTimeout(() => setHashCopied(false), 2000);
    } catch {
      // clipboard write can fail in iframes; silent
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div
          style={{ flex: 1, fontSize: 13, fontWeight: 600, textAlign: "center" }}
        >
          {step === "pick"
            ? "Stake"
            : step === "form"
              ? "Stake — amount"
              : step === "preview"
                ? "Review delegation"
                : step === "submitting"
                  ? "Submitting…"
                  : step === "success"
                    ? "Delegated"
                    : "Error"}
        </div>
        <div style={{ width: 28 }} />
      </div>

      <div className="ext-body">
        {step === "pick" && (
          <>
            <SummaryBanner delegations={delegations} balanceWei={balanceWei} />
            {clustersError !== null ? (
              <div style={errBanner}>{clustersError}</div>
            ) : clusters.length === 0 ? (
              <div
                style={{
                  padding: 18,
                  textAlign: "center",
                  fontSize: 12,
                  color: "var(--fg-400)",
                  fontFamily: "var(--f-mono)",
                }}
              >
                Loading cluster directory…
              </div>
            ) : (
              <ClusterPicker
                clusters={clusters}
                selectedClusterId={selectedClusterId}
                isMock={clustersMock}
                onSelect={(id) => {
                  setSelectedClusterId(id);
                  setStep("form");
                }}
              />
            )}
          </>
        )}

        {step === "form" && selectedCluster !== null && (
          <StakeForm
            cluster={selectedCluster}
            amountStr={amountStr}
            onAmountChange={setAmountStr}
            balanceWei={balanceWei}
            existingWeightBps={existingWeightBps}
            capBps={capBps}
            onContinue={() => setStep("preview")}
            onBack={() => setStep("pick")}
          />
        )}

        {step === "preview" && selectedCluster !== null && (
          <PreviewView
            cluster={selectedCluster}
            amountStr={amountStr}
            balanceWei={balanceWei}
            existingWeightBps={existingWeightBps}
            onConfirm={() => void handleConfirm()}
            onBack={() => setStep("form")}
          />
        )}

        {step === "submitting" && <SubmittingView />}

        {step === "success" && txHash !== null && (
          <SuccessView
            txHash={txHash}
            copied={hashCopied}
            onCopy={() => void handleCopyHash()}
            onDone={onBack}
          />
        )}

        {step === "error" && submitError !== null && (
          <ErrorView
            error={submitError}
            onRetry={() => {
              setSubmitError(null);
              setStep("form");
            }}
            onCancel={onBack}
          />
        )}
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary banner — shown on the picker step
// ─────────────────────────────────────────────────────────────────────────────

interface SummaryBannerProps {
  delegations: DelegationsView | null;
  balanceWei: bigint | null;
}

function SummaryBanner({ delegations, balanceWei }: SummaryBannerProps) {
  const stakedBps = delegations?.totalBps ?? 0;
  const stakedWei =
    balanceWei !== null && stakedBps > 0
      ? (balanceWei * BigInt(stakedBps)) / 10_000n
      : 0n;
  const liquidWei = balanceWei !== null ? balanceWei - stakedWei : null;
  return (
    <div className="ext-card" style={{ padding: 12, marginBottom: 4 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 12,
          fontSize: 11.5,
        }}
      >
        <KvStack
          label="Liquid"
          value={liquidWei === null ? "—" : `${formatWei(liquidWei)} LYTH`}
          tone="var(--fg-100)"
        />
        <KvStack
          label="Staked"
          value={
            stakedWei === 0n && balanceWei !== null
              ? "0 LYTH"
              : balanceWei === null
                ? "—"
                : `${formatWei(stakedWei)} LYTH (${(stakedBps / 100).toFixed(2)}%)`
          }
          tone="var(--gold)"
        />
      </div>
    </div>
  );
}

function KvStack({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: string;
}) {
  return (
    <div>
      <div
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 9.5,
          color: "var(--fg-500)",
          letterSpacing: "0.1em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 13,
          fontWeight: 600,
          color: tone,
          marginTop: 2,
        }}
      >
        {value}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-step renders
// ─────────────────────────────────────────────────────────────────────────────

interface PreviewViewProps {
  cluster: ClusterDirectoryEntry;
  amountStr: string;
  balanceWei: bigint | null;
  existingWeightBps: number;
  onConfirm: () => void;
  onBack: () => void;
}

function PreviewView({
  cluster,
  amountStr,
  balanceWei,
  existingWeightBps,
  onConfirm,
  onBack,
}: PreviewViewProps) {
  const amountWei = parseLythAmount(amountStr);
  const aprBps = MOCK_CLUSTER_APR_BPS[cluster.clusterId] ?? null;
  const addBps =
    amountWei !== null && balanceWei !== null && balanceWei > 0n
      ? lythAmountToBps(amountWei, balanceWei)
      : 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="ext-card" style={{ padding: 14 }}>
        <Row k="Cluster" v={cluster.name ?? `cluster-${cluster.clusterId}`} />
        <Row k="Cluster id" v={`#${cluster.clusterId}`} />
        <Row
          k="Amount"
          v={`${amountStr} LYTH`}
          tone="var(--gold)"
        />
        <Row k="Added weight" v={`${(addBps / 100).toFixed(2)}%`} />
        <Row
          k="Total weight after"
          v={`${((existingWeightBps + addBps) / 100).toFixed(2)}%`}
        />
        <Row
          k="APR"
          v={aprBps === null ? "—" : `${(aprBps / 100).toFixed(2)}%`}
        />
        <Row
          k="Unbonding"
          v="Instant (§23.2 zero-unbond)"
          tone="var(--ok)"
        />
      </div>

      <div className="ext-card" style={{ padding: 12 }}>
        <div
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 9.5,
            color: "var(--fg-500)",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            marginBottom: 4,
          }}
        >
          Chain
        </div>
        <div
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 10.5,
            color: "var(--fg-300)",
            lineHeight: 1.6,
          }}
        >
          Submits as a `delegate(clusterId, weightBps)` call to the
          delegation precompile via the encrypted-mempool path. Sprintnet
          may reject the call until the gate is activated.
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 8,
        }}
      >
        <button onClick={onBack} style={secondaryBtn}>
          Back
        </button>
        <button
          className="ext-act prim"
          onClick={onConfirm}
          style={{
            padding: 12,
            flexDirection: "row",
            gap: 8,
          }}
        >
          <Icon name="check" size={12} /> Confirm
        </button>
      </div>
    </div>
  );
}

function SubmittingView() {
  return (
    <div
      style={{
        padding: "60px 20px",
        textAlign: "center",
        fontSize: 12.5,
        color: "var(--fg-300)",
        fontFamily: "var(--f-mono)",
      }}
    >
      <Icon name="stake" size={32} />
      <div style={{ marginTop: 16 }}>Submitting delegation…</div>
      <div
        style={{ fontSize: 10, color: "var(--fg-500)", marginTop: 6, lineHeight: 1.5 }}
      >
        Encrypted-mempool envelope → cluster → admission gate
      </div>
    </div>
  );
}

interface SuccessViewProps {
  txHash: string;
  copied: boolean;
  onCopy: () => void;
  onDone: () => void;
}

function SuccessView({ txHash, copied, onCopy, onDone }: SuccessViewProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div
        style={{
          padding: "40px 20px",
          textAlign: "center",
          color: "var(--ok)",
        }}
      >
        <Icon name="check" size={40} />
        <div
          style={{ marginTop: 16, fontSize: 13.5, fontWeight: 600 }}
        >
          Delegation submitted
        </div>
      </div>
      <div className="ext-card" style={{ padding: 12 }}>
        <div
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 9.5,
            color: "var(--fg-500)",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
          }}
        >
          Transaction hash
        </div>
        <div
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 10.5,
            color: "var(--fg-200)",
            marginTop: 6,
            wordBreak: "break-all",
          }}
        >
          {txHash}
        </div>
        <button onClick={onCopy} style={{ ...secondaryBtn, marginTop: 8, width: "100%" }}>
          {copied ? "Copied" : "Copy hash"}
        </button>
      </div>
      <button onClick={onDone} className="ext-act prim" style={{ padding: 12 }}>
        Done
      </button>
    </div>
  );
}

interface ErrorViewProps {
  error: {
    message: string;
    code: number | null;
    method: string | null;
    via: string | null;
  };
  onRetry: () => void;
  onCancel: () => void;
}

function ErrorView({ error, onRetry, onCancel }: ErrorViewProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div
        style={{
          padding: "40px 20px",
          textAlign: "center",
          color: "var(--err)",
        }}
      >
        <Icon name="warn" size={40} />
        <div
          style={{ marginTop: 16, fontSize: 13, fontWeight: 600 }}
        >
          Delegation failed
        </div>
      </div>
      <div
        style={{
          padding: 12,
          borderRadius: 10,
          background: "rgba(220,80,80,0.08)",
          border: "1px solid rgba(220,80,80,0.4)",
        }}
      >
        <div
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 11,
            color: "var(--err)",
            wordBreak: "break-word",
            lineHeight: 1.5,
          }}
        >
          {error.message}
        </div>
        {(error.code !== null || error.method !== null || error.via !== null) && (
          <div
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 9.5,
              color: "var(--fg-500)",
              marginTop: 8,
            }}
          >
            {error.code !== null && <>code {error.code} · </>}
            {error.method !== null && <>{error.method} · </>}
            {error.via !== null && <>via {error.via}</>}
          </div>
        )}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 8,
        }}
      >
        <button onClick={onCancel} style={secondaryBtn}>
          Cancel
        </button>
        <button onClick={onRetry} className="ext-act prim" style={{ padding: 12 }}>
          Retry
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers + styles
// ─────────────────────────────────────────────────────────────────────────────

function parseLythAmount(s: string): bigint | null {
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  if (parseFloat(s) <= 0) return null;
  const dot = s.indexOf(".");
  const intPart = dot < 0 ? s : s.slice(0, dot);
  const fracPart = dot < 0 ? "" : s.slice(dot + 1);
  if (fracPart.length > 18) return null;
  const padded = fracPart + "0".repeat(18 - fracPart.length);
  try {
    return BigInt(intPart) * 10n ** 18n + (padded.length > 0 ? BigInt(padded) : 0n);
  } catch {
    return null;
  }
}

function formatWei(wei: bigint, decimals = 4): string {
  const whole = wei / 10n ** 18n;
  const rem = wei % 10n ** 18n;
  if (rem === 0n || decimals === 0) return whole.toString();
  const remStr = rem.toString().padStart(18, "0").slice(0, decimals);
  const trimmed = remStr.replace(/0+$/, "");
  return trimmed.length === 0 ? whole.toString() : `${whole}.${trimmed}`;
}

function Row({
  k,
  v,
  tone,
}: {
  k: string;
  v: string;
  tone?: string;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "120px 1fr",
        gap: 8,
        padding: "4px 0",
        alignItems: "baseline",
      }}
    >
      <span
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 9.5,
          color: "var(--fg-500)",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
        }}
      >
        {k}
      </span>
      <span
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 11,
          color: tone ?? "var(--fg-100)",
          wordBreak: "break-word",
        }}
      >
        {v}
      </span>
    </div>
  );
}

const secondaryBtn: CSSProperties = {
  padding: 12,
  borderRadius: 10,
  border: "1px solid var(--fg-700)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-sans)",
  fontSize: 12,
  cursor: "pointer",
};

const errBanner: CSSProperties = {
  padding: "10px 12px",
  borderRadius: 10,
  background: "rgba(220,80,80,0.08)",
  border: "1px solid rgba(220,80,80,0.4)",
  fontFamily: "var(--f-mono)",
  fontSize: 11,
  color: "var(--err)",
  lineHeight: 1.5,
};
