// AgentPolicy page — §18.8 spending-policy agent sub-accounts.
//
// The consumer-pillar surface: a principal (the active wallet) creates
// an agent sub-account, funds it with native LYTH, and binds a §18.8
// spending policy to it (per-tx + daily/weekly/monthly caps, optional
// counterparty/category allow-list roots, an optional time-of-day
// window, and an optional expiry). The policy is enforced AT ADMISSION
// by the chain — a violating tx from the sub-account is rejected.
//
// Flow (fresh-claim path, selector 0x35531f6c):
//   overview → form → create+sign (SW derives the sub-account keypair,
//   signs the chain-id-bound claim message) → review (show the
//   one-time recovery phrase + funding note) → fund (native transfer,
//   principal → sub-account) → register (submit calldata to 0x110C) →
//   success.
//
// Revoke (= disable, selector 0xe6c09edf) is available from the
// overview when a live policy is read for a sub-account.
//
// Chain wiring mirrors Stake.tsx: encode via shared/spending-policy-tx
// (SDK encoders) and submit through `bgWalletSendTx`. The
// spending-policy precompile (0x110C) may be milestone-GATED on the
// live testnet; the page surfaces whatever typed precompile-gate error
// the chain returns verbatim.

import { useState, type CSSProperties } from "react";
import { Icon } from "../Icon";
import {
  bgBuildSpendingPolicyClaim,
  bgReadSpendingPolicy,
  bgWalletSendTx,
  type BgBuildSpendingPolicyClaimReply,
  type SpendingPolicyView,
} from "../bg";
import type { Account } from "../demo-data";
import {
  SPENDING_POLICY_PRECOMPILE,
  SPENDING_POLICY_CLAIM_UNIT_LIMIT_HEX,
  SPENDING_POLICY_TOGGLE_UNIT_LIMIT_HEX,
  encodeDisable,
  lythToLythoshi,
} from "../../shared/spending-policy-tx";
import { lythToLythoshiHex } from "./Send";
import { lythoshiToLythDecimal, parseHexQuantity } from "../../shared/native-amount";
import { userAddressForNativeRpc } from "../../shared/address-format";

type Step =
  | "overview"
  | "form"
  | "review"
  | "submitting"
  | "success"
  | "error";

interface AgentPolicyProps {
  account: Account;
  /** Active chain id (hex). Bound into the signed claim message + used
   *  by `bgWalletSendTx` to take the ML-DSA-65 envelope path. */
  chainId: string;
  onBack: () => void;
}

interface FormState {
  perTxCapLyth: string;
  dailyCapLyth: string;
  weeklyCapLyth: string;
  monthlyCapLyth: string;
  allowRoot: string;
  denyRoot: string;
  categoryAllowRoot: string;
  windowEnabled: boolean;
  windowStartHour: string;
  windowEndHour: string;
  /** Funding amount (decimal LYTH) the principal sends to the fresh
   *  sub-account so it can transact under the policy. */
  fundLyth: string;
  /** Optional expiry as a yyyy-mm-dd date string ("" == never). */
  expiryDate: string;
}

const EMPTY_FORM: FormState = {
  perTxCapLyth: "",
  dailyCapLyth: "",
  weeklyCapLyth: "",
  monthlyCapLyth: "",
  allowRoot: "",
  denyRoot: "",
  categoryAllowRoot: "",
  windowEnabled: false,
  windowStartHour: "9",
  windowEndHour: "17",
  fundLyth: "",
  expiryDate: "",
};

interface SubmitError {
  message: string;
  code: number | null;
  method: string | null;
  via: string | null;
}

