// Phase 5 Commit 7 — SendNft. UI ported from
// `browser-wallet-old/src/popup/pages/SendNft.tsx` (384 LOC). The
// reference signs + broadcasts via its own secp256k1 keyring + a
// custom `SIGN_NFT_TRANSFER` background message; this version routes
// through the existing ML-DSA-65 pipeline — same `bgWalletSendTx`
// helper that `Send.tsx` uses for native LYTH transfers.
//
// Wire shape:
//   - `to` = NFT contract address (NOT the recipient — the recipient
//     is encoded into the calldata)
//   - `valueWeiHex` = 0 (low-level compatibility name; no LYTH attached)
//   - `data` = hand-rolled safeTransferFrom calldata. Selectors
//     0x42842e0e for ERC-721 and 0xf242432a for ERC-1155 (amount=1,
//     data=0x) per the prompt.
//   - `gasLimitHex` = low-level compatibility field carrying a
//     conservative 250 000 execution-unit limit covering both standards
//     plus Sprintnet's intrinsic transaction envelope overhead.
//
// Pre-submit ownership re-check fires after Sign & send: ERC-721
// `ownerOf` must match the active vault, ERC-1155 balance must be
// non-zero. Pinned-list / chain-state divergence (transferred away
// after pinning) gets caught here before fees burn.

import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";

import { Icon } from "../Icon";
import {
  bgEthCall,
  bgWalletFeeSuggestion,
  bgWalletSendTx,
  type FeeSuggestion,
} from "../bg";
import { addressToBech32m } from "../../shared/bech32m";
import {
  erc1155BalanceOf,
  erc721OwnerOf,
  fnSelector,
  sanitizeImageUri,
  type EthCaller,
  type NftMetadata,
} from "../../lib/nft-client";
import { formatSendError, validateToAddress } from "./Send";
import {
  computeNativeFeeFromPrice,
  formatNativeLythAmount,
  lythoshiToLythString,
  nativeFeeDisplayFromPrice,
  type NativeFeeFromPriceInput,
} from "../../shared/native-fee-display";

export { lythoshiToLythString };

export type SendNftStandard = "erc721" | "erc1155";

/** Mirrors `NftDetailEntry` from Commit 6 so NftDetail → SendNft is
 *  a direct prop pass-through. */
export interface SendNftTarget {
  contractAddress: string;
  /** Decimal string. Parsed back into bigint inside this page. */
  tokenId: string;
  collectionName: string;
  standard: SendNftStandard;
  metadata?: NftMetadata;
}

interface SendNftProps {
  /** Active vault EVM address. Null guards a hard error — no
   *  anonymous NFT send. */
  fromAddress: string | null;
  chainId: string;
  nft: SendNftTarget;
  onBack: () => void;
}

type Step = "form" | "preview" | "checking" | "sending" | "success" | "error";

interface SubmitError {
  message: string;
  code: number | null;
  method: string | null;
  via: string | null;
}

// Conservative execution-unit limit covering ERC-721 transferFrom (~50-90k),
// ERC-1155 safeTransferFrom (~60-100k), and Sprintnet's intrinsic
// transaction envelope overhead (~24k) with margin. Higher than reality is
// safe: only actual execution consumed is paid for under EIP-1559 mechanics.
const SEND_NFT_EXECUTION_UNIT_LIMIT = 250_000n;
const SEND_NFT_EXECUTION_UNIT_LIMIT_HEX = "0x" + SEND_NFT_EXECUTION_UNIT_LIMIT.toString(16);

