// Send page — full sub-state machine: form → preview → sending → (success | error).
//
// Commit H lands the form sub-state with Paste / Max / Slow-Normal-Fast tiers
// + the lifted helpers from the previous components.tsx Send. Preview, sending,
// success, and error sub-states land in Commit I.
//
// Wire format: the SW takes `{ to, valueWeiHex, chainIdHex }` and handles the
// encrypted-envelope path on Sprintnet (whitepaper §22). Everything below is
// just shaping that call.

import type { ReactNode, CSSProperties } from "react";
import { useEffect, useState } from "react";
import { Icon, shortAddr } from "../Icon";
import {
  bgWalletBalance,
  bgWalletFeeSuggestion,
  bgWalletSendTx,
  type FeeSuggestion,
} from "../bg";
import type { Account } from "../demo-data";
import { addressToBech32m, bech32mToAddress } from "../../shared/bech32m";

interface SendProps {
  account: Account;
  /** Active chain id (hex). Source of truth for the tx broadcast and the
   *  fee-suggestion fetch. */
  chainId: string;
  onBack: () => void;
}

type Step = "form" | "preview" | "sending" | "success" | "error";

type FeeTier = "slow" | "normal" | "fast";

const TIER_MULTIPLIERS: Record<FeeTier, number> = {
  slow: 0.5,
  normal: 1,
  fast: 2,
};

const TIER_LABELS: Record<FeeTier, string> = {
  slow: "Slow",
  normal: "Normal",
  fast: "Fast",
};

const ADMISSION_REJECT_CODE_LO = -32049;
const ADMISSION_REJECT_CODE_HI = -32020;

// Fallback gas limit for native LYTH transfer when the chain doesn't supply
// one (Sprintnet always returns 21000+ via wallet-fee-suggestion, but other
// chains may omit it). Hex.
const FALLBACK_TRANSFER_GAS_LIMIT_HEX = "0x5208"; // 21000

