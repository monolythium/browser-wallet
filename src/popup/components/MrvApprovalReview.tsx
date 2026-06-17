// Monolythium Wallet — dedicated MRV (RISC-V native) approval review panel.
//
// This is the dApp-facing approval screen for an MRV deploy/call. It graduates
// the rich review out of the DEVELOPER_MODE-only MrvNative.tsx page so any
// connected dApp's deploy/call request gets a first-class confirmation:
//   • deploy-vs-call label
//   • artifact summary (hash) for deploys
//   • constructor / call calldata display
//   • risk-label chips
//   • native fee summary
//
// The plain deploy/call/constructor lane is LIVE today, so this panel always
// renders. Parity-DEPENDENT UX — the call_value row, the note about the three
// new host syscalls (block_timestamp / chain_id / call_value), and the
// rich-receipt hint — is gated behind a `lyth_capabilities` feature-detect per
// the shared CONTRACT. It lights up automatically at the foundation-signed
// milestone height N with no re-release; N is never hardcoded.

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

import { Icon } from "../Icon";
import { shortAddr } from "../Icon";
import {
  bgWalletMrvParityCapability,
  type ChainEntry,
  type MrvApprovalRequest,
} from "../bg";
import { ChainStatusBanner } from "../components";
import { detectOriginWarnings } from "../../shared/phishing";
import {
  formatExecutionUnits as formatNativeExecutionUnits,
  formatLythoshiAmountHex as formatNativeLythoshiAmountHex,
  parseNativeHexQuantity,
} from "../../shared/native-fee-display";
import {
  isMrvParityActive,
  MRV_PARITY_INACTIVE,
  type MrvParityCapability,
} from "../../shared/mrv-capabilities";
import type { NativeDevRiskLabel, NativeDevRiskSeverity } from "../../shared/mrv-native-plan";

export interface MrvApprovalReviewProps {
  request: MrvApprovalRequest;
  onApprove: () => void;
  onReject: () => void;
  chain: ChainEntry;
}

interface ParityState {
  loading: boolean;
  capability: MrvParityCapability;
  blockNumber: number | null;
}

