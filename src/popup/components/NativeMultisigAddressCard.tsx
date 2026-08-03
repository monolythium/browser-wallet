// Read-only native `monom…` multisig address display — Phase 9 commit 2/5.
//
// For an EXISTING multisig vault (its stored signer roster + threshold), derive
// the native on-chain (`monom…`) multisig address using the commit-1 primitive
// (`deriveNativeMultisigAddress`, KAT-verified against the chain's genesis-pinned
// foundation address) and show it READ-ONLY, with auditable derivation inputs and
// an honest not-yet-in-use / not-yet-spendable state.
//
// SAFETY: this address is NOT yet in use and NOT yet spendable — the vault's
// funds live at the single-key executor address, which remains operative today.
// The native send path ships in a later, gated commit. There is deliberately NO
// send / copy-to-send / QR affordance here: nothing must imply funds are there or
// that it is a send target. No-mock: a vault whose member pubkeys are unavailable
// shows an honest "cannot derive" state; a failed on-chain read hides the balance
// line rather than fabricating one.
//
// Gated behind DEVELOPER_MODE: an incomplete, technical/audit surface that power
// users opt into — it must not confuse ordinary users while Phase 9 is in flight.

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";

import { keccak_256 } from "@noble/hashes/sha3.js";
import { hexToBytes, bytesToHex } from "@monolythium/core-sdk/crypto";

import {
  submitThrowFailure,
  verbatimFailure,
  type SubmitFailure,
} from "../submit-failure";
import { deriveNativeMultisigAddress } from "../../shared/native-multisig.js";
import type { MultisigVaultMeta } from "../../shared/multisig.js";
import { bech32mDisplay } from "../../shared/bech32m.js";
import { DevBadge } from "./DevBadge.js";
import { parseHexQuantity, lythoshiToLythDecimal } from "../../shared/native-amount.js";
import { formatLythDecimalDisplay } from "../../shared/lyth-units.js";
import { lythToLythoshi } from "../../shared/spending-policy-tx.js";
import { bgWalletBalance, bgNativeMultisigSend } from "../bg.js";
import { useFeature } from "../hooks/useFeature.js";

const ML_DSA_65_PUBKEY_LEN = 1952;

// The honest copy is the safety anchor — asserted verbatim in the tests.
export const NATIVE_MULTISIG_HEADING = "Native multisig address (preview)";
export const NATIVE_MULTISIG_NOT_IN_USE_COPY =
  "Not yet in use — this wallet's funds are held at the single-key executor address, which remains the operative address today.";
export const NATIVE_MULTISIG_NOT_SPENDABLE_COPY =
  "Spending from the native address isn't available in the wallet yet, and it isn't a send target. Don't send funds here.";
export const NATIVE_MULTISIG_CANNOT_DERIVE_COPY =
  "Native address unavailable — this vault's member public keys aren't stored, so the on-chain address can't be derived.";

export interface NativeMultisigMemberView {
  label: string;
  address: string;
  /** Short keccak fingerprint of the member's 1952-byte pubkey — binds the audit
   *  to the exact key bytes the derivation consumed. */
  pubkeyFingerprint: string;
}

export interface NativeMultisigDisplay {
  /** The derived on-chain `monom…` multisig address (read-only; not yet in use). */
  monomAddress: string;
  threshold: number;
  memberCount: number;
  /** Members in the canonical DERIVATION order (ascending by raw pubkey bytes). */
  members: NativeMultisigMemberView[];
}

export type NativeMultisigDisplayResult =
  | { ok: true; display: NativeMultisigDisplay }
  | { ok: false; reason: string };

/**
 * PURE. Compute the read-only native-address display model for an existing
 * multisig vault from its stored signer roster + threshold. Returns an honest
 * "cannot derive" result when any member pubkey is missing/malformed (never
 * fabricates). Members come back in the canonical derivation (sorted-by-pubkey)
 * order so the derivation is auditable. Delegates the address derivation to the
 * commit-1 wrapper — never re-derives or hand-rolls the crypto.
 */