export function Send({ account, chainId, onBack }: SendProps) {
  const [step, setStep] = useState<Step>("form");

  // Form state — single source of truth so preview and "Try again" can
  // round-trip without prop drilling.
  const [to, setTo] = useState("");
  const [amountStr, setAmountStr] = useState("");
  const [tier, setTier] = useState<FeeTier>("normal");

  // External data the form depends on.
  const [feeSuggestion, setFeeSuggestion] = useState<FeeSuggestion | null>(null);
  const [feeError, setFeeError] = useState<string | null>(null);
  const [balanceWei, setBalanceWei] = useState<bigint | null>(null);

  // Result state — written by handleConfirm.
  const [txHash, setTxHash] = useState<string | null>(null);
  const [hashCopied, setHashCopied] = useState(false);
  const [submitError, setSubmitError] = useState<{
    message: string;
    code: number | null;
  } | null>(null);

  // Fetch fee suggestion when the screen opens or the chain changes.
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

  // Fetch the unlocked account's balance in wei so Max can be exact.
  useEffect(() => {
    if (!account.addr.startsWith("0x")) return;
    let cancelled = false;
    void (async () => {
      const r = await bgWalletBalance(account.addr, chainId);
      if (cancelled) return;
      if (!r.ok) return;
      try {
        setBalanceWei(BigInt(r.balanceHex));
      } catch {
        // Malformed hex — leave null; "Max" stays disabled.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account.addr, chainId]);

  const tierMultiplier = TIER_MULTIPLIERS[tier];
  const estimatedFeeWei = computeEstimatedFeeWei(feeSuggestion, tierMultiplier);

  const parsedRecipient = validateToAddress(to);
  const amountError = validateAmount(amountStr);
  const amountWei = amountError === null && amountStr.length > 0
    ? safeLythToWeiBigInt(amountStr)
    : null;

  // Continue is enabled iff: recipient + amount validate, fee loaded, and
  // (amount + fee) <= balance. If balance hasn't loaded we can't safely
  // gate, so we allow the user through with a warning hint instead of
  // silently blocking — the SW would surface insufficient-funds on send.
  const insufficientFunds =
    amountWei !== null &&
    estimatedFeeWei !== null &&
    balanceWei !== null &&
    amountWei + estimatedFeeWei > balanceWei;

  const canContinue =
    parsedRecipient.addr0x !== null &&
    amountError === null &&
    amountStr.length > 0 &&
    parseFloat(amountStr) > 0 &&
    feeSuggestion !== null &&
    !insufficientFunds;

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      setTo(text.trim());
    } catch {
      // Clipboard read can fail without permission; stay quiet.
    }
  };

  const handleMax = () => {
    if (balanceWei === null || estimatedFeeWei === null) return;
    const maxWei = balanceWei - estimatedFeeWei;
    if (maxWei <= 0n) {
      setAmountStr("0");
      return;
    }
    setAmountStr(weiToLythString(maxWei));
  };

  const handleContinue = () => {
    if (!canContinue) return;
    setStep("preview");
  };

  const handleConfirm = async () => {
    if (amountWei === null) return;
    if (parsedRecipient.addr0x === null) return; // form button is gated; defensive
    setStep("sending");
    setSubmitError(null);
    setTxHash(null);
    try {
      const valueWeiHex = "0x" + amountWei.toString(16);
      const r = await bgWalletSendTx({
        to: parsedRecipient.addr0x,
        valueWeiHex,
        chainIdHex: chainId,
      });
      if (r.ok) {
        setTxHash(r.result.txHash);
        setStep("success");
      } else {
        setSubmitError({
          message: r.reason ?? "send failed",
          code: typeof r.code === "number" ? r.code : null,
        });
        setStep("error");
      }
    } catch (e) {
      setSubmitError({
        message: (e as Error).message ?? "send failed",
        code: null,
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
      // Clipboard write can fail in iframes / focus-loss races. Stay quiet.
    }
  };

  // ---- render ----

  if (step === "preview") {
    return (
      <PreviewView
        to={parsedRecipient.addr0x ?? to}
        amountWei={amountWei}
        estimatedFeeWei={estimatedFeeWei}
        tier={tier}
        fromAddr={account.addr}
        onConfirm={() => void handleConfirm()}
        onBack={() => setStep("form")}
      />
    );
  }

  if (step === "sending") {
    return <SendingView />;
  }

  if (step === "success" && txHash !== null) {
    return (
      <SuccessView
        txHash={txHash}
        copied={hashCopied}
        onCopy={() => void handleCopyHash()}
        onDone={onBack}
      />
    );
  }

  if (step === "error" && submitError !== null) {
    return (
      <ErrorView
        message={submitError.message}
        code={submitError.code}
        onRetry={() => {
          setSubmitError(null);
          setStep("form");
        }}
        onCancel={onBack}
      />
    );
  }

  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div
          style={{ flex: 1, fontSize: 13, fontWeight: 600, textAlign: "center" }}
        >
          Send
        </div>
        <div style={{ width: 28 }} />
      </div>

      <div className="ext-body">
        <FormCard label="Recipient">
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              value={to}
              onChange={(e) => setTo(e.target.value.trim())}
              placeholder="0x… or mono1…"
              spellCheck={false}
              autoComplete="off"
              style={{ ...addressInputStyle, flex: 1 }}
            />
            <button
              onClick={() => void handlePaste()}
              style={inlineButton}
              type="button"
            >
              Paste
            </button>
          </div>
          {parsedRecipient.error && (
            <div style={inlineError}>{parsedRecipient.error}</div>
          )}
          {parsedRecipient.inputForm === "0x" && parsedRecipient.bech && (
            <div style={dualFormatHint}>
              Mono form: {parsedRecipient.bech}
            </div>
          )}
          {parsedRecipient.inputForm === "mono1" && parsedRecipient.addr0x && (
            <div style={dualFormatHint}>
              Will send to: {middleTruncate(parsedRecipient.addr0x, 10, 8)}
            </div>
          )}
        </FormCard>

        <FormCard label="Amount">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="text"
              value={amountStr}
              onChange={(e) => setAmountStr(e.target.value.trim())}
              placeholder="0.0"
              inputMode="decimal"
              style={{ ...addressInputStyle, flex: 1 }}
            />
            <button
              onClick={handleMax}
              disabled={balanceWei === null || estimatedFeeWei === null}
              style={{
                ...inlineButton,
                opacity:
                  balanceWei === null || estimatedFeeWei === null ? 0.5 : 1,
              }}
              type="button"
            >
              Max
            </button>
            <div
              style={{
                fontFamily: "var(--f-mono)",
                fontSize: 11,
                color: "var(--fg-400)",
              }}
            >
              LYTH
            </div>
          </div>
          {amountError && <div style={inlineError}>{amountError}</div>}
          {!amountError && insufficientFunds && (
            <div style={inlineError}>
              Amount + fee exceeds balance.
            </div>
          )}
          <div style={fromHint}>
            from: {shortAddr(account.addr, 18)}
            {balanceWei !== null && (
              <>
                {" · balance: "}
                <span style={{ fontFamily: "var(--f-mono)" }}>
                  {weiToLythString(balanceWei)} LYTH
                </span>
              </>
            )}
          </div>
        </FormCard>

        <FormCard label="Network fee">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: 6,
              marginTop: 4,
            }}
          >
            {(Object.keys(TIER_MULTIPLIERS) as FeeTier[]).map((t) => {
              const active = t === tier;
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTier(t)}
                  style={{
                    padding: "8px 4px",
                    borderRadius: 8,
                    border: active
                      ? "1px solid var(--gold)"
                      : "1px solid var(--fg-700)",
                    background: active
                      ? "var(--gold-bg)"
                      : "rgba(255,255,255,0.04)",
                    color: active ? "var(--gold)" : "var(--fg-100)",
                    fontFamily: "var(--f-sans)",
                    fontSize: 12,
                    fontWeight: active ? 600 : 500,
                    cursor: "pointer",
                  }}
                >
                  {TIER_LABELS[t]}
                </button>
              );
            })}
          </div>
          {feeError ? (
            <div style={{ ...inlineError, marginTop: 8 }}>
              Could not fetch fee: {feeError}
            </div>
          ) : feeSuggestion === null ? (
            <div
              style={{ fontSize: 12, color: "var(--fg-400)", marginTop: 8 }}
            >
              Loading fee…
            </div>
          ) : (
            <div
              style={{
                fontSize: 11.5,
                color: "var(--fg-300)",
                lineHeight: 1.6,
                marginTop: 10,
              }}
            >
              <div>
                Tip:{" "}
                <span style={{ fontFamily: "var(--f-mono)" }}>
                  {scaleGwei(
                    feeSuggestion.maxPriorityFeePerGas,
                    tierMultiplier,
                  )}{" "}
                  gwei
                </span>{" "}
                <span style={{ color: "var(--fg-500)" }}>
                  ({TIER_LABELS[tier]} · {tierMultiplier}×)
                </span>
              </div>
              <div>
                Base fee:{" "}
                <span style={{ fontFamily: "var(--f-mono)" }}>
                  {formatGweiFromHex(feeSuggestion.baseFeePerGas)} gwei
                </span>
              </div>
              <div style={{ color: "var(--fg-200)", marginTop: 4 }}>
                Estimated fee:{" "}
                <span style={{ fontFamily: "var(--f-mono)" }}>
                  {estimatedFeeWei !== null
                    ? `${weiToLythString(estimatedFeeWei)} LYTH`
                    : "—"}
                </span>
              </div>
            </div>
          )}
        </FormCard>

        <button
          className="ext-act prim"
          onClick={handleContinue}
          disabled={!canContinue}
          style={{
            width: "100%",
            padding: "12px",
            flexDirection: "row",
            gap: 8,
            opacity: canContinue ? 1 : 0.5,
            cursor: canContinue ? "pointer" : "default",
          }}
        >
          Continue
        </button>
      </div>
    </>
  );
}

