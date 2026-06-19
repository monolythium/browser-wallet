// EditChain — mutate a user-added chain. chainId is locked (it's the
// registry key); name, RPC, blockExplorer, and the nativeCurrency block
// are editable. Builtin chains never reach this screen — the caller
// gates entry on `!chain.builtin`, and the SW chain-edit op rejects
// builtin keys server-side as defense in depth.
//
// Native currency is all-or-nothing on the wire: blank → patch nulls
// the field; all three filled → patch sets the object.

import { useState, type CSSProperties, type ReactNode } from "react";
import { Icon } from "../Icon";
import { bgChainEdit } from "../bg";
import type { ChainEntry } from "../bg";
import {
  parseUrlInput,
  parseCurrencyBlock,
  validateName,
} from "./AddCustomChain";

interface EditChainProps {
  chain: ChainEntry;
  onBack: () => void;
  /** Called after the SW confirms the edit succeeded. Parent re-fetches
   *  chain-list and routes back. */
  onSaved: () => void;
}

export function EditChain({ chain, onBack, onSaved }: EditChainProps) {
  const [name, setName] = useState(chain.name);
  const [rpc, setRpc] = useState(chain.rpc);
  const [explorer, setExplorer] = useState(chain.blockExplorer ?? "");
  const [currencyName, setCurrencyName] = useState(chain.nativeCurrency?.name ?? "");
  const [currencySymbol, setCurrencySymbol] = useState(chain.nativeCurrency?.symbol ?? "");
  const [currencyDecimalsStr, setCurrencyDecimalsStr] = useState(
    chain.nativeCurrency ? String(chain.nativeCurrency.decimals) : "",
  );
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const nameError = validateName(name);
  const rpcResult = parseUrlInput(rpc, { requireHttps: false });
  const explorerResult = parseUrlInput(explorer, { requireHttps: true, optional: true });
  const currencyResult = parseCurrencyBlock(
    currencyName,
    currencySymbol,
    currencyDecimalsStr,
  );

  const canSubmit =
    nameError === null &&
    rpcResult.kind === "ok" &&
    explorerResult.kind === "ok" &&
    currencyResult.kind === "ok" &&
    !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    if (rpcResult.kind !== "ok") return;
    setSubmitting(true);
    setSubmitError(null);
    const explorerForPatch =
      explorerResult.kind === "ok" && explorerResult.value
        ? explorerResult.value
        : null;
    const currencyForPatch =
      currencyResult.kind === "ok" ? currencyResult.value : null;
    const r = await bgChainEdit(chain.chainId, {
      name: name.trim(),
      rpc: rpcResult.value,
      blockExplorer: explorerForPatch,
      nativeCurrency: currencyForPatch,
    });
    setSubmitting(false);
    if (!r.ok) {
      setSubmitError(r.reason ?? "save failed");
      return;
    }
    onSaved();
  };

  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div
          style={{ flex: 1, fontSize: 14, fontWeight: 600, textAlign: "center" }}
        >
          Edit chain
        </div>
        <div style={{ width: 36 }} />
      </div>

      <div className="ext-body">
        <FormCard label="Chain ID (locked)">
          <div
            style={{
              ...addressInputStyle,
              color: "var(--fg-400)",
              cursor: "not-allowed",
            }}
          >
            {chain.chainId}
          </div>
          <div style={inlineHint}>
            Decimal: <span style={{ fontFamily: "var(--f-mono)" }}>{chain.chainIdNum}</span>
          </div>
        </FormCard>

        <FormCard label="Name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My chain"
            spellCheck={false}
            autoComplete="off"
            style={addressInputStyle}
          />
          {nameError !== null && <div style={inlineError}>{nameError}</div>}
        </FormCard>

        <FormCard label="RPC URL">
          <input
            type="text"
            value={rpc}
            onChange={(e) => setRpc(e.target.value.trim())}
            placeholder="https://rpc.example.com"
            spellCheck={false}
            autoComplete="off"
            style={addressInputStyle}
          />
          {rpcResult.kind === "error" && (
            <div style={inlineError}>{rpcResult.message}</div>
          )}
          {rpcResult.kind === "ok" && rpcResult.scheme === "http" && (
            <div style={inlineWarn}>
              Non-HTTPS RPC — only use for trusted local nodes.
            </div>
          )}
        </FormCard>

        <FormCard label="Block explorer URL (optional)">
          <input
            type="text"
            value={explorer}
            onChange={(e) => setExplorer(e.target.value.trim())}
            placeholder="https://explorer.example.com"
            spellCheck={false}
            autoComplete="off"
            style={addressInputStyle}
          />
          {explorerResult.kind === "error" && (
            <div style={inlineError}>{explorerResult.message}</div>
          )}
        </FormCard>

        <FormCard label="Native currency (optional, all-or-nothing)">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <input
              type="text"
              value={currencyName}
              onChange={(e) => setCurrencyName(e.target.value)}
              placeholder="Currency name"
              spellCheck={false}
              autoComplete="off"
              style={addressInputStyle}
            />
            <input
              type="text"
              value={currencySymbol}
              onChange={(e) => setCurrencySymbol(e.target.value.trim())}
              placeholder="Symbol"
              spellCheck={false}
              autoComplete="off"
              style={addressInputStyle}
            />
            <input
              type="text"
              value={currencyDecimalsStr}
              onChange={(e) => setCurrencyDecimalsStr(e.target.value.trim())}
              placeholder="Decimals"
              spellCheck={false}
              autoComplete="off"
              inputMode="numeric"
              style={addressInputStyle}
            />
          </div>
          {currencyResult.kind === "error" && (
            <div style={inlineError}>{currencyResult.message}</div>
          )}
        </FormCard>

        {submitError && (
          <div
            className="ext-card"
            style={{
              padding: "10px 12px",
              background: "rgba(220,80,80,0.08)",
              border: "1px solid rgba(220,80,80,0.4)",
              fontSize: 12,
              color: "var(--err)",
            }}
          >
            {submitError}
          </div>
        )}

        <button
          className="ext-act prim"
          onClick={() => void handleSubmit()}
          disabled={!canSubmit}
          style={{
            width: "100%",
            padding: "12px",
            flexDirection: "row",
            gap: 8,
            opacity: canSubmit ? 1 : 0.5,
            cursor: canSubmit ? "pointer" : "default",
          }}
        >
          {submitting ? "Saving…" : "Save changes"}
        </button>
      </div>
    </>
  );
}

interface FormCardProps {
  label: string;
  children: ReactNode;
}

function FormCard({ label, children }: FormCardProps) {
  return (
    <div className="ext-card" style={{ padding: 14 }}>
      <div
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 10,
          color: "var(--fg-400)",
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

const addressInputStyle: CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 10,
  background: "rgba(0,0,0,0.3)",
  border: "1px solid var(--fg-700)",
  color: "var(--fg-100)",
  fontSize: 13,
  fontFamily: "var(--f-mono)",
  boxSizing: "border-box",
};

const inlineError: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 10,
  color: "var(--err)",
  marginTop: 6,
};

const inlineHint: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 10,
  color: "var(--fg-400)",
  marginTop: 6,
};

const inlineWarn: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 10,
  color: "var(--warn)",
  marginTop: 6,
};
