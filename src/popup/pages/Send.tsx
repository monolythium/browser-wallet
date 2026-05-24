// Send page — full sub-state machine: form → preview → sending → (success | error).
//
// Commit H lands the form sub-state with Paste / Max / Slow-Normal-Fast tiers
// + the lifted helpers from the previous components.tsx Send. Preview, sending,
// success, and error sub-states land in Commit I.
//
// Wire format: the SW still names the value field `valueWeiHex` at the IPC
// compatibility boundary. Inside this Send page, native LYTH amounts are
// handled as 8-decimal lythoshi per v4.1.

import type { ReactNode, CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import { Icon, shortAddr } from "../Icon";
import {
  bgMultisigPropose,
  bgPasskeyEvaluate,
  bgPasskeyRecordUsage,
  bgPreviewTransactionHooks,
  bgWalletBalance,
  bgWalletFeeSuggestion,
  bgWalletSendTx,
  type BgPasskeyDecision,
  type FeeSuggestion,
  type PreviewTransactionHooksOutcome,
} from "../bg";
import type { TransactionHookPreview } from "../../shared/audit-followup-types";
import { PasskeySignModal } from "../components/PasskeySignModal";
import { keccak_256 } from "@noble/hashes/sha3.js";
import type { Account } from "../demo-data";
import { addressToBech32m, bech32mToAddress } from "../../shared/bech32m";
import { classifyAddressInput } from "../../shared/bech32m-typo-detect";
import { classifySendError } from "../../shared/send-error";
import {
  STORAGE_KEY_NAME_CACHE,
  lookupNameInCache,
  parseMonoName,
  validateNameCache,
  type MonoNameParse,
  type NameCache,
} from "../../shared/name-resolution";
import {
  activityCacheKey,
  activityPendingKey,
  type ActivityCache,
  type PendingActivityCache,
} from "../../shared/activity";
import {
  FEE_MULTIPLIER_BPS_BASE,
  LYTHOSHI_PER_LYTH,
  NATIVE_LYTH_DECIMALS,
  computeNativeFeeFromBaseAndPriority,
  formatExecutionUnits,
  formatLythoshiPerExecutionUnit,
  formatNativeLythAmount,
  lythoshiToLythString,
  nativeFeeDisplayFromFeeSuggestion,
  parseNativeHexQuantity,
  scaleByBps,
} from "../../shared/native-fee-display";

interface SendProps {
  account: Account;
  /** Active chain id (hex). Source of truth for the tx broadcast and the
   *  fee-suggestion fetch. */
  chainId: string;
  onBack: () => void;
  /** Phase 8 — when set, the active vault is a multisig vault and Send
   *  routes the submit to `bgMultisigPropose` instead of `bgWalletSendTx`.
   *  The form layout stays the same; only the CTA copy + submit path
   *  change. The App-side detection (read `kind === "multisig"` from
   *  the vault summary) lands in Commit 6; absent prop = unchanged
   *  single-vault behavior. */
  multisigVaultId?: string;
  /** Phase 9 — when set (and `multisigVaultId` is NOT set), Send
   *  consults the per-vault passkey policy and shows the appropriate
   *  unlock-mode badge on the preview screen. Below-limit txs that
   *  evaluate to `passkey-ok` trigger the WebAuthn ceremony on
   *  Confirm; over-limit / password-required txs proceed as today.
   *  Absent prop = unchanged behavior (no policy consultation). */
  singleVaultId?: string;
}

type Step = "form" | "preview" | "sending" | "success" | "error";

type FeeTier = "slow" | "normal" | "fast";

const TIER_MULTIPLIERS_BPS: Record<FeeTier, bigint> = {
  slow: 5_000n,
  normal: FEE_MULTIPLIER_BPS_BASE,
  fast: 20_000n,
};

const TIER_MULTIPLIER_TEXT: Record<FeeTier, string> = {
  slow: "0.5",
  normal: "1",
  fast: "2",
};

const TIER_LABELS: Record<FeeTier, string> = {
  slow: "Slow",
  normal: "Normal",
  fast: "Fast",
};

const ADMISSION_REJECT_CODE_LO = -32049;
const ADMISSION_REJECT_CODE_HI = -32020;

// Fallback execution-unit limit for native LYTH transfer when the chain
// doesn't supply one. The fee-suggestion IPC field is still named `gasLimit`
// for compatibility with the background service worker.
const FALLBACK_TRANSFER_EXECUTION_UNITS_HEX = "0x5208"; // 21000

export function Send({
  account,
  chainId,
  onBack,
  multisigVaultId,
  singleVaultId,
}: SendProps) {
  const [step, setStep] = useState<Step>("form");
  const [passkeyDecision, setPasskeyDecision] = useState<BgPasskeyDecision | null>(null);
  const [passkeyModalOpen, setPasskeyModalOpen] = useState(false);

  // Form state — single source of truth so preview and "Try again" can
  // round-trip without prop drilling.
  const [to, setTo] = useState("");
  const [amountStr, setAmountStr] = useState("");
  const [tier, setTier] = useState<FeeTier>("normal");

  // External data the form depends on.
  const [feeSuggestion, setFeeSuggestion] = useState<FeeSuggestion | null>(null);
  const [feeError, setFeeError] = useState<string | null>(null);
  const [balanceLythoshi, setBalanceLythoshi] = useState<bigint | null>(null);

  // Result state — written by handleConfirm.
  const [txHash, setTxHash] = useState<string | null>(null);
  const [hashCopied, setHashCopied] = useState(false);
  const [submitError, setSubmitError] = useState<{
    message: string;
    code: number | null;
    method: string | null;
    via: string | null;
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

  // Fetch the unlocked account's balance in native lythoshi so Max can be exact.
  useEffect(() => {
    if (!account.addr.startsWith("0x")) return;
    let cancelled = false;
    void (async () => {
      const r = await bgWalletBalance(account.addr, chainId);
      if (cancelled) return;
      if (!r.ok) return;
      try {
        setBalanceLythoshi(BigInt(r.balanceHex));
      } catch {
        // Malformed hex — leave null; "Max" stays disabled.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account.addr, chainId]);

  const tierMultiplierBps = TIER_MULTIPLIERS_BPS[tier];
  const estimatedFeeResult = useMemo(
    () =>
      feeSuggestion === null
        ? null
        : nativeFeeDisplayFromFeeSuggestion(feeSuggestion, {
            fallbackExecutionUnitsHex: FALLBACK_TRANSFER_EXECUTION_UNITS_HEX,
            priorityMultiplierBps: tierMultiplierBps,
          }),
    [feeSuggestion, tierMultiplierBps],
  );
  const estimatedFeeDisplay =
    estimatedFeeResult?.ok === true ? estimatedFeeResult.display : null;
  const feeDisplayError =
    estimatedFeeResult !== null && estimatedFeeResult.ok === false
      ? estimatedFeeResult.failures.join("; ")
      : null;
  const estimatedFeeLythoshi = estimatedFeeDisplay?.totalLythoshi ?? null;

  const parsedRecipient = useMemo(() => validateToAddress(to), [to]);
  const nameResolution = useNameForwardResolve(parsedRecipient.monoName);
  const effectiveAddr0x =
    parsedRecipient.addr0x ?? nameResolution.addr0x ?? null;

  const recipientFamiliarity = useRecipientFamiliarity(
    effectiveAddr0x,
    account.addr,
    chainId,
  );

  const amountError = validateAmount(amountStr);
  const amountLythoshi = amountError === null && amountStr.length > 0
    ? safeLythToLythoshiBigInt(amountStr)
    : null;

  // Continue is enabled iff: recipient + amount validate, fee loaded, and
  // (amount + fee) <= balance. If balance hasn't loaded we can't safely
  // gate, so we allow the user through with a warning hint instead of
  // silently blocking — the SW would surface insufficient-funds on send.
  const insufficientFunds =
    amountLythoshi !== null &&
    estimatedFeeLythoshi !== null &&
    balanceLythoshi !== null &&
    amountLythoshi + estimatedFeeLythoshi > balanceLythoshi;

  const canContinue =
    effectiveAddr0x !== null &&
    amountError === null &&
    amountStr.length > 0 &&
    parseFloat(amountStr) > 0 &&
    estimatedFeeLythoshi !== null &&
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
    if (balanceLythoshi === null || estimatedFeeLythoshi === null) return;
    const maxLythoshi = balanceLythoshi - estimatedFeeLythoshi;
    if (maxLythoshi <= 0n) {
      setAmountStr("0");
      return;
    }
    setAmountStr(lythoshiToLythString(maxLythoshi));
  };

  const handleContinue = async () => {
    if (!canContinue) return;
    // Consult the passkey policy when this is a single-vault send. The
    // decision drives the preview screen's unlock-mode badge + the
    // post-Confirm path (passkey ceremony vs straight submit). Multisig
    // sends skip this — the proposal flow doesn't need a per-tx
    // signing-mode badge.
    if (
      singleVaultId !== undefined &&
      multisigVaultId === undefined &&
      amountLythoshi !== null
    ) {
      const r = await bgPasskeyEvaluate({
        vaultId: singleVaultId,
        valueWeiHex: "0x" + amountLythoshi.toString(16),
      });
      setPasskeyDecision(r.ok ? r.decision : null);
    } else {
      setPasskeyDecision(null);
    }
    setStep("preview");
  };

  const handleConfirm = async () => {
    if (amountLythoshi === null) return;
    if (effectiveAddr0x === null) return; // form button is gated; defensive
    setStep("sending");
    setSubmitError(null);
    setTxHash(null);
    try {
      const valueLythoshiHex = "0x" + amountLythoshi.toString(16);
      if (multisigVaultId !== undefined) {
        // Multisig path — create a proposal rather than broadcasting
        // a tx. Other signers approve via the Pending dashboard
        // (Commit 4); once the threshold is reached the executor
        // submits the underlying tx (Commit 4 too).
        const r = await bgMultisigPropose({
          vaultId: multisigVaultId,
          action: {
            kind: "send",
            to: effectiveAddr0x,
            valueWeiHex: valueLythoshiHex,
            chainIdHex: chainId,
          },
        });
        if (r.ok) {
          // Reuse the txHash state slot to carry the proposalId
          // through to the success view — the UI distinguishes via
          // `multisigVaultId !== undefined`. Cleaner separation lands
          // in Commit 6 alongside the dedicated multisig success
          // view + Pending dashboard link.
          setTxHash(r.proposalId);
          setStep("success");
        } else {
          setSubmitError({
            message: r.reason ?? "propose failed",
            code: null,
            method: null,
            via: null,
          });
          setStep("error");
        }
        return;
      }
      const r = await bgWalletSendTx({
        to: effectiveAddr0x,
        valueWeiHex: valueLythoshiHex,
        chainIdHex: chainId,
      });
      if (r.ok) {
        setTxHash(r.result.txHash);
        // Record passkey-unlocked txs against the daily-cap ledger.
        // The SW prunes on read; this fire-and-forget call appends.
        // Only fires when the policy decision was passkey-ok and a
        // passkey assertion succeeded — over-limit / password-required
        // txs do not contribute to the cap.
        if (
          singleVaultId !== undefined &&
          passkeyDecision?.kind === "passkey-ok"
        ) {
          void bgPasskeyRecordUsage({
            vaultId: singleVaultId,
            valueWeiHex: valueLythoshiHex,
          });
        }
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
      // Clipboard write can fail in iframes / focus-loss races. Stay quiet.
    }
  };

  // ---- render ----

  if (step === "preview") {
    const needsPasskey = passkeyDecision?.kind === "passkey-ok";
    const onPreviewConfirm = () => {
      if (needsPasskey) {
        setPasskeyModalOpen(true);
      } else {
        void handleConfirm();
      }
    };

    // Build a stable tx digest for the WebAuthn challenge. Binds the
    // assertion to the specific (to, value, chainId) so a captured
    // assertion cannot be replayed for a different tx via the same
    // wallet. We hash the wire-format strings — close enough for the
    // local-presence-check the wallet uses today; the future
    // chain-side passkey precompile (Phase 9.1) will use the chain's
    // canonical txHash for the same binding.
    const txDigest =
      needsPasskey && effectiveAddr0x !== null && amountLythoshi !== null
        ? keccak_256(
            new TextEncoder().encode(
              `${effectiveAddr0x}|${amountLythoshi.toString(16)}|${chainId}`,
            ),
          )
        : new Uint8Array(32);

    return (
      <>
        <PreviewView
          to={effectiveAddr0x ?? to}
          amountLythoshi={amountLythoshi}
          estimatedFeeLythoshi={estimatedFeeLythoshi}
          tier={tier}
          fromAddr={account.addr}
          onConfirm={onPreviewConfirm}
          onBack={() => setStep("form")}
          isMultisig={multisigVaultId !== undefined}
          passkeyDecision={passkeyDecision}
        />
        {needsPasskey && passkeyDecision?.kind === "passkey-ok" && (
          <PasskeySignModal
            open={passkeyModalOpen}
            vaultAddress={account.addr}
            credentials={passkeyDecision.credentials}
            txDigest={txDigest}
            onCancel={() => setPasskeyModalOpen(false)}
            onSuccess={() => {
              setPasskeyModalOpen(false);
              void handleConfirm();
            }}
          />
        )}
      </>
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
        method={submitError.method}
        via={submitError.via}
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
        {multisigVaultId !== undefined && (
          <div
            style={{
              padding: "8px 10px",
              borderRadius: 8,
              background: "rgba(124,127,255,0.06)",
              border: "1px solid rgba(124,127,255,0.4)",
              color: "var(--fg-100)",
              fontSize: 11.5,
              lineHeight: 1.5,
            }}
          >
            This is a multisig vault — Send creates a proposal that
            co-signers must approve before execution.
          </div>
        )}
        <FormCard label="Recipient">
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              value={to}
              onChange={(e) => setTo(e.target.value.trim())}
              placeholder="0x…, mono1…, or alice.mono"
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
          {/* Phase 11 Commit 7 — bech32m typo suggestion. When the user
              types a mono1... address that fails checksum but a single-
              character substitution produces a valid one, surface the
              candidate as a clickable hint. Click sets it as the new
              recipient input. Conservative: only renders when the
              parser already reported an error AND the typo-detect found
              a clean 1-edit fix. */}
          <BechTypoHint
            to={to}
            hasParseError={!!parsedRecipient.error}
            onApply={(addr) => setTo(addr)}
          />
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
          {parsedRecipient.inputForm === "mono-name" &&
            parsedRecipient.monoName !== null && (
              <MonoNameResolveHint
                parsed={parsedRecipient.monoName}
                resolution={nameResolution}
              />
            )}
          {recipientFamiliarity === "new" && (
            <div
              style={{
                display: "flex",
                gap: 8,
                marginTop: 8,
                padding: "8px 10px",
                borderRadius: 8,
                background: "rgba(244,201,122,0.08)",
                border: "1px solid rgba(244,201,122,0.4)",
                fontSize: 11,
                color: "var(--fg-100)",
                lineHeight: 1.5,
              }}
            >
              <Icon name="warn" size={12} />
              <span>
                <b>First-time recipient.</b> You haven't sent to this address
                from this account before — double-check the destination is
                what you intended.
              </span>
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
              disabled={balanceLythoshi === null || estimatedFeeLythoshi === null}
              style={{
                ...inlineButton,
                opacity:
                  balanceLythoshi === null || estimatedFeeLythoshi === null ? 0.5 : 1,
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
            {balanceLythoshi !== null && (
              <>
                {" · balance: "}
                <span style={{ fontFamily: "var(--f-mono)" }}>
                  {formatNativeLythAmount(balanceLythoshi)}
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
            {(Object.keys(TIER_MULTIPLIERS_BPS) as FeeTier[]).map((t) => {
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
          ) : feeDisplayError !== null ? (
            <div style={{ ...inlineError, marginTop: 8 }}>
              Malformed fee data: {feeDisplayError}
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
              <div style={{ color: "var(--fg-200)" }}>
                Estimated fee:{" "}
                <span style={{ fontFamily: "var(--f-mono)" }}>
                  {estimatedFeeDisplay?.defaultText ?? "—"}
                </span>
              </div>
              <details style={{ marginTop: 4 }}>
                <summary
                  style={{
                    cursor: "pointer",
                    color: "var(--fg-500)",
                    fontFamily: "var(--f-mono)",
                    fontSize: 10.5,
                  }}
                >
                  Low-level compatibility fee details
                </summary>
                {estimatedFeeDisplay?.source === "structured" ? (
                  estimatedFeeDisplay.detailTexts.map((detail) => (
                    <div key={detail} style={{ marginTop: 6 }}>
                      {detail}
                    </div>
                  ))
                ) : (
                  <>
                    <div style={{ marginTop: 6 }}>
                      Priority price:{" "}
                      <span style={{ fontFamily: "var(--f-mono)" }}>
                        {scaleLythoshiPerExecutionUnit(
                          feeSuggestion.maxPriorityFeePerGas,
                          tierMultiplierBps,
                        )}{" "}
                        lythoshi / execution unit
                      </span>{" "}
                      <span style={{ color: "var(--fg-500)" }}>
                        ({TIER_LABELS[tier]} · {TIER_MULTIPLIER_TEXT[tier]}×)
                      </span>
                    </div>
                    <div>
                      Base price:{" "}
                      <span style={{ fontFamily: "var(--f-mono)" }}>
                        {formatLythoshiPerExecutionUnit(feeSuggestion.baseFeePerGas)}{" "}
                        lythoshi / execution unit
                      </span>
                    </div>
                    <div>
                      Execution units:{" "}
                      <span style={{ fontFamily: "var(--f-mono)" }}>
                        {formatExecutionUnits(
                          feeSuggestion.gasLimit ??
                            FALLBACK_TRANSFER_EXECUTION_UNITS_HEX,
                        )}
                      </span>
                    </div>
                  </>
                )}
              </details>
            </div>
          )}
        </FormCard>

        <button
          className="ext-act prim"
          onClick={() => void handleContinue()}
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
 * Recipient input parser. Accepts:
 *   - 0x hex (whitepaper §22.7 wire form)
 *   - bech32m (mono1…, §22.7 display form)
 *   - §22.8 hierarchical names ending in `.mono` (forward-resolved
 *     against the local name cache; no `lyth_resolveName` RPC yet)
 *
 * The IPC contract stays 0x-only; the popup is the codec + name-
 * resolution boundary. Empty / partial input returns no error so the
 * form stays quiet while the user is still typing.
 */
export interface RecipientParse {
  /** Human-readable error to surface under the input. null = no error. */
  error: string | null;
  /** Canonical 0x lowercase form, used for IPC. null when input is invalid
   *  or incomplete. For mono-name input this is filled by the async
   *  cache lookup, not the synchronous parser. */
  addr0x: string | null;
  /** Canonical bech32m form, used for the dual-format hint. null when
   *  input is invalid or incomplete. */
  bech: string | null;
  /** Parsed §22.8 name when inputForm === "mono-name", null otherwise.
   *  The cache lookup is layered above the parser so the form can show
   *  TLD-aware feedback ("Looks like a human name — looking up…") while
   *  the resolve is in flight. */
  monoName: MonoNameParse | null;
  /** Which input shape the user is in:
   *   - "empty": input is empty
   *   - "partial": prefix matches but length is short of canonical (still typing)
   *   - "0x": complete 0x form (valid or invalid)
   *   - "mono1": complete bech32m form (valid or invalid)
   *   - "mono-name": complete §22.8 hierarchical name (e.g. alice.mono)
   *   - "unknown": prefix doesn't match either shape */
  inputForm: "empty" | "partial" | "0x" | "mono1" | "mono-name" | "unknown";
}

export function validateToAddress(s: string): RecipientParse {
  if (s.length === 0) {
    return {
      error: null,
      addr0x: null,
      bech: null,
      monoName: null,
      inputForm: "empty",
    };
  }
  // 0x branch
  if (s.startsWith("0x") || s.startsWith("0X")) {
    if (s.length < 42) {
      return {
        error: null,
        addr0x: null,
        bech: null,
        monoName: null,
        inputForm: "partial",
      };
    }
    if (s.length !== 42) {
      return {
        error: `address must be 42 chars (got ${s.length})`,
        addr0x: null,
        bech: null,
        monoName: null,
        inputForm: "0x",
      };
    }
    if (!/^0[xX][0-9a-fA-F]{40}$/.test(s)) {
      return {
        error: "address must be 0x + 40 hex chars",
        addr0x: null,
        bech: null,
        monoName: null,
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
    return {
      error: null,
      addr0x,
      bech,
      monoName: null,
      inputForm: "0x",
    };
  }
  // mono1 branch — accept both lowercase and all-uppercase per BIP-350.
  // The codec rejects mixed-case; we let it surface that as the error.
  // A 20-byte payload encodes to exactly 43 chars: 4 HRP + 1 separator +
  // 32 data + 6 checksum. Anything shorter is "still typing" (no error).
  if (s.startsWith("mono1") || s.startsWith("MONO1")) {
    if (s.length < 43) {
      return {
        error: null,
        addr0x: null,
        bech: null,
        monoName: null,
        inputForm: "partial",
      };
    }
    try {
      const addr0x = bech32mToAddress(s);
      return {
        error: null,
        addr0x: addr0x.toLowerCase(),
        bech: s.toLowerCase(),
        monoName: null,
        inputForm: "mono1",
      };
    } catch (e) {
      return {
        error: (e as Error).message ?? "invalid mono1 address",
        addr0x: null,
        bech: null,
        monoName: null,
        inputForm: "mono1",
      };
    }
  }
  // §22.8 hierarchical name branch. The parser is strict (lowercase,
  // canonical TLDs only); when it succeeds, the form switches to
  // "mono-name" and the async cache lookup populates addr0x. Partial
  // input (e.g. "alice" or "alice.") is treated as still-typing.
  if (s.endsWith(".mono")) {
    const parsed = parseMonoName(s);
    if (parsed !== null) {
      return {
        error: null,
        addr0x: null,
        bech: null,
        monoName: parsed,
        inputForm: "mono-name",
      };
    }
    return {
      error: "not a valid mono name (e.g. alice.mono, treasury.contract.mono)",
      addr0x: null,
      bech: null,
      monoName: null,
      inputForm: "mono-name",
    };
  }
  if (looksLikePartialMonoName(s)) {
    return {
      error: null,
      addr0x: null,
      bech: null,
      monoName: null,
      inputForm: "partial",
    };
  }
  return {
    error: "address must start with 0x, mono1, or end in .mono",
    addr0x: null,
    bech: null,
    monoName: null,
    inputForm: "unknown",
  };
}

/** Quiet-mode heuristic for the recipient field: if the input is plausibly
 *  a §22.8 name being typed (lowercase, label-friendly chars, short
 *  enough that ".mono" could still be appended), treat it as still-
 *  typing rather than surfacing the "doesn't start with 0x/mono1/.mono"
 *  error. The length cap keeps wrong-HRP bech32m strings (which are 43+
 *  chars without a dot) from being mis-classified as partial names. */
const PARTIAL_NAME_MAX_LEN = 40;
function looksLikePartialMonoName(s: string): boolean {
  if (s.length === 0 || s.length > PARTIAL_NAME_MAX_LEN) return false;
  if (s !== s.toLowerCase()) return false;
  return /^[a-z0-9][a-z0-9.-]*$/.test(s);
}

// ---- §22.8 forward-resolve (name → address) via local name cache ----

interface NameResolutionState {
  status: "idle" | "loading" | "hit" | "miss";
  addr0x: string | null;
}

const IDLE_RESOLUTION: NameResolutionState = { status: "idle", addr0x: null };

/**
 * Reverse-scans the local name cache to find an address whose stored
 * displayName matches the requested §22.8 name. Returns idle when there
 * is no name to resolve, loading while the storage read is in flight,
 * hit when the cache had a match, miss when it didn't.
 *
 * The cache is the only forward-resolve source today — the SDK doesn't
 * expose `lyth_resolveName` yet (§22.8 registry is forward-looking). When
 * the SDK ships the RPC, this hook becomes the place to add the network
 * fallback; the surface (idle / loading / hit / miss + addr0x) stays
 * stable so callers don't change.
 *
 * Subscribes to chrome.storage.onChanged so a fresh reverse-resolve
 * elsewhere in the popup (e.g. activity feed pulling a new label) makes
 * the Send form light up without a re-type.
 */
function useNameForwardResolve(
  parsed: MonoNameParse | null,
): NameResolutionState {
  const [state, setState] = useState<NameResolutionState>(IDLE_RESOLUTION);
  const canonical = parsed?.canonical ?? null;

  useEffect(() => {
    if (canonical === null) {
      setState(IDLE_RESOLUTION);
      return;
    }
    let cancelled = false;
    setState({ status: "loading", addr0x: null });

    const resolve = (cache: NameCache) => {
      const addr = lookupNameInCache(canonical, cache);
      if (cancelled) return;
      setState(
        addr !== null
          ? { status: "hit", addr0x: addr }
          : { status: "miss", addr0x: null },
      );
    };

    chrome.storage.local.get([STORAGE_KEY_NAME_CACHE], (res) => {
      if (cancelled) return;
      const validated = validateNameCache(res?.[STORAGE_KEY_NAME_CACHE]);
      resolve(validated ?? {});
    });

    const listener: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (
      changes,
      area,
    ) => {
      if (area !== "local") return;
      const change = changes[STORAGE_KEY_NAME_CACHE];
      if (!change) return;
      const validated = validateNameCache(change.newValue);
      if (validated === null) return;
      resolve(validated);
    };
    chrome.storage.onChanged.addListener(listener);

    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, [canonical]);

  return state;
}

interface MonoNameResolveHintProps {
  parsed: MonoNameParse;
  resolution: NameResolutionState;
}

function MonoNameResolveHint({ parsed, resolution }: MonoNameResolveHintProps) {
  const tldLabel = TLD_HINT[parsed.tld];
  if (resolution.status === "loading") {
    return (
      <div style={dualFormatHint}>
        Looks like a {tldLabel} name — checking your address book…
      </div>
    );
  }
  if (resolution.status === "hit" && resolution.addr0x !== null) {
    return (
      <div style={dualFormatHint}>
        Resolved {tldLabel} name → {middleTruncate(resolution.addr0x, 10, 8)}
      </div>
    );
  }
  if (resolution.status === "miss") {
    return (
      <div style={inlineError}>
        Name not in your address book yet. On-chain name lookup ships with the
        §22.8 registry — paste the 0x or mono1 address for now.
      </div>
    );
  }
  // idle — shouldn't render because the parent gates on monoName !== null.
  return null;
}

const TLD_HINT: Record<MonoNameParse["tld"], string> = {
  human: "human",
  agent: "agent",
  cluster: "cluster",
  contract: "contract",
  system: "system",
};

// ---- Recipient familiarity (phase 6 phishing protection) ----

type Familiarity = "unknown" | "new" | "seen";

/**
 * Returns "seen" when the recipient has appeared as the counterparty of a
 * prior outgoing tx_send (or out-direction token_transfer / pending_tx)
 * from the active account on this chain. "new" when the recipient is
 * resolved but absent from the activity cache. "unknown" while the
 * recipient is not yet typed-in / not yet resolved, or before the cache
 * read completes — the UI suppresses the warning in this state to avoid
 * a flash-of-new-recipient on first render.
 *
 * The check is local-only (reads chrome.storage); no IPC. Activity-cache
 * eviction caps the lookback at the rolling window the SW maintains.
 */
function useRecipientFamiliarity(
  recipientAddr0x: string | null,
  accountAddr: string,
  chainIdHex: string,
): Familiarity {
  const [state, setState] = useState<Familiarity>("unknown");

  useEffect(() => {
    if (!recipientAddr0x || !accountAddr.startsWith("0x")) {
      setState("unknown");
      return;
    }
    const target = recipientAddr0x.toLowerCase();
    const accLower = accountAddr.toLowerCase();
    const confirmedKey = activityCacheKey(accLower, chainIdHex);
    const pendingKey = activityPendingKey(accLower, chainIdHex);
    let cancelled = false;
    setState("unknown");

    chrome.storage.local.get([confirmedKey, pendingKey], (res) => {
      if (cancelled) return;
      const confirmed = res?.[confirmedKey] as ActivityCache | undefined;
      const pending = res?.[pendingKey] as PendingActivityCache | undefined;

      const inConfirmed = (confirmed?.confirmed ?? []).some((r) => {
        if (r.kind === "tx_send") return r.counterparty === target;
        if (r.kind === "token_transfer")
          return r.direction === "out" && r.counterparty === target;
        return false;
      });
      const inPending = (pending?.pending ?? []).some(
        (r) => r.to.toLowerCase() === target,
      );
      setState(inConfirmed || inPending ? "seen" : "new");
    });

    return () => {
      cancelled = true;
    };
  }, [recipientAddr0x, accountAddr, chainIdHex]);

  return state;
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
  if (dot >= 0 && s.length - dot - 1 > NATIVE_LYTH_DECIMALS) {
    return "amount cannot have more than 8 decimal places";
  }
  return null;
}

// ---- amount conversion ----

/**
 * Convert a decimal LYTH amount string to lythoshi (`0x` hex). Precision-safe —
 * splits on `.` and builds the BigInt from integer + zero-padded fractional
 * parts so `0.00000001` (1 lythoshi) round-trips exactly. Throws on
 * invalid input; callers should pre-validate via `validateAmount`.
 */
export function lythToLythoshiHex(amountStr: string): string {
  return "0x" + safeLythToLythoshiBigInt(amountStr).toString(16);
}

function safeLythToLythoshiBigInt(amountStr: string): bigint {
  const dot = amountStr.indexOf(".");
  const intPart = dot < 0 ? amountStr : amountStr.slice(0, dot);
  const fracPartRaw = dot < 0 ? "" : amountStr.slice(dot + 1);
  if (fracPartRaw.length > NATIVE_LYTH_DECIMALS) {
    throw new Error("amount has more than 8 decimal places");
  }
  const fracPadded =
    (fracPartRaw + "0".repeat(NATIVE_LYTH_DECIMALS)).slice(
      0,
      NATIVE_LYTH_DECIMALS,
    );
  const intBig = BigInt(intPart === "" ? "0" : intPart);
  const fracBig = BigInt(fracPadded === "" ? "0" : fracPadded);
  return intBig * LYTHOSHI_PER_LYTH + fracBig;
}

// ---- low-level fee detail display ----

/** Multiply a hex lythoshi priority price by a basis-point tier multiplier. */
function scaleLythoshiPerExecutionUnit(
  lythoshiHex: string,
  multiplierBps: bigint,
): string {
  const lythoshi = parseNativeHexQuantity(lythoshiHex);
  if (lythoshi === null) {
    return "?";
  }
  return scaleByBps(lythoshi, multiplierBps).toString();
}

// ---- fee math ----

function computeEstimatedFeeLythoshi(
  fee: FeeSuggestion | null,
  priorityMultiplierBps: bigint,
): bigint | null {
  if (!fee) return null;
  return computeNativeFeeFromBaseAndPriority({
    executionUnitsHex: fee.gasLimit,
    fallbackExecutionUnitsHex: FALLBACK_TRANSFER_EXECUTION_UNITS_HEX,
    basePricePerExecutionUnitHex: fee.baseFeePerGas,
    priorityPricePerExecutionUnitHex: fee.maxPriorityFeePerGas,
    priorityMultiplierBps,
    ...(fee.structuredFee !== undefined ? { structuredFee: fee.structuredFee } : {}),
  });
}

/** @deprecated IPC compatibility name; use `lythToLythoshiHex`. */
export function lythToWeiHex(amountStr: string): string {
  return lythToLythoshiHex(amountStr);
}

/**
 * @deprecated Legacy helper kept only for the background pending-row golden
 * test until that shared reconciliation path moves to v4.1 lythoshi. The Send
 * page itself uses `lythoshiToLythString`.
 */
function weiToLythString(compatWei: bigint): string {
  if (compatWei < 0n) return "0";
  const compatWeiPerLyth = 10n ** 18n;
  const intPart = compatWei / compatWeiPerLyth;
  const fracPart = compatWei % compatWeiPerLyth;
  if (fracPart === 0n) return intPart.toString();
  const fracStr = fracPart.toString().padStart(18, "0").replace(/0+$/, "");
  return fracStr.length === 0
    ? intPart.toString()
    : `${intPart.toString()}.${fracStr}`;
}

/** @deprecated Compatibility export; use `computeEstimatedFeeLythoshi`. */
const computeEstimatedFeeWei = computeEstimatedFeeLythoshi;

// ---- preview / sending / success / error sub-state views ----

interface PreviewViewProps {
  to: string;
  amountLythoshi: bigint | null;
  estimatedFeeLythoshi: bigint | null;
  tier: FeeTier;
  fromAddr: string;
  onConfirm: () => void;
  onBack: () => void;
  /** When true, render the multisig copy variants: "Review proposal"
   *  header, "Submit as proposal" CTA, multisig-aware warning copy.
   *  Default behavior (single-vault send) is unchanged when false. */
  isMultisig?: boolean;
  /** Phase 9 — passkey policy decision for the current tx. When
   *  present and the decision is `passkey-ok`, render a "passkey
   *  unlock" badge above the warning card so the user knows which
   *  unlock path the Confirm CTA will trigger. */
  passkeyDecision?: BgPasskeyDecision | null;
}

/** Phase 9 — preview-screen badge that tells the user which unlock
 *  the Confirm CTA will trigger.
 *
 *  passkey-ok       → green "Passkey unlock" pill
 *  password-required → no badge (default behaviour, password works as today)
 *  over-limit        → amber "Above passkey limit" pill explaining the
 *                       per-tx / daily-cap threshold that was tripped
 */
function PasskeyDecisionBadge({
  decision,
}: {
  decision: BgPasskeyDecision;
}) {
  if (decision.kind === "password-required") return null;

  if (decision.kind === "passkey-ok") {
    return (
      <div
        style={{
          padding: "8px 10px",
          borderRadius: 8,
          background: "rgba(126,227,193,0.08)",
          border: "1px solid rgba(126,227,193,0.4)",
          color: "var(--fg-100)",
          fontSize: 11.5,
          lineHeight: 1.5,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <Icon name="passkey" size={12} />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600 }}>Passkey unlock</div>
          <div style={{ fontSize: 10.5, color: "var(--fg-300)" }}>
            Below the configured limit — Confirm will use your passkey instead
            of asking for your password.
          </div>
        </div>
      </div>
    );
  }

  // over-limit
  const lyth = (() => {
    try {
      return formatNativeLythAmount(BigInt(decision.thresholdWeiHex));
    } catch {
      return "? LYTH";
    }
  })();
  return (
    <div
      style={{
        padding: "8px 10px",
        borderRadius: 8,
        background: "rgba(242,180,65,0.08)",
        border: "1px solid rgba(242,180,65,0.4)",
        color: "var(--fg-100)",
        fontSize: 11.5,
        lineHeight: 1.5,
      }}
    >
      <div style={{ fontWeight: 600 }}>Above passkey limit</div>
      <div style={{ fontSize: 10.5, color: "var(--fg-300)" }}>
        {decision.mode === "per-tx"
          ? `Per-tx limit is ${lyth} — this tx requires password unlock.`
          : `Daily cap is ${lyth} — this tx requires password unlock.`}
      </div>
    </div>
  );
}

/** Phase 11.5 Commit 2 — "Hooks that will run" section on the Send
 *  preview screen. Lazy-fetches the chain's pre-tx hook preview
 *  (`lyth_previewTransactionHooks`, mono-core @dd05511) when the
 *  preview mounts.
 *
 *  Visibility:
 *    - while loading        → thin skeleton (no width-shift)
 *    - chain returned live  → render hook list + spending-policy row
 *    - any mock-* outcome   → render nothing (graceful no-op on
 *                             operators that haven't deployed yet)
 *
 *  We hide the section on every mock outcome rather than rendering a
 *  "data missing" hint because the preview screen already feels busy
 *  with the summary + warning cards. The dev-tools `via` string still
 *  records what happened for diagnostics. */
function PreviewHooksSection({
  fromAddr,
  to,
  amountLythoshi,
}: {
  fromAddr: string;
  to: string;
  amountLythoshi: bigint | null;
}) {
  const [outcome, setOutcome] = useState<PreviewTransactionHooksOutcome | null>(
    null,
  );
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setOutcome(null);
    void (async () => {
      const args: { from?: string; to: string; valueWeiHex?: string } = {
        from: fromAddr,
        to,
      };
      if (amountLythoshi !== null) {
        args.valueWeiHex = "0x" + amountLythoshi.toString(16);
      }
      const r = await bgPreviewTransactionHooks(args);
      if (cancelled) return;
      setLoading(false);
      if (r.ok) {
        setOutcome(r.outcome);
      } else {
        setOutcome(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fromAddr, to, amountLythoshi]);

  if (loading) {
    return (
      <div
        style={{
          height: 28,
          borderRadius: 8,
          background: "rgba(124,127,255,0.04)",
          border: "1px dashed rgba(124,127,255,0.2)",
        }}
        aria-hidden="true"
      />
    );
  }
  if (!outcome || outcome.kind !== "live") {
    // mock-not-deployed / mock-offline / mock-error → hide entirely.
    return null;
  }
  return <HookPreviewCard preview={outcome.data} />;
}

function HookPreviewCard({ preview }: { preview: TransactionHookPreview }) {
  const policy = preview.spendingPolicy;
  const policyOk = policy.status === "ok";
  return (
    <div
      className="ext-card"
      style={{
        padding: "10px 12px",
        background: preview.wouldReject
          ? "rgba(244,99,99,0.06)"
          : "rgba(124,127,255,0.05)",
        border: preview.wouldReject
          ? "1px solid rgba(244,99,99,0.4)"
          : "1px solid rgba(124,127,255,0.25)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 6,
        }}
      >
        <div
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 10,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: "var(--fg-400)",
          }}
        >
          Hooks that will run · §15
        </div>
        {preview.wouldReject && (
          <span
            style={{
              fontSize: 9.5,
              padding: "2px 6px",
              borderRadius: 999,
              background: "rgba(244,99,99,0.18)",
              color: "var(--fg-100)",
              fontWeight: 600,
            }}
          >
            WOULD REJECT
          </span>
        )}
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        <HookRow
          name="Spending policy"
          status={policy.status}
          tone={policyOk ? "ok" : "warn"}
          message={policy.message ?? policy.reason ?? null}
          details={policy.details}
        />
        {preview.warnings.map((w, i) => (
          <HookRow
            key={`${w.code}-${i}`}
            name={w.code}
            status={w.severity}
            tone={w.severity === "error" ? "warn" : "info"}
            message={w.message}
            details={null}
          />
        ))}
      </div>
    </div>
  );
}

function HookRow({
  name,
  status,
  tone,
  message,
  details,
}: {
  name: string;
  status: string;
  tone: "ok" | "warn" | "info";
  message: string | null;
  details: Record<string, string> | null;
}) {
  const dotColor =
    tone === "ok" ? "var(--ok)" : tone === "warn" ? "var(--warn, #f2b441)" : "var(--fg-400)";
  const detailEntries = details ? Object.entries(details) : [];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 12,
          color: "var(--fg-100)",
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: dotColor,
            flexShrink: 0,
          }}
        />
        <span style={{ fontWeight: 600 }}>{name}</span>
        <span
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 10,
            color: "var(--fg-400)",
          }}
        >
          {status}
        </span>
      </div>
      {message && (
        <div
          style={{
            fontSize: 11,
            color: "var(--fg-300)",
            paddingLeft: 12,
            lineHeight: 1.4,
          }}
        >
          {message}
        </div>
      )}
      {detailEntries.length > 0 && (
        <div
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 10,
            color: "var(--fg-400)",
            paddingLeft: 12,
            display: "flex",
            flexDirection: "column",
            gap: 1,
          }}
        >
          {detailEntries.map(([k, v]) => (
            <div key={k}>
              {k}: {v}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PreviewView({
  to,
  amountLythoshi,
  estimatedFeeLythoshi,
  tier,
  fromAddr,
  onConfirm,
  onBack,
  isMultisig,
  passkeyDecision,
}: PreviewViewProps) {
  const total = amountLythoshi !== null && estimatedFeeLythoshi !== null
    ? amountLythoshi + estimatedFeeLythoshi
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
          {isMultisig ? "Review proposal" : "Review send"}
        </div>
        <div style={{ width: 28 }} />
      </div>

      <div className="ext-body">
        <div className="ext-card" style={{ padding: 14 }}>
          <SummaryRow label="From" value={shortAddr(fromAddr, 18)} mono />
          <SummaryRow label="To" value={shortAddr(to, 18)} mono />
          <SummaryRow
            label="Amount"
            value={
              amountLythoshi !== null
                ? formatNativeLythAmount(amountLythoshi)
                : "—"
            }
            mono
          />
          <SummaryRow
            label={`Fee (${TIER_LABELS[tier]})`}
            value={
              estimatedFeeLythoshi !== null
                ? formatNativeLythAmount(estimatedFeeLythoshi)
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
              value={total !== null ? formatNativeLythAmount(total) : "—"}
              mono
              emphasis
            />
          </div>
        </div>

        <PreviewHooksSection
          fromAddr={fromAddr}
          to={to}
          amountLythoshi={amountLythoshi}
        />

        {passkeyDecision && !isMultisig && (
          <PasskeyDecisionBadge decision={passkeyDecision} />
        )}

        <div
          className="ext-card"
          style={{
            padding: "10px 12px",
            background: "rgba(242,180,65,0.08)",
            border: "1px solid rgba(242,180,65,0.4)",
          }}
        >
          <div style={{ fontSize: 12, lineHeight: 1.5, color: "var(--fg-100)" }}>
            {isMultisig
              ? "This creates a proposal in the multisig vault. Other signers will see it on the Pending tab and approve or reject. Execution only happens once the configured threshold is met."
              : "Transactions are irreversible. Confirm the recipient and amount carefully."}
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
            {isMultisig ? "Submit as proposal" : "Confirm"}
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

/**
 * Format the user-facing error string for a Send failure. Method-aware
 * so pre-submit RPC failures (lyth_getEncryptionKey, eth_feeHistory,
 * eth_getTransactionCount) read distinctly from real submission rejects
 * (lyth_submitEncrypted) — Phase 4.3 smoke testing showed "Chain rejected:"
 * was the misleading prefix that conflated these. When method is missing
 * (SW lags popup), falls back to the legacy verbatim shape so the popup
 * never breaks. Exported for unit testing in Send.test.ts.
 */
export function formatSendError(args: {
  message: string;
  code: number | null;
  method: string | null;
  via: string | null;
}): string {
  const { message, code, method, via } = args;
  const isAdmissionReject =
    code !== null &&
    code >= ADMISSION_REJECT_CODE_LO &&
    code <= ADMISSION_REJECT_CODE_HI;
  const viaSuffix = via ? ` via ${via}` : "";
  const viaParen = via ? ` (via ${via})` : "";
  switch (method) {
    case "lyth_submitEncrypted":
      return isAdmissionReject
        ? `Mempool rejected: ${message}${viaParen}`
        : `Submission failed: ${message}${viaParen}`;
    case "lyth_getEncryptionKey":
      return `Couldn't fetch encryption key. The cluster may be unavailable. (lyth_getEncryptionKey${viaSuffix})`;
    case "eth_feeHistory":
      return `Fee history fetch failed (eth_feeHistory${viaSuffix})`;
    case "eth_getTransactionCount":
      return `Couldn't fetch account nonce (eth_getTransactionCount${viaSuffix})`;
    case null:
      // Back-compat: SW lags popup and didn't stamp method. Use the
      // legacy verbatim shape so the popup never breaks for older SWs.
      return isAdmissionReject ? `Chain rejected: ${message}` : message;
    default: {
      // Unknown method (e.g. lyth_estimateGas if ever added): retain the
      // legacy "Chain rejected" prefix for admission codes but append an
      // attribution suffix so the operator + method are visible.
      const suffix = `(${method}${viaSuffix})`;
      return isAdmissionReject
        ? `Chain rejected: ${message} ${suffix}`
        : `${message} ${suffix}`;
    }
  }
}

interface ErrorViewProps {
  message: string;
  code: number | null;
  method: string | null;
  via: string | null;
  onRetry: () => void;
  onCancel: () => void;
}

/** Phase 11 Commit 7 — colour palette per severity. Severity comes from
 *  classifySendError; "info" (user cancelled) gets a blue treatment so
 *  the error screen doesn't shout at the user about a cancel they
 *  intentionally chose. */
function severityColours(severity: "err" | "warn" | "info"): {
  fg: string;
  iconBg: string;
  cardBg: string;
  borderRgba: string;
} {
  switch (severity) {
    case "err":
      return {
        fg: "var(--err)",
        iconBg: "rgba(220,80,80,0.12)",
        cardBg: "rgba(220,80,80,0.08)",
        borderRgba: "rgba(220,80,80,0.4)",
      };
    case "warn":
      return {
        fg: "var(--warn)",
        iconBg: "rgba(220,180,80,0.12)",
        cardBg: "rgba(220,180,80,0.08)",
        borderRgba: "rgba(220,180,80,0.4)",
      };
    case "info":
      return {
        fg: "var(--fg-200)",
        iconBg: "rgba(120,160,220,0.10)",
        cardBg: "rgba(120,160,220,0.06)",
        borderRgba: "rgba(120,160,220,0.3)",
      };
  }
}

function ErrorView({ message, code, method, via, onRetry, onCancel }: ErrorViewProps) {
  const display = formatSendError({ message, code, method, via });
  // Phase 11 Commit 7 — typed classification on top of the formatted
  // message. headline + body replace the previous single-line render
  // for kinds the classifier recognises; unknown kinds preserve the
  // verbatim `display` string in the body.
  const classified = classifySendError(display);
  const colours = severityColours(classified.severity);
  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onCancel} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div
          style={{ flex: 1, fontSize: 13, fontWeight: 600, textAlign: "center" }}
        >
          {classified.headline}
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
              background: colours.iconBg,
              border: `1px solid ${colours.borderRgba}`,
              color: colours.fg,
              fontSize: 28,
            }}
            aria-hidden="true"
          >
            {classified.severity === "info" ? "ⓘ" : "✕"}
          </div>
        </div>

        <div
          className="ext-card"
          style={{
            padding: "12px 14px",
            background: colours.cardBg,
            border: `1px solid ${colours.borderRgba}`,
          }}
        >
          <div style={{ fontSize: 12.5, lineHeight: 1.5, color: "var(--fg-100)" }}>
            {classified.body}
          </div>
          {classified.kind !== "unknown" && (
            <details style={{ marginTop: 8 }}>
              <summary
                style={{
                  fontSize: 10,
                  color: "var(--fg-500)",
                  cursor: "pointer",
                  fontFamily: "var(--f-mono)",
                  letterSpacing: "0.04em",
                }}
              >
                Technical details
              </summary>
              <div
                style={{
                  fontSize: 10.5,
                  color: "var(--fg-400)",
                  lineHeight: 1.5,
                  marginTop: 6,
                  fontFamily: "var(--f-mono)",
                  wordBreak: "break-word",
                }}
              >
                {display}
              </div>
            </details>
          )}
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

/** Phase 11 Commit 7 — bech32m typo suggestion hint.
 *
 *  When the user typed something that fails parsing AND the typo
 *  classifier finds a 1-edit fix, render an inline "Did you mean
 *  mono1abc..." chip. Click applies the suggestion as the new recipient.
 *
 *  Conservative defaults:
 *    - Only renders when the parent's parse already errored (so we
 *      don't second-guess valid recipients).
 *    - Only renders for `bech32m-typo` classification (not for hex,
 *      not for unknown garbage).
 *    - Truncates the suggestion for display, but applies the full
 *      address on click.
 */
function BechTypoHint({
  to,
  hasParseError,
  onApply,
}: {
  to: string;
  hasParseError: boolean;
  onApply: (addr: string) => void;
}) {
  if (!hasParseError) return null;
  const classified = classifyAddressInput(to);
  if (classified.kind !== "bech32m-typo") return null;
  const trunc = middleTruncate(classified.suggestion, 14, 8);
  return (
    <div
      style={{
        marginTop: 8,
        padding: "8px 10px",
        borderRadius: 8,
        background: "rgba(120,160,220,0.06)",
        border: "1px solid rgba(120,160,220,0.3)",
        fontSize: 11,
        color: "var(--fg-100)",
        display: "flex",
        gap: 8,
        alignItems: "center",
        flexWrap: "wrap",
      }}
    >
      <span>
        Did you mean{" "}
        <code
          style={{
            fontFamily: "var(--f-mono)",
            color: "var(--fg-100)",
          }}
        >
          {trunc}
        </code>
        ?
      </span>
      <button
        type="button"
        onClick={() => onApply(classified.suggestion)}
        style={{
          fontSize: 10,
          fontFamily: "var(--f-mono)",
          letterSpacing: "0.04em",
          color: "var(--fg-100)",
          background: "rgba(255,255,255,0.06)",
          border: "1px solid var(--fg-700)",
          padding: "3px 8px",
          borderRadius: 4,
          cursor: "pointer",
        }}
      >
        Use suggested
      </button>
    </div>
  );
}

// ---- shared exports ----

export {
  ADMISSION_REJECT_CODE_LO,
  ADMISSION_REJECT_CODE_HI,
  TIER_LABELS,
  computeEstimatedFeeLythoshi,
  computeEstimatedFeeWei,
  formatNativeLythAmount,
  lythoshiToLythString,
  weiToLythString,
};
