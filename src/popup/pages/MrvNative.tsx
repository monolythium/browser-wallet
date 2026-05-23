import { useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

import { Icon } from "../Icon";
import {
  bgWalletBuildMrvCallPlan,
  bgWalletBuildMrvDeployPlan,
  type WalletMrvNativeSubmissionPlan,
} from "../bg";

type DeployPlanArgs = Parameters<typeof bgWalletBuildMrvDeployPlan>[0];
type CallPlanArgs = Parameters<typeof bgWalletBuildMrvCallPlan>[0];

export type MrvNativeMode = "deploy" | "call";

export interface MrvNativeProps {
  chainIdHex: string;
  onBack: () => void;
}

export interface MrvNativeFormValues {
  artifactBytes: string;
  artifactHash: string;
  contractAddress: string;
  callInput: string;
  executionUnitLimit: string;
  maxExecutionFeeLythoshi: string;
  priorityTipLythoshi: string;
  valueLythoshi: string;
}

type BuildRequest =
  | { ok: true; mode: "deploy"; args: DeployPlanArgs }
  | { ok: true; mode: "call"; args: CallPlanArgs }
  | { ok: false; reason: string };

const DEFAULT_FORM: MrvNativeFormValues = {
  artifactBytes: "",
  artifactHash: "",
  contractAddress: "",
  callInput: "0x",
  executionUnitLimit: "1000000",
  maxExecutionFeeLythoshi: "",
  priorityTipLythoshi: "",
  valueLythoshi: "0",
};

export function MrvNative({ chainIdHex, onBack }: MrvNativeProps) {
  const [mode, setMode] = useState<MrvNativeMode>("deploy");
  const [form, setForm] = useState<MrvNativeFormValues>(DEFAULT_FORM);
  const [plan, setPlan] = useState<WalletMrvNativeSubmissionPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const buildRequest = useMemo(
    () => buildMrvNativeRequest(mode, form, chainIdHex),
    [mode, form, chainIdHex],
  );

  const setField = <K extends keyof MrvNativeFormValues>(
    key: K,
    value: MrvNativeFormValues[K],
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setPlan(null);
    setError(null);
  };

  const handleBuild = async () => {
    setPlan(null);
    setError(null);
    if (!buildRequest.ok) {
      setError(buildRequest.reason);
      return;
    }
    setBusy(true);
    try {
      const r =
        buildRequest.mode === "deploy"
          ? await bgWalletBuildMrvDeployPlan(buildRequest.args)
          : await bgWalletBuildMrvCallPlan(buildRequest.args);
      if (r.ok) {
        setPlan(r.plan);
      } else {
        setError(r.reason ?? "MRV native plan builder failed");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div
          style={{ flex: 1, fontSize: 13, fontWeight: 600, textAlign: "center" }}
        >
          MRV native
        </div>
        <div style={{ width: 36 }} />
      </div>

      <div className="ext-body">
        <div className="ext-card" style={{ padding: 14 }}>
          <div className="ext-card__head">
            <h3>Native contract preview</h3>
          </div>
          <div style={bodyCopy}>
            Build a v4.1 MRV native contract deploy or call plan. This page
            previews execution units, lythoshi fees, typed addresses, and the
            JSON-safe transaction extension only; it does not sign or submit.
          </div>
          <div style={chainPill}>Chain {chainIdHex}</div>
        </div>

        <div className="ext-card" style={{ padding: 14 }}>
          <div
            className="ext-tabs"
            role="tablist"
            aria-label="MRV native plan mode"
            style={{ marginTop: 0 }}
          >
            <button
              role="tab"
              aria-selected={mode === "deploy"}
              className={mode === "deploy" ? "on" : undefined}
              onClick={() => {
                setMode("deploy");
                setPlan(null);
                setError(null);
              }}
              type="button"
            >
              Deploy
            </button>
            <button
              role="tab"
              aria-selected={mode === "call"}
              className={mode === "call" ? "on" : undefined}
              onClick={() => {
                setMode("call");
                setPlan(null);
                setError(null);
              }}
              type="button"
            >
              Call
            </button>
          </div>

          {mode === "deploy" ? (
            <>
              <Field label="Artifact bytes">
                <textarea
                  value={form.artifactBytes}
                  onChange={(e) => setField("artifactBytes", e.target.value.trim())}
                  placeholder="0x13000000..."
                  spellCheck={false}
                  style={textAreaStyle}
                />
              </Field>
              <Field label="Artifact hash optional">
                <input
                  value={form.artifactHash}
                  onChange={(e) => setField("artifactHash", e.target.value.trim())}
                  placeholder="0x + 32-byte hash"
                  spellCheck={false}
                  style={inputStyle}
                />
              </Field>
            </>
          ) : (
            <>
              <Field label="Native contract">
                <input
                  value={form.contractAddress}
                  onChange={(e) => setField("contractAddress", e.target.value.trim())}
                  placeholder="0x... or monoc1..."
                  spellCheck={false}
                  style={inputStyle}
                />
              </Field>
              <Field label="Call input bytes">
                <textarea
                  value={form.callInput}
                  onChange={(e) => setField("callInput", e.target.value.trim())}
                  placeholder="0xaabbccdd"
                  spellCheck={false}
                  style={textAreaStyle}
                />
              </Field>
            </>
          )}

          <Field label="Execution unit limit">
            <input
              value={form.executionUnitLimit}
              onChange={(e) => setField("executionUnitLimit", e.target.value.trim())}
              placeholder="1000000 or 0xf4240"
              inputMode="text"
              spellCheck={false}
              style={inputStyle}
            />
          </Field>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <Field label="Max fee lythoshi">
              <input
                value={form.maxExecutionFeeLythoshi}
                onChange={(e) =>
                  setField("maxExecutionFeeLythoshi", e.target.value.trim())
                }
                placeholder="auto"
                inputMode="text"
                spellCheck={false}
                style={inputStyle}
              />
            </Field>
            <Field label="Priority tip">
              <input
                value={form.priorityTipLythoshi}
                onChange={(e) =>
                  setField("priorityTipLythoshi", e.target.value.trim())
                }
                placeholder="auto"
                inputMode="text"
                spellCheck={false}
                style={inputStyle}
              />
            </Field>
          </div>

          <Field label="Value lythoshi">
            <input
              value={form.valueLythoshi}
              onChange={(e) => setField("valueLythoshi", e.target.value.trim())}
              placeholder="0"
              inputMode="text"
              spellCheck={false}
              style={inputStyle}
            />
          </Field>

          {error && <div style={errorBox}>{error}</div>}

          <button
            onClick={() => void handleBuild()}
            disabled={busy}
            style={{
              ...primaryButton,
              opacity: busy ? 0.65 : 1,
              cursor: busy ? "default" : "pointer",
            }}
            type="button"
          >
            {busy ? "Building..." : `Build ${mode} plan`}
          </button>
        </div>

        {plan && <MrvNativePlanPreview plan={plan} />}
      </div>
    </>
  );
}

export function buildMrvNativeRequest(
  mode: MrvNativeMode,
  form: MrvNativeFormValues,
  chainIdHex: string,
): BuildRequest {
  const chainId = coerceHexQuantityInput(chainIdHex, "chain id", {
    required: true,
    allowZero: false,
  });
  if (!chainId.ok) return chainId;
  if (chainId.value === undefined) {
    return { ok: false, reason: "chain id is required" };
  }

  const executionUnitLimitHex = coerceHexQuantityInput(
    form.executionUnitLimit,
    "execution unit limit",
    { required: true, allowZero: false },
  );
  if (!executionUnitLimitHex.ok) return executionUnitLimitHex;
  if (executionUnitLimitHex.value === undefined) {
    return { ok: false, reason: "execution unit limit is required" };
  }

  const maxExecutionFeeLythoshiHex = coerceHexQuantityInput(
    form.maxExecutionFeeLythoshi,
    "max execution fee lythoshi",
    { required: false, allowZero: true },
  );
  if (!maxExecutionFeeLythoshiHex.ok) return maxExecutionFeeLythoshiHex;

  const priorityTipLythoshiHex = coerceHexQuantityInput(
    form.priorityTipLythoshi,
    "priority tip lythoshi",
    { required: false, allowZero: true },
  );
  if (!priorityTipLythoshiHex.ok) return priorityTipLythoshiHex;

  const valueWeiHex = coerceHexQuantityInput(form.valueLythoshi, "value lythoshi", {
    required: false,
    allowZero: true,
  });
  if (!valueWeiHex.ok) return valueWeiHex;

  const base = {
    chainIdHex: chainId.value,
    executionUnitLimitHex: executionUnitLimitHex.value,
    ...(maxExecutionFeeLythoshiHex.value !== undefined
      ? { maxExecutionFeeLythoshiHex: maxExecutionFeeLythoshiHex.value }
      : {}),
    ...(priorityTipLythoshiHex.value !== undefined
      ? { priorityTipLythoshiHex: priorityTipLythoshiHex.value }
      : {}),
    ...(valueWeiHex.value !== undefined ? { valueWeiHex: valueWeiHex.value } : {}),
  };

  if (mode === "deploy") {
    const artifactBytes = normalizeHexBytesInput(
      form.artifactBytes,
      "artifact bytes",
      { required: true, allowEmptyBytes: false },
    );
    if (!artifactBytes.ok) return artifactBytes;
    if (artifactBytes.value === undefined) {
      return { ok: false, reason: "artifact bytes is required" };
    }
    const artifactHash = normalizeHexBytesInput(
      form.artifactHash,
      "artifact hash",
      { required: false, allowEmptyBytes: false },
    );
    if (!artifactHash.ok) return artifactHash;
    return {
      ok: true,
      mode,
      args: {
        ...base,
        artifactBytes: artifactBytes.value,
        ...(artifactHash.value !== undefined ? { artifactHash: artifactHash.value } : {}),
      },
    };
  }

  const input = normalizeHexBytesInput(form.callInput, "call input", {
    required: true,
    allowEmptyBytes: true,
  });
  if (!input.ok) return input;
  if (input.value === undefined) {
    return { ok: false, reason: "call input is required" };
  }
  const contractAddress = form.contractAddress.trim();
  if (contractAddress.length === 0) {
    return { ok: false, reason: "native contract address is required" };
  }
  return {
    ok: true,
    mode,
    args: {
      ...base,
      contractAddress,
      input: input.value,
    },
  };
}

export function coerceHexQuantityInput(
  raw: string,
  field: string,
  opts: { required: boolean; allowZero: boolean },
): { ok: true; value: string | undefined } | { ok: false; reason: string } {
  const value = raw.trim();
  if (value.length === 0) {
    return opts.required
      ? { ok: false, reason: `${field} is required` }
      : { ok: true, value: undefined };
  }
  if (/^0x[0-9a-fA-F]+$/.test(value)) {
    return canonicalQuantity(BigInt(value), field, opts.allowZero);
  }
  if (/^[0-9]+$/.test(value)) {
    return canonicalQuantity(BigInt(value), field, opts.allowZero);
  }
  return {
    ok: false,
    reason: `${field} must be a non-negative integer or 0x hex quantity`,
  };
}

function canonicalQuantity(
  value: bigint,
  field: string,
  allowZero: boolean,
): { ok: true; value: string } | { ok: false; reason: string } {
  if (value === 0n && !allowZero) {
    return { ok: false, reason: `${field} must be greater than zero` };
  }
  return { ok: true, value: `0x${value.toString(16)}` };
}

function normalizeHexBytesInput(
  raw: string,
  field: string,
  opts: { required: boolean; allowEmptyBytes: boolean },
): { ok: true; value: string | undefined } | { ok: false; reason: string } {
  const value = raw.trim();
  if (value.length === 0) {
    return opts.required
      ? { ok: false, reason: `${field} is required` }
      : { ok: true, value: undefined };
  }
  if (!/^0x[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0) {
    return { ok: false, reason: `${field} must be even-length 0x hex bytes` };
  }
  if (!opts.allowEmptyBytes && value.length === 2) {
    return { ok: false, reason: `${field} cannot be empty` };
  }
  return { ok: true, value: `0x${value.slice(2).toLowerCase()}` };
}

export function MrvNativePlanPreview({
  plan,
}: {
  plan: WalletMrvNativeSubmissionPlan;
}) {
  const nativeContract =
    plan.kind === "mrv_deploy"
      ? plan.expectedContractAddress ?? "computed after deploy"
      : plan.request.contractAddress ?? plan.tx.to ?? "-";

  return (
    <div className="ext-card" style={{ padding: 14 }}>
      <div className="ext-card__head">
        <h3>Plan preview</h3>
      </div>

      <div style={summaryGrid}>
        <SummaryRow label="Kind" value={plan.kind === "mrv_deploy" ? "Deploy" : "Call"} />
        <SummaryRow label="Typed user address" value={plan.request.from ?? "-"} />
        <SummaryRow label="Native contract" value={nativeContract} />
        <SummaryRow
          label="Execution units"
          value={plan.nativeTx.executionUnitLimit}
        />
        <SummaryRow
          label="Max fee"
          value={`${plan.nativeTx.maxExecutionFeeLythoshi} lythoshi`}
        />
        <SummaryRow
          label="Priority tip"
          value={`${plan.nativeTx.priorityTipLythoshi} lythoshi`}
        />
        <SummaryRow
          label="Total preview"
          value={`${plan.feePreview.totalLythoshi} lythoshi (${plan.feePreview.totalLyth} LYTH)`}
        />
        <SummaryRow
          label="Extension"
          value={`kind ${plan.extension.kind} / ${plan.extension.bodyHex}`}
        />
      </div>

      <div style={jsonLabel}>JSON-safe plan</div>
      <pre aria-label="MRV native plan JSON" style={jsonBlock}>
        {JSON.stringify(plan, null, 2)}
      </pre>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={summaryRow}>
      <div style={summaryLabel}>{label}</div>
      <div style={summaryValue}>{value}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={fieldWrap}>
      <span style={fieldLabel}>{label}</span>
      {children}
    </label>
  );
}

const bodyCopy: CSSProperties = {
  fontSize: 11.5,
  color: "var(--fg-300)",
  lineHeight: 1.5,
};

const chainPill: CSSProperties = {
  marginTop: 10,
  display: "inline-flex",
  padding: "4px 8px",
  borderRadius: 6,
  border: "1px solid rgba(242,180,65,0.35)",
  background: "rgba(242,180,65,0.08)",
  color: "var(--gold)",
  fontFamily: "var(--f-mono)",
  fontSize: 10,
};

const fieldWrap: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  marginTop: 10,
};

const fieldLabel: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 10,
  color: "var(--fg-400)",
  letterSpacing: "0.14em",
  textTransform: "uppercase",
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 10,
  background: "rgba(0,0,0,0.3)",
  border: "1px solid var(--fg-700)",
  color: "var(--fg-100)",
  fontSize: 12.5,
  fontFamily: "var(--f-mono)",
  boxSizing: "border-box",
};

const textAreaStyle: CSSProperties = {
  ...inputStyle,
  minHeight: 82,
  resize: "vertical",
  lineHeight: 1.45,
};

const primaryButton: CSSProperties = {
  width: "100%",
  marginTop: 12,
  padding: "11px 12px",
  borderRadius: 10,
  border: "1px solid var(--gold)",
  background: "linear-gradient(180deg, var(--gold-hi), var(--gold))",
  color: "var(--ink-000)",
  fontFamily: "var(--f-sans)",
  fontSize: 12.5,
  fontWeight: 650,
};

const errorBox: CSSProperties = {
  marginTop: 10,
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid rgba(220,80,80,0.4)",
  background: "rgba(220,80,80,0.08)",
  color: "var(--err)",
  fontFamily: "var(--f-mono)",
  fontSize: 10.5,
  lineHeight: 1.45,
};

const summaryGrid: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 7,
};

const summaryRow: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "112px minmax(0, 1fr)",
  gap: 8,
  alignItems: "start",
};

const summaryLabel: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 9.5,
  color: "var(--fg-500)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
};

const summaryValue: CSSProperties = {
  minWidth: 0,
  color: "var(--fg-100)",
  fontFamily: "var(--f-mono)",
  fontSize: 10.5,
  lineHeight: 1.4,
  wordBreak: "break-all",
};

const jsonLabel: CSSProperties = {
  ...fieldLabel,
  marginTop: 14,
  marginBottom: 6,
};

const jsonBlock: CSSProperties = {
  maxHeight: 260,
  overflow: "auto",
  margin: 0,
  padding: 10,
  borderRadius: 8,
  border: "1px solid var(--fg-700)",
  background: "rgba(0,0,0,0.32)",
  color: "var(--fg-200)",
  fontFamily: "var(--f-mono)",
  fontSize: 10,
  lineHeight: 1.45,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};