export function deriveNativeMultisigDisplay(
  signers: readonly { pubkey: string; label: string; address: string }[],
  threshold: number,
): NativeMultisigDisplayResult {
  if (signers.length === 0) return { ok: false, reason: "no signers" };
  const parsed: { pubkey: Uint8Array; hex: string; label: string; address: string }[] = [];
  for (const s of signers) {
    let bytes: Uint8Array;
    try {
      bytes = hexToBytes(s.pubkey);
    } catch {
      return { ok: false, reason: NATIVE_MULTISIG_CANNOT_DERIVE_COPY };
    }
    if (bytes.length !== ML_DSA_65_PUBKEY_LEN) {
      return { ok: false, reason: NATIVE_MULTISIG_CANNOT_DERIVE_COPY };
    }
    parsed.push({ pubkey: bytes, hex: bytesToHex(bytes), label: s.label, address: s.address });
  }
  const monomAddress = deriveNativeMultisigAddress(
    threshold,
    parsed.map((p) => p.pubkey),
  );
  // Canonical derivation order: ascending by raw pubkey bytes (the same
  // comparator the address derivation applies). All pubkeys are equal length
  // (1952 B), so lowercase-hex lexicographic order == unsigned byte order.
  const sorted = [...parsed].sort((a, b) => (a.hex < b.hex ? -1 : a.hex > b.hex ? 1 : 0));
  return {
    ok: true,
    display: {
      monomAddress,
      threshold,
      memberCount: parsed.length,
      members: sorted.map((p) => ({
        label: p.label,
        address: p.address,
        pubkeyFingerprint: "0x" + bytesToHex(keccak_256(p.pubkey)).replace(/^0x/i, "").slice(0, 8),
      })),
    },
  };
}

/** Format a lythoshi-hex balance to a short decimal LYTH string (display-only). */
function formatBalanceLyth(balanceHex: string): string {
  const lythoshi = parseHexQuantity(balanceHex) ?? 0n;
  return formatLythDecimalDisplay(lythoshiToLythDecimal(lythoshi), 4);
}

/**
 * PURE presentational card. Renders the derived native address (or the honest
 * cannot-derive state), the auditable inputs, and — when the optional on-chain
 * read succeeded — a balance line. NO hooks, NO send/copy/QR affordance (nothing
 * interactive). SSR-testable.
 */