// ---- form layout helpers ----

interface FormCardProps {
  label: string;
  children: ReactNode;
}

function FormCard({ label, children }: FormCardProps) {
  return (
    <div className="ext-card" style={{ padding: 14 }}>
      <div style={cardLabel}>{label}</div>
      <div style={{ marginTop: 8 }}>{children}</div>
    </div>
  );
}

const cardLabel: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 10,
  color: "var(--fg-400)",
  letterSpacing: "0.14em",
  textTransform: "uppercase",
};

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

const inlineButton: CSSProperties = {
  padding: "8px 12px",
  borderRadius: 10,
  border: "1px solid var(--fg-700)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-sans)",
  fontSize: 11,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const inlineError: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 10,
  color: "var(--err)",
  marginTop: 6,
};

const dualFormatHint: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 10,
  color: "var(--fg-400)",
  marginTop: 6,
  wordBreak: "break-all",
};

const fromHint: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 10,
  color: "var(--fg-500)",
  marginTop: 8,
};

// ---- validation ----

/**
 * Recipient input parser. Accepts both 0x hex and bech32m (mono1…) per
 * whitepaper §22.7. The IPC contract stays 0x-only; the popup is the
 * codec boundary. Empty / partial input returns no error so the form
 * stays quiet while the user is still typing.
 */
