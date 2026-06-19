// AddCustomChain — manual in-popup form to add a custom chain.
//
// Mirrors what wallet_addEthereumChain accepts but skips the approval gate
// because the user is already in the wallet UI. Validation happens client-
// side first (collision check, URL parse, range checks); the SW re-validates
// server-side as defense in depth.
//
// Native currency is all-or-nothing: blank → store without nativeCurrency
// (popup falls back to generic display); all three filled → store as-is.

import { useState, type CSSProperties, type ReactNode } from "react";
import { Icon } from "../Icon";
import { bgChainAddManual } from "../bg";

interface AddCustomChainProps {
  /** Already-known chain ids (canonical 0x + UPPER hex form). Used for
   *  client-side collision detection so the form can show the error
   *  inline before submitting. */
  existingChainIds: ReadonlySet<string>;
  onBack: () => void;
  /** Called after the SW confirms the add succeeded. Parent re-fetches
   *  chain-list and routes back to Networks. */
  onAdded: (chainId: string) => void;
}

export function AddCustomChain({ existingChainIds, onBack, onAdded }: AddCustomChainProps) {
  const [chainIdHex, setChainIdHex] = useState("");
  const [name, setName] = useState("");
  const [rpc, setRpc] = useState("");
  const [explorer, setExplorer] = useState("");
  const [currencyName, setCurrencyName] = useState("");
  const [currencySymbol, setCurrencySymbol] = useState("");
  const [currencyDecimalsStr, setCurrencyDecimalsStr] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const chainIdResult = parseChainIdInput(chainIdHex, existingChainIds);
  const nameError = validateName(name);
  const rpcResult = parseUrlInput(rpc, { requireHttps: false });
  const explorerResult = parseUrlInput(explorer, {
    requireHttps: true,
    optional: true,
  });
  const currencyResult = parseCurrencyBlock(currencyName, currencySymbol, currencyDecimalsStr);

  const canSubmit =
    chainIdResult.kind === "ok" &&
    nameError === null &&
    rpcResult.kind === "ok" &&
    explorerResult.kind === "ok" &&
    currencyResult.kind === "ok" &&
    !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    if (chainIdResult.kind !== "ok" || rpcResult.kind !== "ok") return;
    setSubmitting(true);
    setSubmitError(null);
    const r = await bgChainAddManual({
      chainId: chainIdResult.value,
      name: name.trim(),
      rpc: rpcResult.value,
      ...(explorerResult.kind === "ok" && explorerResult.value
        ? { blockExplorer: explorerResult.value }
        : {}),
      ...(currencyResult.kind === "ok" && currencyResult.value
        ? { nativeCurrency: currencyResult.value }
        : {}),
    });
    setSubmitting(false);
    if (!r.ok) {
      setSubmitError(r.reason ?? "add failed");
      return;
    }
    onAdded(r.chainId);
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
          Add custom chain
        </div>
        <div style={{ width: 28 }} />
      </div>

      <div className="ext-body">
        <FormCard label="Chain ID (hex)">
          <input
            type="text"
            value={chainIdHex}
            onChange={(e) => setChainIdHex(e.target.value.trim())}
            placeholder="0x10F2C"
            spellCheck={false}
            autoComplete="off"
            style={addressInputStyle}
          />
          {chainIdResult.kind === "error" && (
            <div style={inlineError}>{chainIdResult.message}</div>
          )}
          {chainIdResult.kind === "ok" && (
            <div style={inlineHint}>
              Decimal: <span style={{ fontFamily: "var(--f-mono)" }}>{chainIdResult.decimal}</span>
            </div>
          )}
        </FormCard>

        <FormCard label="Name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Monolythium"
            spellCheck={false}
            autoComplete="off"
            style={addressInputStyle}
          />
          {nameError !== null && name.length > 0 && (
            <div style={inlineError}>{nameError}</div>
          )}
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
              placeholder="Currency name (e.g. Monolythium LYTH)"
              spellCheck={false}
              autoComplete="off"
              style={addressInputStyle}
            />
            <input
              type="text"
              value={currencySymbol}
              onChange={(e) => setCurrencySymbol(e.target.value.trim())}
              placeholder="Symbol (e.g. LYTH)"
              spellCheck={false}
              autoComplete="off"
              style={addressInputStyle}
            />
            <input
              type="text"
              value={currencyDecimalsStr}
              onChange={(e) => setCurrencyDecimalsStr(e.target.value.trim())}
              placeholder="Decimals (e.g. 18)"
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
          {submitting ? "Adding…" : "Add chain"}
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

// ---- validation helpers ----

type ChainIdResult =
  | { kind: "ok"; value: string; decimal: number }
  | { kind: "error"; message: string }
  | { kind: "empty" };

export function parseChainIdInput(
  input: string,
  existingChainIds: ReadonlySet<string>,
): ChainIdResult {
  if (input.length === 0) return { kind: "empty" };
  if (!/^0x[0-9a-fA-F]+$/.test(input)) {
    return { kind: "error", message: "Chain id must be 0x-prefixed hex" };
  }
  const decimal = parseInt(input.slice(2), 16);
  if (!Number.isFinite(decimal) || decimal <= 0) {
    return { kind: "error", message: "Chain id must be a positive integer" };
  }
  const canonical = "0x" + input.slice(2).toUpperCase();
  if (existingChainIds.has(canonical)) {
    return { kind: "error", message: "Chain id already exists in your list" };
  }
  return { kind: "ok", value: canonical, decimal };
}

export function validateName(s: string): string | null {
  if (s.trim().length === 0) return "Name is required";
  if (s.trim().length > 64) return "Name must be 1-64 chars";
  return null;
}

type UrlResult =
  | { kind: "ok"; value: string; scheme: "http" | "https" | "other" }
  | { kind: "error"; message: string }
  | { kind: "empty" };

interface ParseUrlOpts {
  requireHttps?: boolean;
  optional?: boolean;
}

export function parseUrlInput(input: string, opts: ParseUrlOpts = {}): UrlResult {
  if (input.length === 0) {
    return opts.optional
      ? { kind: "ok", value: "", scheme: "other" }
      : { kind: "empty" };
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { kind: "error", message: "Must be a valid URL" };
  }
  const scheme: "http" | "https" | "other" =
    parsed.protocol === "https:" ? "https" : parsed.protocol === "http:" ? "http" : "other";
  if (opts.requireHttps && scheme !== "https") {
    return { kind: "error", message: "Must be https://" };
  }
  return { kind: "ok", value: input, scheme };
}

type CurrencyResult =
  | { kind: "ok"; value: { name: string; symbol: string; decimals: number } | null }
  | { kind: "error"; message: string };

export function parseCurrencyBlock(
  name: string,
  symbol: string,
  decimalsStr: string,
): CurrencyResult {
  const trimmedName = name.trim();
  const trimmedSymbol = symbol.trim();
  const trimmedDecimals = decimalsStr.trim();
  const allBlank =
    trimmedName.length === 0 && trimmedSymbol.length === 0 && trimmedDecimals.length === 0;
  if (allBlank) return { kind: "ok", value: null };
  const allFilled =
    trimmedName.length > 0 && trimmedSymbol.length > 0 && trimmedDecimals.length > 0;
  if (!allFilled) {
    return {
      kind: "error",
      message: "Provide all three currency fields, or leave all blank",
    };
  }
  if (trimmedName.length > 32) {
    return { kind: "error", message: "Currency name must be 1-32 chars" };
  }
  if (trimmedSymbol.length > 10) {
    return { kind: "error", message: "Symbol must be 1-10 chars" };
  }
  if (!/^\d+$/.test(trimmedDecimals)) {
    return { kind: "error", message: "Decimals must be a non-negative integer" };
  }
  const decimals = parseInt(trimmedDecimals, 10);
  if (decimals < 0 || decimals > 30) {
    return { kind: "error", message: "Decimals must be 0-30" };
  }
  return {
    kind: "ok",
    value: { name: trimmedName, symbol: trimmedSymbol, decimals },
  };
}