export function SendNft({ fromAddress, chainId, nft, onBack }: SendNftProps) {
  const [step, setStep] = useState<Step>("form");
  const [recipient, setRecipient] = useState("");
  const [feeSuggestion, setFeeSuggestion] = useState<FeeSuggestion | null>(null);
  const [feeError, setFeeError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [hashCopied, setHashCopied] = useState(false);
  const [submitError, setSubmitError] = useState<SubmitError | null>(null);

  const tokenIdBig = useMemo(() => {
    try {
      return BigInt(nft.tokenId);
    } catch {
      return 0n;
    }
  }, [nft.tokenId]);

  const caller: EthCaller = useMemo(
    () => ({
      ethCall: async (req) => {
        const r = await bgEthCall(req.to, req.data, chainId);
        if (!r.ok) throw new Error(r.reason ?? "eth_call failed");
        return r.result;
      },
    }),
    [chainId],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await bgWalletFeeSuggestion(chainId);
      if (cancelled) return;
      if (!r.ok) {
        setFeeError(r.reason ?? "fee suggestion failed");
        return;
      }
      setFeeError(null);
      setFeeSuggestion(r.suggestion);
    })();
    return () => {
      cancelled = true;
    };
  }, [chainId]);

  const parsed = validateToAddress(recipient);
  const recipientReady = parsed.addr0x !== null;
  const estimatedFeeLythoshi = useMemo(
    () => computeEstimatedNftFeeLythoshi(feeSuggestion),
    [feeSuggestion],
  );
  const estimatedFeeResult = useMemo(
    () =>
      feeSuggestion === null
        ? null
        : nativeFeeDisplayFromPrice({
            executionUnitLimitHex: SEND_NFT_EXECUTION_UNIT_LIMIT_HEX,
            pricePerExecutionUnitLythoshiHex:
              feeSuggestion.maxPricePerExecutionUnitLythoshiHex,
            ...(feeSuggestion.structuredFee !== undefined
              ? { structuredFee: feeSuggestion.structuredFee }
              : {}),
          }),
    [feeSuggestion],
  );
  const estimatedFeeDisplay =
    estimatedFeeResult?.ok === true ? estimatedFeeResult.display : null;
  const feeDisplayError =
    estimatedFeeResult !== null && estimatedFeeResult.ok === false
      ? estimatedFeeResult.failures.join("; ")
      : null;

  const handleConfirm = async () => {
    if (!fromAddress || parsed.addr0x === null) return;
    setStep("checking");
    setSubmitError(null);
    setTxHash(null);

    // Pre-submit ownership re-check; pin state can drift from chain
    // state (transferred away after pinning), so this is a hard gate
    // before we burn fees on a guaranteed-revert tx.
    try {
      if (nft.standard === "erc721") {
        const owner = await erc721OwnerOf(caller, nft.contractAddress, tokenIdBig);
        if (owner.toLowerCase() !== fromAddress.toLowerCase()) {
          setSubmitError({
            message: `You no longer own this NFT (current owner ${owner.slice(0, 8)}…${owner.slice(-6)}). The pin may be stale.`,
            code: null,
            method: null,
            via: null,
          });
          setStep("error");
          return;
        }
      } else {
        const balance = await erc1155BalanceOf(
          caller,
          nft.contractAddress,
          fromAddress,
          tokenIdBig,
        );
        if (balance <= 0n) {
          setSubmitError({
            message: "Your balance for this ERC-1155 token id is zero. The pin may be stale.",
            code: null,
            method: null,
            via: null,
          });
          setStep("error");
          return;
        }
      }
    } catch (e) {
      setSubmitError({
        message: `Couldn't verify current ownership: ${(e as Error).message ?? "unknown error"}`,
        code: null,
        method: null,
        via: null,
      });
      setStep("error");
      return;
    }

    setStep("sending");
    try {
      const data =
        nft.standard === "erc721"
          ? encodeErc721SafeTransferFrom(fromAddress, parsed.addr0x, tokenIdBig)
          : encodeErc1155SafeTransferFromOne(fromAddress, parsed.addr0x, tokenIdBig);
      const r = await bgWalletSendTx({
        to: nft.contractAddress,
        valueWeiHex: "0x0",
        chainIdHex: chainId,
        data,
        executionUnitLimitHex: SEND_NFT_EXECUTION_UNIT_LIMIT_HEX,
      });
      if (r.ok) {
        setTxHash(r.result.txHash);
        setStep("success");
      } else {
        setSubmitError({
          message: r.reason ?? "send failed",
          code: typeof r.code === "number" ? r.code : null,
          method: typeof r.method === "string" ? r.method : null,
          via: typeof r.via === "string" ? r.via : null,
        });
        setStep("error");
      }
    } catch (e) {
      setSubmitError({
        message: (e as Error).message ?? "send failed",
        code: null,
        method: null,
        via: null,
      });
      setStep("error");
    }
  };

  const handleCopyHash = async () => {
    if (!txHash) return;
    try {
      await navigator.clipboard.writeText(txHash);
      setHashCopied(true);
      setTimeout(() => setHashCopied(false), 2000);
    } catch {
      /* clipboard write can fail; stay quiet (mirrors Send.tsx) */
    }
  };

  // ---- render ----

  if (!fromAddress) {
    return (
      <Shell title="Send NFT" onBack={onBack}>
        <div style={errBlock}>
          The active vault has no EVM address yet. Reopen the wallet
          after onboarding completes.
        </div>
      </Shell>
    );
  }

  if (step === "checking" || step === "sending") {
    return (
      <SpinnerView label={step === "checking" ? "Checking current ownership…" : "Sending transaction…"} />
    );
  }

  if (step === "success" && txHash !== null) {
    return (
      <Shell title="NFT sent" onBack={onBack}>
        <Hero color="ok" glyph="✓" label="Transaction submitted" />
        <div className="ext-card" style={{ padding: 14 }}>
          <Caption>Transaction hash</Caption>
          <div style={hashBlock}>{txHash}</div>
          <button type="button" onClick={() => void handleCopyHash()} style={{ ...btn2, width: "100%", marginTop: 12 }}>
            {hashCopied ? "Copied" : "Copy tx hash"}
          </button>
        </div>
        <button type="button" onClick={onBack} style={{ ...btn1, width: "100%", padding: "12px" }}>
          Done
        </button>
      </Shell>
    );
  }

  if (step === "error" && submitError !== null) {
    return (
      <Shell title="Send failed" onBack={onBack}>
        <Hero color="err" glyph="✕" label="Send failed" />
        <div className="ext-card" style={{ padding: 14 }}>
          <div style={{ fontSize: 12, lineHeight: 1.5, color: "var(--fg-100)", wordBreak: "break-word" }}>
            {formatSendError(submitError)}
          </div>
        </div>
        <Foot>
          <button type="button" onClick={onBack} style={btn2}>Cancel</button>
          <button type="button" onClick={() => { setSubmitError(null); setStep("form"); }} style={btn1}>Try again</button>
        </Foot>
      </Shell>
    );
  }

  if (step === "preview") {
    const feeText = estimatedFeeDisplay?.defaultText ??
      (estimatedFeeLythoshi !== null ? formatNativeLythAmount(estimatedFeeLythoshi) : "—");
    return (
      <Shell title="Review send" onBack={() => setStep("form")}>
        <div className="ext-card" style={{ padding: 14 }}>
          <NftMini nft={nft} />
          <div style={{ height: 8 }} />
          <Row label="From" value={shortenAddr(fromAddress)} />
          <Row label="To" value={shortenAddr(parsed.bech ?? parsed.addr0x ?? recipient)} />
          <Row label="Token ID" value={`#${nft.tokenId}`} />
          <Row label="Standard" value={nft.standard === "erc1155" ? "ERC-1155" : "ERC-721"} />
          <div style={{ marginTop: 8, paddingTop: 10, borderTop: "1px solid var(--fg-700)" }}>
            <Row label="Network fee" value={feeText} emphasis />
            <div style={{ fontSize: 10, color: "var(--fg-500)", marginTop: 4, fontFamily: "var(--f-mono)" }}>
              Estimated for this NFT transfer
            </div>
            {feeError && <div style={errText}>{feeError}</div>}
            {feeDisplayError && <div style={errText}>Malformed fee data: {feeDisplayError}</div>}
          </div>
        </div>
        <Foot>
          <button type="button" onClick={() => setStep("form")} style={btn2}>Reject</button>
          <button type="button" onClick={() => void handleConfirm()} style={btn1}>Sign &amp; send</button>
        </Foot>
      </Shell>
    );
  }

  // step === "form"
  return (
    <Shell title="Send NFT" onBack={onBack}>
      <NftMini nft={nft} card />
      <div>
        <Caption>Recipient</Caption>
        <input
          type="text"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          placeholder="0x… or mono1…"
          autoFocus
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          style={input}
        />
        {parsed.error && <div style={errText}>{parsed.error}</div>}
      </div>
      <div
        style={{
          padding: "10px 12px",
          borderRadius: 10,
          background: "rgba(242,180,65,0.08)",
          border: "1px solid rgba(242,180,65,0.4)",
          fontSize: 11.5,
          color: "var(--fg-100)",
          lineHeight: 1.5,
        }}
      >
        Sending an NFT is irreversible. Confirm the recipient matches
        the wallet you intend; transfers to a contract that can&apos;t
        receive ERC-721 / ERC-1155 will revert and waste the network fee.
      </div>
      <Foot>
        <button type="button" onClick={onBack} style={btn2}>Cancel</button>
        <button
          type="button"
          onClick={() => recipientReady && setStep("preview")}
          disabled={!recipientReady}
          style={recipientReady ? btn1 : { ...btn1, ...btnD }}
        >
          Continue
        </button>
      </Foot>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Tiny presentational helpers
// ---------------------------------------------------------------------------

function Shell({ title, onBack, children }: { title: string; onBack: () => void; children: React.ReactNode }) {
  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div style={{ flex: 1, fontSize: 13, fontWeight: 600, textAlign: "center" }}>{title}</div>
        <div style={{ width: 28 }} />
      </div>
      <div className="ext-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {children}
      </div>
    </>
  );
}