export interface RecipientParse {
  /** Human-readable error to surface under the input. null = no error. */
  error: string | null;
  /** Canonical 0x lowercase form, used for IPC. null when input is invalid
   *  or incomplete. */
  addr0x: string | null;
  /** Canonical bech32m form, used for the dual-format hint. null when
   *  input is invalid or incomplete. */
  bech: string | null;
  /** Which input shape the user is in:
   *   - "empty": input is empty
   *   - "partial": prefix matches but length is short of canonical (still typing)
   *   - "0x": complete 0x form (valid or invalid)
   *   - "mono1": complete bech32m form (valid or invalid)
   *   - "unknown": prefix doesn't match either shape */
  inputForm: "empty" | "partial" | "0x" | "mono1" | "unknown";
}

export function validateToAddress(s: string): RecipientParse {
  if (s.length === 0) {
    return { error: null, addr0x: null, bech: null, inputForm: "empty" };
  }
  // 0x branch
  if (s.startsWith("0x") || s.startsWith("0X")) {
    if (s.length < 42) {
      return { error: null, addr0x: null, bech: null, inputForm: "partial" };
    }
    if (s.length !== 42) {
      return {
        error: `address must be 42 chars (got ${s.length})`,
        addr0x: null,
        bech: null,
        inputForm: "0x",
      };
    }
    if (!/^0[xX][0-9a-fA-F]{40}$/.test(s)) {
      return {
        error: "address must be 0x + 40 hex chars",
        addr0x: null,
        bech: null,
        inputForm: "0x",
      };
    }
    const addr0x = s.toLowerCase();
    let bech: string | null;
    try {
      bech = addressToBech32m(addr0x);
    } catch {
      bech = null;
    }
    return { error: null, addr0x, bech, inputForm: "0x" };
  }
  // mono1 branch — accept both lowercase and all-uppercase per BIP-350.
  // The codec rejects mixed-case; we let it surface that as the error.
  // A 20-byte payload encodes to exactly 43 chars: 4 HRP + 1 separator +
  // 32 data + 6 checksum. Anything shorter is "still typing" (no error).
  if (s.startsWith("mono1") || s.startsWith("MONO1")) {
    if (s.length < 43) {
      return { error: null, addr0x: null, bech: null, inputForm: "partial" };
    }
    try {
      const addr0x = bech32mToAddress(s);
      return {
        error: null,
        addr0x: addr0x.toLowerCase(),
        bech: s.toLowerCase(),
        inputForm: "mono1",
      };
    } catch (e) {
      return {
        error: (e as Error).message ?? "invalid mono1 address",
        addr0x: null,
        bech: null,
        inputForm: "mono1",
      };
    }
  }
  return {
    error: "address must start with 0x or mono1",
    addr0x: null,
    bech: null,
    inputForm: "unknown",
  };
}

