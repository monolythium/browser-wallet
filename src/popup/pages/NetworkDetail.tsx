// NetworkDetail — read-only view for builtin chains, write-capable for
// user-added. Tapping any row in the Networks list routes here; the
// detail page is where Activate / Edit / Delete actions live.
//
// Design contract:
// - Builtin chains (the testnet) render metadata + [Activate] only — no
//   Edit/Delete affordances. The check for `chain.builtin` is the single
//   visibility gate; the SW's chain-edit / chain-delete ops also reject
//   builtin keys server-side, so this is defense in depth.
// - Delete on the active chain triggers a chainChanged broadcast in the
//   SW (active id resets to the testnet). The popup re-fetches chain state
//   from the parent's onDeleted hook.

import { useState, type CSSProperties } from "react";
import { Icon } from "../Icon";
import { bgChainDelete } from "../bg";
import { Modal } from "../components/Modal";
import type { ChainEntry } from "../bg";

interface NetworkDetailProps {
  chain: ChainEntry;
  isActive: boolean;
  onBack: () => void;
  onActivate: () => void;
  onEdit: () => void;
  /** Called after the SW confirms the chain was removed. Parent re-fetches
   *  chain-list and routes back to the Networks screen. */
  onDeleted: () => void;
}

export function NetworkDetail({
  chain,
  isActive,
  onBack,
  onActivate,
  onEdit,
  onDeleted,
}: NetworkDetailProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDelete = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    const r = await bgChainDelete(chain.chainId);
    setSubmitting(false);
    if (!r.ok) {
      setError(r.reason ?? "delete failed");
      return;
    }
    setConfirmOpen(false);
    onDeleted();
  };

  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div
          style={{ flex: 1, fontSize: 16, fontWeight: 600, textAlign: "center" }}
        >
          Network details
        </div>
        <div style={{ width: 28 }} />
      </div>

      <div className="ext-body">
        <div className="ext-card" style={{ padding: 14 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              marginBottom: 12,
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--fg-100)" }}>
              {chain.name}
            </div>
            {chain.official && (
              <span className="ext-badge-att" style={{ fontSize: 8 }}>
                <Icon name="shield" size={8} /> Official
              </span>
            )}
            {chain.builtin && !chain.official && (
              <span
                style={{
                  fontFamily: "var(--f-mono)",
                  fontSize: 9,
                  letterSpacing: "0.1em",
                  color: "var(--fg-400)",
                  textTransform: "uppercase",
                }}
              >
                Builtin
              </span>
            )}
          </div>

          <DetailRow label="Chain id" value={chain.chainId} mono />
          <DetailRow label="Decimal" value={String(chain.chainIdNum)} mono />
          <DetailRow label="RPC URL" value={chain.rpc} mono breakAll />
          {chain.blockExplorer && (
            <DetailRow
              label="Block explorer"
              value={chain.blockExplorer}
              mono
              breakAll
            />
          )}
          {chain.nativeCurrency && (
            <>
              <DetailRow label="Currency name" value={chain.nativeCurrency.name} />
              <DetailRow label="Currency symbol" value={chain.nativeCurrency.symbol} mono />
              <DetailRow
                label="Currency decimals"
                value={String(chain.nativeCurrency.decimals)}
                mono
              />
            </>
          )}
          {isActive && (
            <div
              style={{
                marginTop: 10,
                padding: "8px 10px",
                borderRadius: 8,
                background: "var(--gold-bg)",
                border: "1px solid rgba(124,127,255,0.35)",
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 11,
                color: "var(--gold)",
              }}
            >
              <Icon name="check" size={12} /> Active chain
            </div>
          )}
        </div>

        {!isActive && (
          <button
            className="ext-act prim"
            onClick={onActivate}
            style={{
              width: "100%",
              padding: "12px",
              flexDirection: "row",
              gap: 8,
            }}
          >
            Activate this chain
          </button>
        )}

        {!chain.builtin && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 8,
              marginTop: 8,
            }}
          >
            <button
              className="ext-act"
              onClick={onEdit}
              style={{ padding: "12px", flexDirection: "row", gap: 8 }}
            >
              Edit
            </button>
            <button
              onClick={() => setConfirmOpen(true)}
              style={{
                padding: "12px",
                borderRadius: 10,
                border: "1px solid rgba(220,80,80,0.4)",
                background: "rgba(220,80,80,0.08)",
                color: "var(--err)",
                fontFamily: "var(--f-sans)",
                fontSize: 12,
                fontWeight: 500,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
              }}
            >
              <Icon name="warn" size={12} /> Delete
            </button>
          </div>
        )}
      </div>

      <Modal
        open={confirmOpen}
        onClose={() => {
          if (submitting) return;
          setConfirmOpen(false);
          setError(null);
        }}
        title={
          <>
            <Icon name="warn" size={12} /> Delete {chain.name}?
          </>
        }
        titleAccent="var(--gold)"
      >
        <div style={{ fontSize: 12, lineHeight: 1.5, color: "var(--fg-200)" }}>
          {isActive ? (
            <>
              This is the active chain. Connected dApps will receive a{" "}
              <span style={{ fontFamily: "var(--f-mono)" }}>chainChanged</span>{" "}
              event and the wallet will switch to Monolythium Testnet.
            </>
          ) : (
            <>
              The chain will be removed from the wallet. dApps that re-add it via{" "}
              <span style={{ fontFamily: "var(--f-mono)" }}>
                wallet_addEthereumChain
              </span>{" "}
              will reappear here.
            </>
          )}
        </div>
        {error && (
          <div
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 10,
              color: "var(--err)",
              marginTop: 6,
            }}
          >
            {error}
          </div>
        )}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 8,
            marginTop: 6,
          }}
        >
          <button
            onClick={() => {
              if (submitting) return;
              setConfirmOpen(false);
              setError(null);
            }}
            disabled={submitting}
            style={modalCancelStyle}
          >
            Cancel
          </button>
          <button
            onClick={() => void handleDelete()}
            disabled={submitting}
            style={{ ...modalDeleteStyle, opacity: submitting ? 0.6 : 1 }}
          >
            {submitting ? "Deleting…" : "Delete"}
          </button>
        </div>
      </Modal>
    </>
  );
}

interface DetailRowProps {
  label: string;
  value: string;
  mono?: boolean;
  breakAll?: boolean;
}

function DetailRow({ label, value, mono, breakAll }: DetailRowProps) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        gap: 12,
        padding: "6px 0",
        borderBottom: "1px solid rgba(255,255,255,0.04)",
      }}
    >
      <div
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 10,
          color: "var(--fg-400)",
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          flexShrink: 0,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: mono ? "var(--f-mono)" : "var(--f-sans)",
          fontSize: 11.5,
          color: "var(--fg-100)",
          textAlign: "right",
          ...(breakAll ? { wordBreak: "break-all" as const } : {}),
        }}
      >
        {value}
      </div>
    </div>
  );
}

const modalCancelStyle: CSSProperties = {
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

const modalDeleteStyle: CSSProperties = {
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