export function AgentPolicy({ account, chainId, onBack }: AgentPolicyProps) {
  const [step, setStep] = useState<Step>("overview");
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  // Overview — live policy lookup for an existing sub-account.
  const [lookupAddr, setLookupAddr] = useState("");
  const [policy, setPolicy] = useState<SpendingPolicyView | null>(null);
  const [policyLoading, setPolicyLoading] = useState(false);
  const [policyError, setPolicyError] = useState<string | null>(null);

  // The freshly-built claim (sub-account keypair + calldata).
  const [claim, setClaim] = useState<
    Extract<BgBuildSpendingPolicyClaimReply, { ok: true }> | null
  >(null);
  const [formError, setFormError] = useState<string | null>(null);

  const [submitError, setSubmitError] = useState<SubmitError | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [phraseSaved, setPhraseSaved] = useState(false);

  // ───────────────────────────────────────────────────────────────────────
  // Overview — read live policy
  // ───────────────────────────────────────────────────────────────────────

  const handleLookup = async () => {
    const addr = lookupAddr.trim();
    if (addr.length === 0) return;
    setPolicyLoading(true);
    setPolicyError(null);
    setPolicy(null);
    try {
      const r = await bgReadSpendingPolicy(addr);
      if (r.ok) {
        setPolicy(r.data);
      } else {
        setPolicyError(r.reason);
      }
    } catch (e) {
      setPolicyError((e as Error).message ?? "lookup failed");
    } finally {
      setPolicyLoading(false);
    }
  };

  // ───────────────────────────────────────────────────────────────────────
  // Form → build claim (SW derives sub-account + signs)
  // ───────────────────────────────────────────────────────────────────────

  const validateForm = (): string | null => {
    // At least one cap must be set — a no-constraint policy is
    // pointless and likely a user mistake.
    try {
      const perTx = lythToLythoshi(form.perTxCapLyth);
      const daily = lythToLythoshi(form.dailyCapLyth);
      const weekly = lythToLythoshi(form.weeklyCapLyth);
      const monthly = lythToLythoshi(form.monthlyCapLyth);
      if (perTx === 0n && daily === 0n && weekly === 0n && monthly === 0n) {
        return "Set at least one spending cap.";
      }
    } catch (e) {
      return (e as Error).message;
    }
    if (form.windowEnabled) {
      const s = Number(form.windowStartHour);
      const en = Number(form.windowEndHour);
      if (!Number.isInteger(s) || s < 0 || s > 23) {
        return "Window start hour must be 0–23.";
      }
      if (!Number.isInteger(en) || en < 0 || en > 23) {
        return "Window end hour must be 0–23.";
      }
    }
    if (form.fundLyth.trim() !== "") {
      try {
        if (lythToLythoshi(form.fundLyth) <= 0n) {
          return "Funding amount must be positive (or leave blank to fund later).";
        }
      } catch (e) {
        return (e as Error).message;
      }
    }
    return null;
  };

  const handleBuildClaim = async () => {
    const v = validateForm();
    if (v !== null) {
      setFormError(v);
      return;
    }
    setFormError(null);

    let expiryUnix: number | undefined;
    if (form.expiryDate.trim() !== "") {
      const ms = Date.parse(form.expiryDate + "T00:00:00Z");
      if (Number.isNaN(ms)) {
        setFormError("Invalid expiry date.");
        return;
      }
      expiryUnix = Math.floor(ms / 1000);
    }

    try {
      const r = await bgBuildSpendingPolicyClaim({
        chainId,
        perTxCapLyth: form.perTxCapLyth,
        dailyCapLyth: form.dailyCapLyth,
        weeklyCapLyth: form.weeklyCapLyth,
        monthlyCapLyth: form.monthlyCapLyth,
        ...(form.allowRoot.trim() !== "" ? { allowRoot: form.allowRoot.trim() } : {}),
        ...(form.denyRoot.trim() !== "" ? { denyRoot: form.denyRoot.trim() } : {}),
        ...(form.categoryAllowRoot.trim() !== ""
          ? { categoryAllowRoot: form.categoryAllowRoot.trim() }
          : {}),
        timeWindow: form.windowEnabled
          ? {
              startHour: Number(form.windowStartHour),
              endHour: Number(form.windowEndHour),
            }
          : null,
        ...(expiryUnix !== undefined ? { policyExpiryUnixSeconds: expiryUnix } : {}),
      });
      if (r.ok) {
        setClaim(r);
        setPhraseSaved(false);
        setStep("review");
      } else {
        setFormError(r.reason);
      }
    } catch (e) {
      setFormError((e as Error).message ?? "failed to build claim");
    }
  };

  // ───────────────────────────────────────────────────────────────────────
  // Register — fund (optional native transfer) + submit claim to 0x110C
  // ───────────────────────────────────────────────────────────────────────

  const handleRegister = async () => {
    if (claim === null) return;
    setStep("submitting");
    setSubmitError(null);
    setTxHash(null);
    try {
      // 1. Fund the sub-account (ordinary native transfer) when an
      //    amount was supplied. This is a separate tx; a funding
      //    failure aborts before the claim so the user isn't left with
      //    an unfunded-but-registered sub-account.
      if (form.fundLyth.trim() !== "") {
        const fundRes = await bgWalletSendTx({
          to: claim.subAccountAddress,
          valueWeiHex: lythToLythoshiHex(form.fundLyth.trim()),
          chainIdHex: chainId,
        });
        if (!fundRes.ok) {
          setSubmitError({
            message: fundRes.reason ?? "funding transfer rejected",
            code: typeof fundRes.code === "number" ? fundRes.code : null,
            method: typeof fundRes.method === "string" ? fundRes.method : null,
            via: typeof fundRes.via === "string" ? fundRes.via : null,
          });
          setStep("error");
          return;
        }
      }

      // 2. Register the policy — submit the setPolicyClaim calldata to
      //    0x110C. The principal signs the outer tx; the sub-account's
      //    pubkey + signature ride in the calldata.
      const r = await bgWalletSendTx({
        to: claim.to,
        valueWeiHex: claim.valueWeiHex,
        chainIdHex: chainId,
        data: claim.data,
        executionUnitLimitHex: SPENDING_POLICY_CLAIM_UNIT_LIMIT_HEX,
      });
      if (r.ok) {
        setTxHash(r.result.txHash);
        setStep("success");
      } else {
        setSubmitError({
          message: r.reason ?? "policy registration rejected",
          code: typeof r.code === "number" ? r.code : null,
          method: typeof r.method === "string" ? r.method : null,
          via: typeof r.via === "string" ? r.via : null,
        });
        setStep("error");
      }
    } catch (e) {
      setSubmitError({
        message: (e as Error).message ?? "registration failed",
        code: null,
        method: null,
        via: null,
      });
      setStep("error");
    }
  };

  // ───────────────────────────────────────────────────────────────────────
  // Revoke — disable the policy for a sub-account read in the overview
  // ───────────────────────────────────────────────────────────────────────

  const handleRevoke = async () => {
    if (policy === null) return;
    setStep("submitting");
    setSubmitError(null);
    setTxHash(null);
    try {
      // `policy.address` is the typed `mono` bech32m sub-account the
      // chain keys the policy by; encodeDisable accepts it directly.
      const subAccount = userAddressForNativeRpc(policy.address);
      const r = await bgWalletSendTx({
        to: SPENDING_POLICY_PRECOMPILE,
        valueWeiHex: "0x0",
        chainIdHex: chainId,
        data: encodeDisable(subAccount),
        executionUnitLimitHex: SPENDING_POLICY_TOGGLE_UNIT_LIMIT_HEX,
      });
      if (r.ok) {
        setTxHash(r.result.txHash);
        setStep("success");
      } else {
        setSubmitError({
          message: r.reason ?? "revoke rejected",
          code: typeof r.code === "number" ? r.code : null,
          method: typeof r.method === "string" ? r.method : null,
          via: typeof r.via === "string" ? r.via : null,
        });
        setStep("error");
      }
    } catch (e) {
      setSubmitError({
        message: (e as Error).message ?? "revoke failed",
        code: null,
        method: null,
        via: null,
      });
      setStep("error");
    }
  };

  const resetToOverview = () => {
    setStep("overview");
    setForm(EMPTY_FORM);
    setClaim(null);
    setFormError(null);
    setSubmitError(null);
    setTxHash(null);
    setPhraseSaved(false);
  };

  // ───────────────────────────────────────────────────────────────────────
  // Render
  // ───────────────────────────────────────────────────────────────────────

  return (
    <>
      <div className="ext-top">
        <button
          className="ext-iconbtn"
          onClick={() => {
            if (step === "form") setStep("overview");
            else if (step === "review") setStep("form");
            else onBack();
          }}
          aria-label="Back"
        >
          <Icon name="back" size={15} />
        </button>
        <div style={{ flex: 1, fontSize: 13, fontWeight: 600, textAlign: "center" }}>
          {step === "overview"
            ? "Agent spending policy"
            : step === "form"
              ? "New agent policy"
              : step === "review"
                ? "Review policy"
                : step === "submitting"
                  ? "Submitting…"
                  : step === "success"
                    ? "Done"
                    : "Error"}
        </div>
        <div style={{ width: 28 }} />
      </div>

      <div className="ext-body">
        {step === "overview" && (
          <OverviewView
            principalAddr={account.addr}
            lookupAddr={lookupAddr}
            onLookupAddr={setLookupAddr}
            onLookup={() => void handleLookup()}
            loading={policyLoading}
            policy={policy}
            error={policyError}
            onCreate={() => {
              setForm(EMPTY_FORM);
              setFormError(null);
              setStep("form");
            }}
            onRevoke={() => void handleRevoke()}
          />
        )}

        {step === "form" && (
          <FormView
            form={form}
            onChange={setForm}
            error={formError}
            onContinue={() => void handleBuildClaim()}
          />
        )}

        {step === "review" && claim !== null && (
          <ReviewView
            claim={claim}
            form={form}
            phraseSaved={phraseSaved}
            onPhraseSaved={setPhraseSaved}
            onConfirm={() => void handleRegister()}
          />
        )}

        {step === "submitting" && (
          <div className="ext-card" style={{ padding: 16, textAlign: "center" }}>
            <div style={{ fontSize: 13, color: "var(--fg-200)" }}>
              Submitting to the spending-policy precompile…
            </div>
          </div>
        )}

        {step === "success" && (
          <SuccessView
            txHash={txHash}
            subAccount={claim?.subAccountBech32m ?? policy?.address ?? null}
            onDone={resetToOverview}
          />
        )}

        {step === "error" && (
          <ErrorView error={submitError} onRetry={resetToOverview} />
        )}
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Overview
// ─────────────────────────────────────────────────────────────────────────────

function OverviewView({
  principalAddr,
  lookupAddr,
  onLookupAddr,
  onLookup,
  loading,
  policy,
  error,
  onCreate,
  onRevoke,
}: {
  principalAddr: string;
  lookupAddr: string;
  onLookupAddr: (v: string) => void;
  onLookup: () => void;
  loading: boolean;
  policy: SpendingPolicyView | null;
  error: string | null;
  onCreate: () => void;
  onRevoke: () => void;
}) {
  return (
    <>
      <div className="ext-card" style={{ padding: 12 }}>
        <div style={cardTitle}>Agent commerce · §18.8</div>
        <p style={hint}>
          Create an agent sub-account, fund it, and bind a chain-enforced
          spending policy. Violating transactions are rejected at admission.
        </p>
        <div style={{ ...mono, marginTop: 6 }}>
          Principal: {shortAddr(principalAddr)}
        </div>
        <button style={primaryBtn} onClick={onCreate}>
          Create agent policy
        </button>
      </div>

      <div className="ext-card" style={{ padding: 12 }}>
        <div style={cardTitle}>Look up a live policy</div>
        <p style={hint}>Read a sub-account&apos;s current spending policy.</p>
        <input
          style={input}
          placeholder="mono1… or 0x… sub-account"
          value={lookupAddr}
          onChange={(e) => onLookupAddr(e.target.value)}
        />
        <button
          style={secondaryBtn}
          onClick={onLookup}
          disabled={loading || lookupAddr.trim().length === 0}
        >
          {loading ? "Reading…" : "Read policy"}
        </button>

        {error !== null && (
          <div style={errBox}>Policy unavailable: {error}</div>
        )}

        {policy !== null && <PolicySummary policy={policy} onRevoke={onRevoke} />}
      </div>
    </>
  );
}

function PolicySummary({
  policy,
  onRevoke,
}: {
  policy: SpendingPolicyView;
  onRevoke: () => void;
}) {
  const window = policy.timeOfDayWindow;
  return (
    <div style={{ marginTop: 10 }}>
      <SummaryRow label="Sub-account" value={shortAddr(policy.address)} mono />
      <SummaryRow label="Exists" value={policy.exists ? "yes" : "no"} />
      <SummaryRow
        label="Status"
        value={policy.enabled ? "enabled" : "disabled / revoked"}
      />
      <SummaryRow label="Version" value={String(policy.version)} />
      <SummaryRow label="Per-tx cap" value={capDisplay(policy.perTxCap)} />
      <SummaryRow label="Daily cap" value={capDisplay(policy.dailyCap)} />
      <SummaryRow label="Weekly cap" value={capDisplay(policy.weeklyCap)} />
      <SummaryRow label="Monthly cap" value={capDisplay(policy.monthlyCap)} />
      <SummaryRow
        label="Time window"
        value={
          window === null
            ? "—"
            : `${pad2(window.startHour)}:00–${pad2(window.endHour)}:00`
        }
      />
      <SummaryRow
        label="Expires"
        value={
          policy.expiryUnixSeconds === null
            ? "never"
            : new Date(policy.expiryUnixSeconds * 1000).toISOString().slice(0, 10)
        }
      />
      {policy.exists && policy.enabled && (
        <button style={dangerBtn} onClick={onRevoke}>
          Revoke policy
        </button>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Form
// ─────────────────────────────────────────────────────────────────────────────

function FormView({
  form,
  onChange,
  error,
  onContinue,
}: {
  form: FormState;
  onChange: (f: FormState) => void;
  error: string | null;
  onContinue: () => void;
}) {
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    onChange({ ...form, [key]: value });

  return (
    <>
      <div className="ext-card" style={{ padding: 12 }}>
        <div style={cardTitle}>Spending caps (LYTH)</div>
        <p style={hint}>Leave a field blank for no cap on that dimension.</p>
        <LabeledInput
          label="Per-transaction cap"
          value={form.perTxCapLyth}
          onChange={(v) => set("perTxCapLyth", v)}
        />
        <LabeledInput
          label="Daily cap"
          value={form.dailyCapLyth}
          onChange={(v) => set("dailyCapLyth", v)}
        />
        <LabeledInput
          label="Weekly cap"
          value={form.weeklyCapLyth}
          onChange={(v) => set("weeklyCapLyth", v)}
        />
        <LabeledInput
          label="Monthly cap"
          value={form.monthlyCapLyth}
          onChange={(v) => set("monthlyCapLyth", v)}
        />
      </div>

      <div className="ext-card" style={{ padding: 12 }}>
        <div style={cardTitle}>Allow / deny lists</div>
        <p style={hint}>
          Optional 32-byte Merkle roots (0x…). Leave blank for no
          constraint. Multi-entry list builders are a follow-up.
        </p>
        <LabeledInput
          label="Counterparty allow root"
          value={form.allowRoot}
          onChange={(v) => set("allowRoot", v)}
          placeholder="0x… (32 bytes)"
        />
        <LabeledInput
          label="Counterparty deny root"
          value={form.denyRoot}
          onChange={(v) => set("denyRoot", v)}
          placeholder="0x… (32 bytes)"
        />
        <LabeledInput
          label="Category allow root"
          value={form.categoryAllowRoot}
          onChange={(v) => set("categoryAllowRoot", v)}
          placeholder="0x… (32 bytes)"
        />
      </div>

      <div className="ext-card" style={{ padding: 12 }}>
        <div style={cardTitle}>Time-of-day window</div>
        <label style={checkRow}>
          <input
            type="checkbox"
            checked={form.windowEnabled}
            onChange={(e) => set("windowEnabled", e.target.checked)}
          />
          <span>Restrict spending to a daily window</span>
        </label>
        {form.windowEnabled && (
          <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
            <LabeledInput
              label="Start hour (0–23)"
              value={form.windowStartHour}
              onChange={(v) => set("windowStartHour", v)}
            />
            <LabeledInput
              label="End hour (0–23)"
              value={form.windowEndHour}
              onChange={(v) => set("windowEndHour", v)}
            />
          </div>
        )}
      </div>

      <div className="ext-card" style={{ padding: 12 }}>
        <div style={cardTitle}>Expiry &amp; funding</div>
        <LabeledInput
          label="Policy expiry (yyyy-mm-dd, blank = never)"
          value={form.expiryDate}
          onChange={(v) => set("expiryDate", v)}
          placeholder="2027-01-01"
        />
        <LabeledInput
          label="Fund sub-account now (LYTH, optional)"
          value={form.fundLyth}
          onChange={(v) => set("fundLyth", v)}
        />
      </div>

      {error !== null && <div style={errBox}>{error}</div>}

      <button style={primaryBtn} onClick={onContinue}>
        Continue
      </button>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Review
// ─────────────────────────────────────────────────────────────────────────────

function ReviewView({
  claim,
  form,
  phraseSaved,
  onPhraseSaved,
  onConfirm,
}: {
  claim: Extract<BgBuildSpendingPolicyClaimReply, { ok: true }>;
  form: FormState;
  phraseSaved: boolean;
  onPhraseSaved: (v: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <>
      <div className="ext-card" style={{ padding: 12 }}>
        <div style={cardTitle}>Agent sub-account</div>
        <SummaryRow label="Address" value={shortAddr(claim.subAccountBech32m)} mono />
        <SummaryRow label="Submits to" value={shortAddr(claim.to)} mono />
      </div>

      <div
        className="ext-card"
        style={{ padding: 12, borderColor: "var(--err, #ff8a9a)" }}
      >
        <div style={{ ...cardTitle, color: "var(--err, #ff8a9a)" }}>
          Save the recovery phrase
        </div>
        <p style={hint}>
          This is the agent sub-account&apos;s only key. You need it to fund
          or re-manage the sub-account later. It is shown once.
        </p>
        <div style={phraseBox}>{claim.subAccountMnemonic}</div>
        <label style={checkRow}>
          <input
            type="checkbox"
            checked={phraseSaved}
            onChange={(e) => onPhraseSaved(e.target.checked)}
          />
          <span>I saved the recovery phrase.</span>
        </label>
      </div>

      <div className="ext-card" style={{ padding: 12 }}>
        <div style={cardTitle}>What happens on confirm</div>
        <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "var(--fg-200)" }}>
          {form.fundLyth.trim() !== "" && (
            <li>Send {form.fundLyth.trim()} LYTH to the sub-account.</li>
          )}
          <li>Register the policy on-chain (selector 0x35531f6c, 0x110C).</li>
        </ol>
        <p style={{ ...hint, marginTop: 8 }}>
          The precompile may be milestone-gated on the active network. If
          it is, the chain returns a typed error and nothing is committed.
        </p>
      </div>

      <button style={primaryBtn} onClick={onConfirm} disabled={!phraseSaved}>
        Fund &amp; register
      </button>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Success / Error
// ─────────────────────────────────────────────────────────────────────────────

function SuccessView({
  txHash,
  subAccount,
  onDone,
}: {
  txHash: string | null;
  subAccount: string | null;
  onDone: () => void;
}) {
  return (
    <div className="ext-card" style={{ padding: 16, textAlign: "center" }}>
      <Icon name="check" size={28} />
      <div style={{ fontSize: 14, fontWeight: 600, margin: "8px 0" }}>
        Submitted
      </div>
      {subAccount !== null && (
        <div style={{ ...mono, marginBottom: 6 }}>{shortAddr(subAccount)}</div>
      )}
      {txHash !== null && (
        <div style={{ ...mono, fontSize: 10, wordBreak: "break-all" }}>{txHash}</div>
      )}
      <button style={{ ...primaryBtn, marginTop: 12 }} onClick={onDone}>
        Done
      </button>
    </div>
  );
}

function ErrorView({
  error,
  onRetry,
}: {
  error: SubmitError | null;
  onRetry: () => void;
}) {
  return (
    <div className="ext-card" style={{ padding: 16 }}>
      <div style={{ ...cardTitle, color: "var(--err, #ff8a9a)" }}>
        Transaction rejected
      </div>
      <p style={{ fontSize: 12, color: "var(--fg-200)", wordBreak: "break-word" }}>
        {error?.message ?? "Unknown error."}
      </p>
      {error?.code != null && <div style={mono}>code: {error.code}</div>}
      {error?.via != null && <div style={mono}>via: {error.via}</div>}
      <button style={{ ...primaryBtn, marginTop: 12 }} onClick={onRetry}>
        Back to start
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Small presentational helpers
// ─────────────────────────────────────────────────────────────────────────────

function LabeledInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label style={{ display: "block", marginTop: 8 }}>
      <div style={{ ...labelText }}>{label}</div>
      <input
        style={input}
        value={value}
        placeholder={placeholder ?? "0"}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function SummaryRow({
  label,
  value,
  mono: isMono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        padding: "5px 0",
        fontSize: 12,
        borderBottom: "1px solid rgba(255,255,255,0.04)",
      }}
    >
      <span style={{ color: "var(--fg-300)" }}>{label}</span>
      <span
        style={{
          color: "var(--fg-100)",
          fontFamily: isMono ? "var(--f-mono)" : "var(--f-sans)",
        }}
      >
        {value}
      </span>
    </div>
  );
}

/** Render a `0x`-hex `uint256` cap as a LYTH decimal, or "no cap" for
 *  zero. */
function capDisplay(hexCap: string): string {
  const v = parseHexQuantity(hexCap);
  if (v === null || v === 0n) return "no cap";
  return `${lythoshiToLythDecimal(v)} LYTH`;
}

function shortAddr(a: string): string {
  if (a.length <= 16) return a;
  return `${a.slice(0, 10)}…${a.slice(-6)}`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

const cardTitle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--fg-300)",
  marginBottom: 6,
};

const hint: CSSProperties = {
  fontSize: 11.5,
  color: "var(--fg-300)",
  margin: "0 0 8px",
  lineHeight: 1.5,
};

const labelText: CSSProperties = {
  fontSize: 11,
  color: "var(--fg-300)",
  marginBottom: 3,
};

const mono: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 11,
  color: "var(--fg-300)",
};

const input: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "9px 10px",
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 8,
  color: "var(--fg-100)",
  fontSize: 13,
  fontFamily: "var(--f-mono)",
};

const checkRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginTop: 8,
  fontSize: 12,
  color: "var(--fg-200)",
};

const primaryBtn: CSSProperties = {
  width: "100%",
  marginTop: 12,
  padding: "11px 14px",
  background: "var(--gold, #F2B441)",
  color: "#1a1408",
  border: "none",
  borderRadius: 9,
  fontSize: 13.5,
  fontWeight: 600,
  cursor: "pointer",
};

const secondaryBtn: CSSProperties = {
  width: "100%",
  marginTop: 8,
  padding: "10px 14px",
  background: "rgba(255,255,255,0.06)",
  color: "var(--fg-100)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 9,
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
};

const dangerBtn: CSSProperties = {
  width: "100%",
  marginTop: 10,
  padding: "10px 14px",
  background: "transparent",
  color: "var(--err, #ff8a9a)",
  border: "1px solid var(--err, #ff8a9a)",
  borderRadius: 9,
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
};

const errBox: CSSProperties = {
  marginTop: 10,
  padding: "8px 10px",
  background: "rgba(255,80,100,0.08)",
  border: "1px solid rgba(255,80,100,0.2)",
  borderRadius: 8,
  fontSize: 12,
  color: "var(--err, #ff8a9a)",
};

const phraseBox: CSSProperties = {
  marginTop: 8,
  padding: "10px 12px",
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 8,
  fontFamily: "var(--f-mono)",
  fontSize: 12.5,
  lineHeight: 1.7,
  color: "var(--fg-100)",
  wordSpacing: "0.2em",
};