/** Middle-truncate a string keeping `head` leading chars and `tail` trailing
 *  chars with an ellipsis in between. Used by the dual-format hint to fit
 *  long 0x forms into the popup's narrow column. */
function middleTruncate(s: string, head: number, tail: number): string {
  if (s.length <= head + tail + 1) return s;
  return s.slice(0, head) + "…" + s.slice(-tail);
}

export function validateAmount(s: string): string | null {
  if (s.length === 0) return null;
  if (!/^\d+(\.\d+)?$/.test(s)) return "amount must be a positive decimal";
  if (parseFloat(s) <= 0) return "amount must be greater than 0";
  const dot = s.indexOf(".");
  if (dot >= 0 && s.length - dot - 1 > 18) {
    return "amount cannot have more than 18 decimal places";
  }
  return null;
}

// ---- amount conversion ----

/**
 * Convert a decimal LYTH amount string to wei (`0x` hex). Precision-safe —
 * splits on `.` and builds the BigInt from integer + zero-padded fractional
 * parts so `0.000000000000000001` (1 wei) round-trips exactly. Throws on
 * invalid input; callers should pre-validate via `validateAmount`.
 */
export function lythToWeiHex(amountStr: string): string {
  return "0x" + safeLythToWeiBigInt(amountStr).toString(16);
}

function safeLythToWeiBigInt(amountStr: string): bigint {
  const dot = amountStr.indexOf(".");
  const intPart = dot < 0 ? amountStr : amountStr.slice(0, dot);
  const fracPartRaw = dot < 0 ? "" : amountStr.slice(dot + 1);
  if (fracPartRaw.length > 18) {
    throw new Error("amount has more than 18 decimal places");
  }
  const fracPadded = (fracPartRaw + "0".repeat(18)).slice(0, 18);
  const intBig = BigInt(intPart === "" ? "0" : intPart);
  const fracBig = BigInt(fracPadded === "" ? "0" : fracPadded);
  return intBig * 10n ** 18n + fracBig;
}

/** wei → decimal LYTH string, trimming trailing zeros and the decimal point.
 *
 *  Re-exported at the bottom of this file. The byte-equality golden test
 *  in src/background/wei-decimal.test.ts pairs this helper with the SW's
 *  weiHexToLythDecimal — both must produce byte-identical strings or the
 *  reconcilePending heuristic match in shared/activity.ts fails silently. */
function weiToLythString(wei: bigint): string {
  if (wei < 0n) return "0";
  const intPart = wei / 10n ** 18n;
  const fracPart = wei % 10n ** 18n;
  if (fracPart === 0n) return intPart.toString();
  const fracStr = fracPart.toString().padStart(18, "0").replace(/0+$/, "");
  return fracStr.length === 0
    ? intPart.toString()
    : `${intPart.toString()}.${fracStr}`;
}

// ---- gwei display ----

/** Format a hex wei value as a gwei display string. */
function formatGweiFromHex(weiHex: string): string {
  let wei: bigint;
  try {
    wei = BigInt(weiHex);
  } catch {
    return "?";
  }
  return formatGwei(wei);
}

function formatGwei(wei: bigint): string {
  const gwei = wei / 10n ** 9n;
  const remainder = wei % 10n ** 9n;
  if (remainder === 0n) return gwei.toString();
  const fracStr = remainder.toString().padStart(9, "0").replace(/0+$/, "");
  return fracStr.length === 0 ? gwei.toString() : `${gwei}.${fracStr}`;
}

/** Multiply a hex wei tip by a tier multiplier and format the result as
 *  gwei. Multiplier comes from a small fixed set so we widen to BigInt by
 *  scaling to milli-multiplier units. */
function scaleGwei(weiHex: string, multiplier: number): string {
  let wei: bigint;
  try {
    wei = BigInt(weiHex);
  } catch {
    return "?";
  }
  const milli = BigInt(Math.round(multiplier * 1000));
  return formatGwei((wei * milli) / 1000n);
}