function SpinnerView({ label }: { label: string }) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        padding: 32,
      }}
    >
      <div
        style={{
          width: 48,
          height: 48,
          border: "3px solid var(--fg-700)",
          borderTopColor: "var(--gold)",
          borderRadius: "50%",
          animation: "monoNftSendSpin 0.9s linear infinite",
        }}
        aria-hidden="true"
      />
      <div style={{ fontSize: 13, color: "var(--fg-200)" }}>{label}</div>
      <style>{`@keyframes monoNftSendSpin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function Hero({ color, glyph, label }: { color: "ok" | "err"; glyph: string; label: string }) {
  const tint = color === "ok"
    ? { bg: "rgba(80,200,120,0.12)", bd: "rgba(80,200,120,0.4)", fg: "var(--ok)" }
    : { bg: "rgba(220,80,80,0.12)", bd: "rgba(220,80,80,0.4)", fg: "var(--err)" };
  return (
    <div style={{ textAlign: "center", padding: "20px 0 8px" }}>
      <div
        style={{
          width: 56,
          height: 56,
          margin: "0 auto 12px",
          display: "grid",
          placeItems: "center",
          borderRadius: "50%",
          background: tint.bg,
          border: `1px solid ${tint.bd}`,
          color: tint.fg,
          fontSize: 28,
        }}
        aria-hidden="true"
      >
        {glyph}
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--fg-100)" }}>{label}</div>
    </div>
  );
}

function NftMini({ nft, card }: { nft: SendNftTarget; card?: boolean }) {
  const [imgError, setImgError] = useState(false);
  const imageUrl = sanitizeImageUri(nft.metadata?.image);
  const displayName = nft.metadata?.name ?? `${nft.collectionName} #${nft.tokenId}`;
  const size = card ? 56 : 40;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        ...(card
          ? {
              padding: 10,
              borderRadius: 12,
              border: "1px solid var(--glass-stroke)",
              background: "rgba(255,255,255,0.03)",
            }
          : {}),
      }}
    >
      <div
        style={{
          width: size,
          height: size,
          borderRadius: 8,
          overflow: "hidden",
          background: "rgba(255,255,255,0.04)",
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {imageUrl && !imgError ? (
          <img
            src={imageUrl}
            alt={displayName}
            onError={() => setImgError(true)}
            loading="lazy"
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : (
          <span style={{ color: "var(--fg-500)", fontSize: 18 }}>◇</span>
        )}
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            color: "var(--fg-100)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={displayName}
        >
          {displayName}
        </div>
        <div
          style={{
            fontSize: 10.5,
            color: "var(--fg-400)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={nft.collectionName}
        >
          {nft.collectionName}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        gap: 12,
        padding: "6px 0",
      }}
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
        {label}
      </div>
      <div
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: emphasis ? 13 : 12,
          fontWeight: emphasis ? 600 : 500,
          color: emphasis ? "var(--gold)" : "var(--fg-100)",
          textAlign: "right",
          wordBreak: "break-all",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function Caption({ children }: { children: string }) {
  return (
    <div
      style={{
        fontFamily: "var(--f-mono)",
        fontSize: 10,
        color: "var(--fg-400)",
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  );
}

function Foot({ children }: { children: React.ReactNode }) {
  return (
    <div className="ext-foot" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 4 }}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Calldata + format helpers
// ---------------------------------------------------------------------------

/** ERC-721 `safeTransferFrom(address,address,uint256)`. Selector
 *  0x42842e0e per the prompt (3-arg overload — v1 sends no extra
 *  bytes). */
function encodeErc721SafeTransferFrom(from: string, to: string, tokenId: bigint): string {
  return (
    "0x" +
    fnSelector("safeTransferFrom(address,address,uint256)") +
    encAddr(from) +
    encAddr(to) +
    encU256(tokenId)
  );
}

/** ERC-1155 `safeTransferFrom(address,address,uint256,uint256,bytes)`.
 *  Selector 0xf242432a per the prompt. v1 always passes amount=1
 *  and empty data bytes (no bulk transfer; that's stripped). */
function encodeErc1155SafeTransferFromOne(from: string, to: string, tokenId: bigint): string {
  return (
    "0x" +
    fnSelector("safeTransferFrom(address,address,uint256,uint256,bytes)") +
    encAddr(from) +
    encAddr(to) +
    encU256(tokenId) +
    encU256(1n) +
    encU256(160n) +    // dataOffset = 5 * 32 bytes (static head)
    encU256(0n)        // dataLength = 0 (empty bytes)
  );
}

function encAddr(addr: string): string {
  return addr.replace(/^0x/i, "").toLowerCase().padStart(64, "0");
}

function encU256(value: bigint): string {
  if (value < 0n) throw new Error("uint256 must be non-negative");
  return value.toString(16).padStart(64, "0");
}

function shortenAddr(addr: string): string {
  if (!addr) return "—";
  if (addr.startsWith("mono1")) {
    return addr.length <= 18 ? addr : `${addr.slice(0, 8)}…${addr.slice(-6)}`;
  }
  if (/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    try {
      const b = addressToBech32m(addr);
      return `${b.slice(0, 8)}…${b.slice(-6)}`;
    } catch {
      return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
    }
  }
  return addr.length <= 18 ? addr : `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

export function computeEstimatedNftFeeLythoshi(
  fee: FeeSuggestion | null,
): bigint | null {
  if (!fee) return null;
  return computeNativeFeeFromPrice(feeSuggestionToNftPriceInput(fee));
}

function feeSuggestionToNftPriceInput(fee: FeeSuggestion): NativeFeeFromPriceInput {
  return {
    executionUnitLimitHex: SEND_NFT_EXECUTION_UNIT_LIMIT_HEX,
    pricePerExecutionUnitLythoshiHex: fee.maxPricePerExecutionUnitLythoshiHex,
    ...(fee.structuredFee !== undefined ? { structuredFee: fee.structuredFee } : {}),
  };
}

// ---------------------------------------------------------------------------
// Inline styles
// ---------------------------------------------------------------------------

const input: CSSProperties = {
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid var(--fg-700)",
  background: "rgba(0,0,0,0.3)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-mono)",
  fontSize: 12.5,
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

const errText: CSSProperties = {
  fontSize: 11,
  color: "var(--err)",
  fontFamily: "var(--f-mono)",
  marginTop: 4,
};

const errBlock: CSSProperties = {
  padding: "12px 14px",
  borderRadius: 10,
  background: "rgba(220,80,80,0.08)",
  border: "1px solid rgba(220,80,80,0.4)",
  color: "var(--fg-100)",
  fontSize: 12,
  lineHeight: 1.5,
};

const hashBlock: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 12,
  lineHeight: 1.5,
  color: "var(--fg-100)",
  padding: "10px 12px",
  borderRadius: 10,
  background: "rgba(0,0,0,0.3)",
  border: "1px solid var(--fg-700)",
  wordBreak: "break-all",
  userSelect: "all",
};

const btn1: CSSProperties = {
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid rgba(124,127,255,0.6)",
  background: "rgba(124,127,255,0.18)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-sans)",
  fontSize: 12.5,
  fontWeight: 600,
  cursor: "pointer",
};

const btn2: CSSProperties = {
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid var(--fg-700)",
  background: "transparent",
  color: "var(--fg-100)",
  fontFamily: "var(--f-sans)",
  fontSize: 12.5,
  cursor: "pointer",
};

const btnD: CSSProperties = {
  background: "rgba(124,127,255,0.06)",
  color: "var(--fg-500)",
  cursor: "not-allowed",
};