export function NativeMultisigAddressCardView({
  result,
  balanceText,
}: {
  result: NativeMultisigDisplayResult;
  balanceText: string | null;
}) {
  return (
    <div style={cardStyle}>
      {/* The only in-app mount of this view is behind the wrapper's
          `if (!devMode) return null`, so the marker cannot reach a user who
          has developer mode off. */}
      <div style={sectionLabelStyle}>
        {NATIVE_MULTISIG_HEADING}
        <DevBadge />
      </div>
      {!result.ok ? (
        <div style={cannotDeriveStyle}>{NATIVE_MULTISIG_CANNOT_DERIVE_COPY}</div>
      ) : (
        <>
          <div style={warnCopyStyle}>{NATIVE_MULTISIG_NOT_IN_USE_COPY}</div>
          <div style={monomAddrStyle} title={result.display.monomAddress}>
            {result.display.monomAddress}
          </div>
          <div style={notSpendableStyle}>{NATIVE_MULTISIG_NOT_SPENDABLE_COPY}</div>

          <div style={inputsLabelStyle}>Derivation inputs (auditable)</div>
          <div style={thresholdLineStyle}>
            Threshold: {result.display.threshold} of {result.display.memberCount}
          </div>
          <div style={membersLabelStyle}>Members, in derivation order:</div>
          {result.display.members.map((m, i) => (
            <div key={`${m.pubkeyFingerprint}-${i}`} style={memberRowStyle}>
              <div style={memberNumStyle}>{i + 1}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={memberLabelStyle}>{m.label}</div>
                <div style={memberAddrStyle} title={m.address}>
                  {bech32mDisplay(m.address)}
                </div>
              </div>
              <div style={fingerprintStyle} title="pubkey fingerprint">
                {m.pubkeyFingerprint}
              </div>
            </div>
          ))}

          {balanceText !== null && (
            <div style={balanceLineStyle}>On-chain balance: {balanceText} LYTH</div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Stateful wrapper. Self-gated behind DEVELOPER_MODE (hidden by default). Computes
 * the display model from the vault meta and does the OPTIONAL read-only on-chain
 * balance read via the existing `bgWalletBalance` path (Phase-1 failover); a
 * failed read leaves the balance line hidden (no fabrication). Read/display only —
 * no write path.
 */
export function NativeMultisigAddressCard({
  meta,
  vaultId,
  chainId,
}: {
  meta: MultisigVaultMeta;
  vaultId: string;
  chainId: string;
}) {
  const devMode = useFeature("DEVELOPER_MODE");
  const result = useMemo(
    () => deriveNativeMultisigDisplay(meta.signers, meta.threshold),
    [meta.signers, meta.threshold],
  );
  const [balanceText, setBalanceText] = useState<string | null>(null);

  useEffect(() => {
    if (!devMode || !result.ok) {
      setBalanceText(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const r = await bgWalletBalance(result.display.monomAddress, chainId);
      if (cancelled) return;
      // No-mock: only render a balance the chain actually returned; a failed /
      // unreachable read hides the line entirely.
      setBalanceText(r.ok ? formatBalanceLyth(r.balanceHex) : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [devMode, result, chainId]);

  if (!devMode) return null;
  return (
    <>
      <NativeMultisigAddressCardView result={result} balanceText={balanceText} />
      {result.ok && (
        <NativeMultisigSendForm vaultId={vaultId} chainId={chainId} monom={result.display.monomAddress} />
      )}
    </>
  );
}

/**
 * DEVELOPER_MODE-only preview form to spend FROM the native monom address. It is
 * UNVERIFIED on-chain — the server-side handler additionally refuses it unless
 * DEVELOPER_MODE is on, and the whole surface is gated. This exists so trace-agent
 * can run the live-testnet e2e once the chain stabilizes; it is not a user path.
 */
export const NATIVE_MULTISIG_SEND_UNVERIFIED_COPY =
  "Unverified on-chain — this native multisig send has not passed a live end-to-end test. Developer preview only.";

function NativeMultisigSendForm({
  vaultId,
  chainId,
  monom,
}: {
  vaultId: string;
  chainId: string;
  monom: string;
}) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<
    { ok: true; text: string } | { ok: false; failure: SubmitFailure } | null
  >(null);

  const submit = () => {
    setBusy(true);
    setResult(null);
    void (async () => {
      let valueWeiHex: string;
      try {
        valueWeiHex = "0x" + lythToLythoshi(amount.trim() || "0").toString(16);
      } catch {
        setResult({ ok: false, failure: verbatimFailure(undefined, "Invalid amount.") });
        setBusy(false);
        return;
      }
      try {
        const r = await bgNativeMultisigSend({
          vaultId,
          to: to.trim(),
          valueWeiHex,
          chainIdHex: chainId,
        });
        setResult(
          r.ok
            ? { ok: true, text: `Broadcast: ${r.txHash}` }
            : { ok: false, failure: verbatimFailure(r.reason, "Send failed.") },
        );
      } catch (e) {
        // Previously uncaught: neither setResult nor setBusy ran, so the button
        // stayed disabled on "Broadcasting…" for good with both inputs frozen and
        // no error anywhere. This op moves value, so a stuck form with no
        // explanation is the worst combination on this card.
        setResult({ ok: false, failure: submitThrowFailure(e) });
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <div style={sendFormStyle}>
      <div style={sendUnverifiedStyle}>{NATIVE_MULTISIG_SEND_UNVERIFIED_COPY}</div>
      <div style={{ fontSize: 9.5, color: "var(--fg-500)", marginBottom: 6 }} title={monom}>
        Spends from {bech32mDisplay(monom)}
      </div>
      <input
        style={sendInputStyle}
        placeholder="Recipient address"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        disabled={busy}
      />
      <input
        style={sendInputStyle}
        placeholder="Amount (LYTH)"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        disabled={busy}
      />
      <button
        type="button"
        onClick={submit}
        disabled={busy || to.trim().length === 0}
        style={{ ...sendButtonStyle, opacity: busy || to.trim().length === 0 ? 0.5 : 1 }}
      >
        {busy ? "Broadcasting…" : "Send (preview)"}
      </button>
      {result !== null && (
        <div
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 9.5,
            marginTop: 6,
            wordBreak: "break-all",
            color: result.ok ? "var(--fg-200)" : "var(--err)",
          }}
        >
          {result.ok ? (
            result.text
          ) : (
            <>
              {result.failure.headline !== null && (
                <div style={{ fontWeight: 600, marginBottom: 3 }}>
                  {result.failure.headline}
                </div>
              )}
              {result.failure.body}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── styles ──────────────────────────────────────────────────────────────────

const cardStyle: CSSProperties = {
  marginTop: 12,
  padding: 12,
  borderRadius: 10,
  border: "1px dashed var(--fg-700)",
  background: "rgba(255,255,255,0.02)",
};
const sectionLabelStyle: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 10,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: "var(--fg-400)",
  marginBottom: 8,
};
const warnCopyStyle: CSSProperties = {
  fontSize: 11.5,
  lineHeight: 1.5,
  color: "var(--fg-200)",
};
const monomAddrStyle: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 10.5,
  color: "var(--fg-100)",
  wordBreak: "break-all",
  margin: "8px 0",
  padding: "6px 8px",
  borderRadius: 6,
  background: "rgba(255,255,255,0.03)",
};
const notSpendableStyle: CSSProperties = {
  fontSize: 11,
  lineHeight: 1.5,
  color: "var(--fg-400)",
};
const inputsLabelStyle: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 9.5,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "var(--fg-500)",
  marginTop: 12,
  marginBottom: 6,
};
const thresholdLineStyle: CSSProperties = {
  fontSize: 11.5,
  color: "var(--fg-200)",
  marginBottom: 6,
};
const membersLabelStyle: CSSProperties = {
  fontSize: 10.5,
  color: "var(--fg-500)",
  marginBottom: 4,
};
const memberRowStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "center",
  padding: "3px 0",
};
const memberNumStyle: CSSProperties = {
  width: 16,
  height: 16,
  borderRadius: "50%",
  background: "rgba(124,127,255,0.12)",
  color: "var(--fg-300)",
  fontSize: 9,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};
const memberLabelStyle: CSSProperties = { fontSize: 11.5, color: "var(--fg-100)" };
const memberAddrStyle: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 9.5,
  color: "var(--fg-400)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const fingerprintStyle: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 9.5,
  color: "var(--fg-300)",
  flexShrink: 0,
};
const cannotDeriveStyle: CSSProperties = {
  fontSize: 11.5,
  lineHeight: 1.5,
  color: "var(--fg-400)",
};
const balanceLineStyle: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 10.5,
  color: "var(--fg-300)",
  marginTop: 10,
};
const sendFormStyle: CSSProperties = {
  marginTop: 10,
  padding: 10,
  borderRadius: 8,
  border: "1px dashed rgba(var(--err-glow), 0.4)",
  background: "rgba(var(--err-glow), 0.05)",
};
const sendUnverifiedStyle: CSSProperties = {
  fontSize: 10.5,
  lineHeight: 1.45,
  color: "var(--err)",
  marginBottom: 8,
};
const sendInputStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "6px 8px",
  marginBottom: 6,
  borderRadius: 6,
  border: "1px solid var(--fg-700)",
  background: "rgba(0,0,0,0.15)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-mono)",
  fontSize: 10.5,
};
const sendButtonStyle: CSSProperties = {
  width: "100%",
  padding: "7px 10px",
  borderRadius: 6,
  border: "1px solid var(--fg-700)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--fg-200)",
  fontFamily: "var(--f-sans)",
  fontSize: 11.5,
  fontWeight: 600,
  cursor: "pointer",
};