// ---- fee math ----

function computeEstimatedFeeWei(
  fee: FeeSuggestion | null,
  multiplier: number,
): bigint | null {
  if (!fee) return null;
  let priority: bigint;
  let base: bigint;
  let gas: bigint;
  try {
    priority = BigInt(fee.maxPriorityFeePerGas);
    base = BigInt(fee.baseFeePerGas);
    gas = BigInt(fee.gasLimit ?? FALLBACK_TRANSFER_GAS_LIMIT_HEX);
  } catch {
    return null;
  }
  const milli = BigInt(Math.round(multiplier * 1000));
  const scaledPriority = (priority * milli) / 1000n;
  return (scaledPriority + base) * gas;
}

// ---- preview / sending / success / error sub-state views ----

interface PreviewViewProps {
  to: string;
  amountWei: bigint | null;
  estimatedFeeWei: bigint | null;
  tier: FeeTier;
  fromAddr: string;
  onConfirm: () => void;
  onBack: () => void;
}

function PreviewView({
  to,
  amountWei,
  estimatedFeeWei,
  tier,
  fromAddr,
  onConfirm,
  onBack,
}: PreviewViewProps) {
  const total = amountWei !== null && estimatedFeeWei !== null
    ? amountWei + estimatedFeeWei
    : null;
  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div
          style={{ flex: 1, fontSize: 13, fontWeight: 600, textAlign: "center" }}
        >
          Review send
        </div>
        <div style={{ width: 28 }} />
      </div>

      <div className="ext-body">
        <div className="ext-card" style={{ padding: 14 }}>
          <SummaryRow label="From" value={shortAddr(fromAddr, 18)} mono />
          <SummaryRow label="To" value={shortAddr(to, 18)} mono />
          <SummaryRow
            label="Amount"
            value={amountWei !== null ? `${weiToLythString(amountWei)} LYTH` : "—"}
            mono
          />
          <SummaryRow
            label={`Fee (${TIER_LABELS[tier]})`}
            value={
              estimatedFeeWei !== null
                ? `${weiToLythString(estimatedFeeWei)} LYTH`
                : "—"
            }
            mono
          />
          <div
            style={{
              marginTop: 8,
              paddingTop: 10,
              borderTop: "1px solid var(--fg-700)",
            }}
          >
            <SummaryRow
              label="Total"
              value={total !== null ? `${weiToLythString(total)} LYTH` : "—"}
              mono
              emphasis
            />
          </div>
        </div>

        <div
          className="ext-card"
          style={{
            padding: "10px 12px",
            background: "rgba(242,180,65,0.08)",
            border: "1px solid rgba(242,180,65,0.4)",
          }}
        >
          <div style={{ fontSize: 12, lineHeight: 1.5, color: "var(--fg-100)" }}>
            Transactions are irreversible. Confirm the recipient and amount
            carefully.
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 8,
          }}
        >
          <button
            className="ext-act"
            onClick={onBack}
            style={{
              padding: "12px",
              flexDirection: "row",
              gap: 8,
            }}
          >
            Back
          </button>
          <button
            className="ext-act prim"
            onClick={onConfirm}
            style={{
              padding: "12px",
              flexDirection: "row",
              gap: 8,
            }}
          >
            Confirm
          </button>
        </div>
      </div>
    </>
  );
}

interface SummaryRowProps {
  label: string;
  value: string;
  mono?: boolean;
  emphasis?: boolean;
}