export function MrvApprovalReview({
  request,
  onApprove,
  onReject,
  chain,
}: MrvApprovalReviewProps) {
  const { kind, origin, view, tx } = request;
  const isDeploy = kind === "mrv_deploy";
  const originWarnings = detectOriginWarnings(origin);

  const [parity, setParity] = useState<ParityState>({
    loading: true,
    capability: MRV_PARITY_INACTIVE,
    blockNumber: null,
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await bgWalletMrvParityCapability({ chainIdHex: view.chainId });
        if (cancelled) return;
        if (res.ok) {
          setParity({
            loading: false,
            capability: res.capability,
            blockNumber: res.blockNumber,
          });
          return;
        }
        setParity({ loading: false, capability: MRV_PARITY_INACTIVE, blockNumber: null });
      } catch {
        if (!cancelled) {
          setParity({ loading: false, capability: MRV_PARITY_INACTIVE, blockNumber: null });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view.chainId]);

  // Per the CONTRACT: parity-dependent UX is on only when the node reports the
  // capability active AND the sampled height has reached the milestone N.
  const parityActive = isMrvParityActive(parity.capability, parity.blockNumber);

  const valueLythoshi = parseNativeHexQuantity(view.valueLythoshiHex);
  const hasValue = valueLythoshi !== null && valueLythoshi > 0n;
  const contractAddress = request.contractAddress;
  const calldata = request.constructorInput ?? tx.data;

  return (
    <>
      <ChainStatusBanner network={chain} />
      <div className="req-head">
        <div className="origin">
          <div className="fav S">{isDeploy ? "+" : "ƒ"}</div>
          <div className="info">
            <div className="n">{isDeploy ? "Deploy contract" : "Contract call"}</div>
            <div className="u">{origin}</div>
          </div>
          <div style={kindBadge}>{isDeploy ? "MRV deploy" : "MRV call"}</div>
        </div>
        <h2>{isDeploy ? "Deploy RISC-V contract" : "Call RISC-V contract"}</h2>
        <div className="sub">
          {isDeploy
            ? "publishes native bytecode to a new contract address"
            : "executes a method on an existing native contract"}
        </div>
      </div>

      <OriginWarningPanel warnings={originWarnings} />

      <RiskChips labels={request.riskLabels} />

      <div className="req-section">
        <div className="req-section__h">{isDeploy ? "Artifact" : "Target"}</div>
        {isDeploy ? (
          <>
            <div className="req-kv">
              <span className="k">Artifact hash</span>
              <span className="v" style={monoVal}>
                {request.artifactHash ?? "not provided"}
              </span>
            </div>
            <div className="req-kv">
              <span className="k">New contract</span>
              <span className="v" style={monoVal}>
                {contractAddress ?? "derived after deploy"}
              </span>
            </div>
          </>
        ) : (
          <div className="req-kv">
            <span className="k">Contract</span>
            <span className="v" style={monoVal}>
              {contractAddress ? shortAddr(contractAddress) : (tx.to ?? "-")}
            </span>
          </div>
        )}
      </div>

      <div className="req-section">
        <div className="req-section__h">
          {isDeploy ? "Constructor input" : "Call data"}
        </div>
        <pre aria-label="MRV calldata" style={calldataBlock}>
          {calldata && calldata !== "0x" ? calldata : "0x (empty)"}
        </pre>
      </div>

      <div className="req-section">
        <div className="req-section__h">Fee</div>
        <div className="req-kv">
          <span className="k">Execution units</span>
          <span className="v" style={monoVal}>
            {formatNativeExecutionUnits(view.executionUnitLimitHex)}
          </span>
        </div>
        <div className="req-kv">
          <span className="k">Max fee</span>
          <span className="v" style={monoVal}>
            {formatNativeLythoshiAmountHex(view.pricePerExecutionUnitLythoshiHex)}
          </span>
        </div>
        <div className="req-kv">
          <span className="k">Priority tip</span>
          <span className="v" style={monoVal}>
            {formatNativeLythoshiAmountHex(view.priorityTipLythoshiHex)}
          </span>
        </div>

        {/* Parity-DEPENDENT: the call_value row only renders once the EVM-parity
            milestone is active (the call_value host syscall lands at N). Before
            N a non-zero value is still surfaced as a plain risk chip above. */}
        {parityActive && (
          <div className="req-kv">
            <span className="k">Call value</span>
            <span className="v" style={monoVal}>
              {hasValue ? formatNativeLythoshiAmountHex(view.valueLythoshiHex) : "0"}
            </span>
          </div>
        )}
      </div>

      {/* Parity-DEPENDENT: surface the newly allow-listed host syscalls + the
          synthesized rich receipt only once the milestone is active. */}
      {parityActive && (
        <div className="req-section">
          <div className="req-section__h">EVM-parity surface (active)</div>
          <div style={parityNote}>
            This node has activated app-contract parity at height{" "}
            {parity.capability.activationHeight}. The block_timestamp, chain_id,
            and call_value host syscalls are available to the contract, and a
            rich native receipt is rendered after inclusion.
          </div>
        </div>
      )}

      <div className="req-foot">
        <button onClick={onReject}>Reject</button>
        <button className="prim" onClick={onApprove}>
          {isDeploy ? "Deploy" : "Confirm call"}
        </button>
      </div>
    </>
  );
}

function RiskChips({ labels }: { labels: NativeDevRiskLabel[] }) {
  if (!labels || labels.length === 0) return null;
  return (
    <div style={chipRow}>
      {labels.map((label) => (
        <span key={label.id} style={chipStyle(label.severity)} title={label.detail}>
          {label.title}
        </span>
      ))}
    </div>
  );
}

function OriginWarningPanel({
  warnings,
}: {
  warnings: ReturnType<typeof detectOriginWarnings>;
}) {
  if (warnings.length === 0) return null;
  const danger = warnings.some((w) => w.level === "danger");
  return (
    <div className={`req-warn ${danger ? "danger" : "warn"}`}>
      <Icon name="warn" size={14} />
      <div>
        {warnings.map((w, i) => (
          <div key={i}>{w.text}</div>
        ))}
      </div>
    </div>
  );
}

const kindBadge: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 9,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: "var(--gold, #d4a03c)",
  padding: "3px 7px",
  border: "1px solid rgba(212,160,60,0.4)",
  borderRadius: 4,
};

const monoVal: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 11,
  wordBreak: "break-all",
};

const calldataBlock: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 10,
  color: "var(--fg-400)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
  maxHeight: 120,
  overflow: "auto",
  margin: "6px 0 0",
  padding: 8,
  borderRadius: 8,
  border: "1px solid var(--fg-700)",
  background: "rgba(255,255,255,0.03)",
};

const chipRow: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
  padding: "0 14px 4px",
};

const parityNote: CSSProperties = {
  fontSize: 11,
  color: "var(--fg-400)",
  lineHeight: 1.5,
};

function chipStyle(severity: NativeDevRiskSeverity): CSSProperties {
  const palette: Record<NativeDevRiskSeverity, { fg: string; border: string }> = {
    info: { fg: "var(--fg-300)", border: "var(--fg-600)" },
    warning: { fg: "var(--warn, #dca000)", border: "rgba(220,160,0,0.5)" },
    critical: { fg: "var(--danger, #e5484d)", border: "rgba(229,72,77,0.5)" },
  };
  const c = palette[severity];
  return {
    fontSize: 10,
    fontWeight: 600,
    padding: "3px 8px",
    borderRadius: 999,
    border: `1px solid ${c.border}`,
    color: c.fg,
    background: "rgba(255,255,255,0.02)",
  };
}
