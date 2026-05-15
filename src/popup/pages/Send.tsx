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
import { useEffect, useMemo, useState } from "react";
import { Icon, shortAddr } from "../Icon";
import {
  bgMultisigPropose,
  bgPasskeyEvaluate,
  bgPasskeyRecordUsage,
  bgWalletBalance,
  bgWalletFeeSuggestion,
  bgWalletSendTx,
  type BgPasskeyDecision,
  type FeeSuggestion,
} from "../bg";
import { PasskeySignModal } from "../components/PasskeySignModal";
import { keccak_256 } from "@noble/hashes/sha3.js";
import type { Account } from "../demo-data";
import { addressToBech32m, bech32mToAddress } from "../../shared/bech32m";
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
  const [balanceWei, setBalanceWei] = useState<bigint | null>(null);

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
    effectiveAddr0x !== null &&
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
      amountWei !== null
    ) {
      const r = await bgPasskeyEvaluate({
        vaultId: singleVaultId,
        valueWeiHex: "0x" + amountWei.toString(16),
      });
      setPasskeyDecision(r.ok ? r.decision : null);
    } else {
      setPasskeyDecision(null);
    }
    setStep("preview");
  };

  const handleConfirm = async () => {
    if (amountWei === null) return;
    if (effectiveAddr0x === null) return; // form button is gated; defensive
    setStep("sending");
    setSubmitError(null);
    setTxHash(null);
    try {
      const valueWeiHex = "0x" + amountWei.toString(16);
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
            valueWeiHex,
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
        valueWeiHex,
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
            valueWeiHex,
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
      needsPasskey && effectiveAddr0x !== null && amountWei !== null
        ? keccak_256(
            new TextEncoder().encode(
              `${effectiveAddr0x}|${amountWei.toString(16)}|${chainId}`,
            ),
          )
        : new Uint8Array(32);

    return (
      <>
        <PreviewView
          to={effectiveAddr0x ?? to}
          amountWei={amountWei}
          estimatedFeeWei={estimatedFeeWei}
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
      const wei = BigInt(decision.thresholdWeiHex);
      return (wei / 1_000_000_000_000_000_000n).toString();
    } catch {
      return "?";
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
          ? `Per-tx limit is ${lyth} LYTH — this tx requires password unlock.`
          : `Daily cap is ${lyth} LYTH — this tx requires password unlock.`}
      </div>
    </div>
  );
}

function PreviewView({
  to,
  amountWei,
  estimatedFeeWei,
  tier,
  fromAddr,
  onConfirm,
  onBack,
  isMultisig,
  passkeyDecision,
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

function ErrorView({ message, code, method, via, onRetry, onCancel }: ErrorViewProps) {
  const display = formatSendError({ message, code, method, via });
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