function SummaryRow({ label, value, mono, emphasis }: SummaryRowProps) {
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
          fontFamily: mono ? "var(--f-mono)" : "var(--f-sans)",
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

function SendingView() {
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
          animation: "monoSendSpin 0.9s linear infinite",
        }}
        aria-hidden="true"
      />
      <div style={{ fontSize: 13, color: "var(--fg-200)" }}>
        Sending transaction…
      </div>
      <style>{`@keyframes monoSendSpin { to { transform: rotate(360deg); } }`}</style>
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
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onDone} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div
          style={{ flex: 1, fontSize: 13, fontWeight: 600, textAlign: "center" }}
        >
          Transaction sent
        </div>
        <div style={{ width: 28 }} />
      </div>

      <div className="ext-body">
        <div style={{ textAlign: "center", padding: "20px 0 8px" }}>
          <div
            style={{
              width: 56,
              height: 56,
              margin: "0 auto 12px",
              display: "grid",
              placeItems: "center",
              borderRadius: "50%",
              background: "rgba(80,200,120,0.12)",
              border: "1px solid rgba(80,200,120,0.4)",
              color: "var(--ok)",
              fontSize: 28,
            }}
            aria-hidden="true"
          >
            ✓
          </div>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "var(--fg-100)",
            }}
          >
            Transaction submitted
          </div>
        </div>

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
            Transaction hash
          </div>
          <div
            style={{
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
            }}
          >
            {txHash}
          </div>
          <button
            className="ext-act"
            onClick={onCopy}
            style={{
              width: "100%",
              padding: "10px",
              flexDirection: "row",
              gap: 8,
              marginTop: 12,
            }}
          >
            {copied ? "Copied" : "Copy tx hash"}
          </button>
          <div
            style={{
              fontSize: 11,
              color: "var(--fg-400)",
              marginTop: 10,
              lineHeight: 1.5,
            }}
          >
            Explorer URL not yet wired for Sprintnet — keep this hash to
            track the tx on an operator directly.
          </div>
        </div>

        <button
          className="ext-act prim"
          onClick={onDone}
          style={{
            width: "100%",
            padding: "12px",
            flexDirection: "row",
            gap: 8,
          }}
        >
          Done
        </button>
      </div>
    </>
  );
}

interface ErrorViewProps {
  message: string;
  code: number | null;
  onRetry: () => void;
  onCancel: () => void;
}

function ErrorView({ message, code, onRetry, onCancel }: ErrorViewProps) {
  const isAdmissionReject =
    code !== null &&
    code >= ADMISSION_REJECT_CODE_LO &&
    code <= ADMISSION_REJECT_CODE_HI;
  const display = isAdmissionReject ? `Chain rejected: ${message}` : message;
  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onCancel} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div
          style={{ flex: 1, fontSize: 13, fontWeight: 600, textAlign: "center" }}
        >
          Transaction failed
        </div>
        <div style={{ width: 28 }} />
      </div>

      <div className="ext-body">
        <div style={{ textAlign: "center", padding: "20px 0 8px" }}>
          <div
            style={{
              width: 56,
              height: 56,
              margin: "0 auto 12px",
              display: "grid",
              placeItems: "center",
              borderRadius: "50%",
              background: "rgba(220,80,80,0.12)",
              border: "1px solid rgba(220,80,80,0.4)",
              color: "var(--err)",
              fontSize: 28,
            }}
            aria-hidden="true"
          >
            ✕
          </div>
        </div>

        <div
          className="ext-card"
          style={{
            padding: "12px 14px",
            background: "rgba(220,80,80,0.08)",
            border: "1px solid rgba(220,80,80,0.4)",
          }}
        >
          <div style={{ fontSize: 12.5, lineHeight: 1.5, color: "var(--fg-100)" }}>
            {display}
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 8,
          }}
        >
          <button
            className="ext-act"
            onClick={onCancel}
            style={{
              padding: "12px",
              flexDirection: "row",
              gap: 8,
            }}
          >
            Cancel
          </button>
          <button
            className="ext-act prim"
            onClick={onRetry}
            style={{
              padding: "12px",
              flexDirection: "row",
              gap: 8,
            }}
          >
            Try again
          </button>
        </div>
      </div>
    </>
  );
}

// ---- shared exports ----

export {
  ADMISSION_REJECT_CODE_LO,
  ADMISSION_REJECT_CODE_HI,
  TIER_LABELS,
  computeEstimatedFeeWei,
  weiToLythString,
};
