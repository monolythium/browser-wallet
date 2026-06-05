import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

import { Icon } from "../Icon";
import {
  bgNativeMarketOrderBookDeltas,
  bgWalletChainBlockNumber,
  bgWalletBuildMrvCallPlan,
  bgWalletBuildMrvDeployPlan,
  bgWalletMrvNativeReceiptStatus,
  bgWalletSubmitMrvNativePlan,
  type NativeMarketOrderBookDeltasOutcome,
  type SendTxResult,
  type WalletMrvNoEvmArchiveVerification,
  type WalletMrvNoEvmFinalityVerification,
  type WalletMrvNoEvmReceiptProofTranscript,
  type WalletMrvNoEvmReceiptProofVerification,
  type WalletMrvNativeReceipt,
  type WalletMrvNativeSubmissionPlan,
} from "../bg";
import { formatNativeLythAmount } from "../../shared/native-fee-display";
import { requireTypedMrvContractAddress } from "../../shared/mrv-native-plan.js";

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

interface MrvNativeSubmitError {
  message: string;
  code?: number;
  method?: string;
  via?: string;
}

export type MrvNativeReceiptState =
  | { phase: "idle" }
  | { phase: "polling"; via?: string }
  | { phase: "included"; receipt: WalletMrvNativeReceipt; via?: string }
  | { phase: "reverted"; receipt: WalletMrvNativeReceipt; via?: string }
  | { phase: "unknown"; receipt: WalletMrvNativeReceipt; via?: string }
  | { phase: "timeout" }
  | {
      phase: "unavailable";
      reason: string;
      code?: number;
      method?: string;
      via?: string;
    };

export type NativeMarketReplayReadinessState =
  | { phase: "loading" }
  | {
      phase: "ready";
      fromBlock: number;
      toBlock: number;
      operator: string | null;
      outcome: NativeMarketOrderBookDeltasOutcome;
    }
  | {
      phase: "unavailable";
      reason: string;
      fromBlock?: number;
      toBlock?: number;
      operator?: string | null;
    };

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

const MRV_RECEIPT_POLL_INTERVAL_MS = 5_000;
const MRV_RECEIPT_POLL_MAX_MS = 5 * 60_000;
const NATIVE_MARKET_REPLAY_LOOKBACK_BLOCKS = 128;
const NATIVE_MARKET_REPLAY_LIMIT = 5;
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const NATIVE_CONTRACT_PLACEHOLDER =
  "monoc1yg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zr6jfvd";

function formatMrvLythAmount(lythoshiDecimal: string): string {
  if (!/^[0-9]+$/.test(lythoshiDecimal)) return "—";
  return formatNativeLythAmount(BigInt(lythoshiDecimal));
}

export function MrvNative({ chainIdHex, onBack }: MrvNativeProps) {
  const [mode, setMode] = useState<MrvNativeMode>("deploy");
  const [form, setForm] = useState<MrvNativeFormValues>(DEFAULT_FORM);
  const [plan, setPlan] = useState<WalletMrvNativeSubmissionPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<SendTxResult | null>(null);
  const [submitError, setSubmitError] = useState<MrvNativeSubmitError | null>(null);
  const [receiptState, setReceiptState] = useState<MrvNativeReceiptState>({
    phase: "idle",
  });
  const [marketReplayState, setMarketReplayState] =
    useState<NativeMarketReplayReadinessState>({ phase: "loading" });
  const receiptPollStartedAtRef = useRef<number | null>(null);

  const buildRequest = useMemo(
    () => buildMrvNativeRequest(mode, form, chainIdHex),
    [mode, form, chainIdHex],
  );

  const resetSubmissionState = () => {
    setSubmitResult(null);
    setSubmitError(null);
    setReceiptState({ phase: "idle" });
    receiptPollStartedAtRef.current = null;
  };

  const setField = <K extends keyof MrvNativeFormValues>(
    key: K,
    value: MrvNativeFormValues[K],
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setPlan(null);
    setError(null);
    resetSubmissionState();
  };

  const handleBuild = async () => {
    setPlan(null);
    setError(null);
    resetSubmissionState();
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
        setError(r.reason ?? "RISC-V plan builder failed");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = async () => {
    if (plan === null || submitting || submitResult !== null) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      const r = await bgWalletSubmitMrvNativePlan({ plan, chainIdHex });
      if (r.ok) {
        setSubmitResult(r.result);
        setReceiptState({ phase: "polling" });
      } else {
        setSubmitError({
          message: r.reason ?? "RISC-V submission failed",
          ...(r.code !== undefined ? { code: r.code } : {}),
          ...(r.method !== undefined ? { method: r.method } : {}),
          ...(r.via !== undefined ? { via: r.via } : {}),
        });
      }
    } catch (e) {
      setSubmitError({ message: (e as Error).message });
    } finally {
      setSubmitting(false);
    }
  };

  const submittedTxHash = submitResult?.txHash ?? null;

  useEffect(() => {
    if (submittedTxHash === null) {
      receiptPollStartedAtRef.current = null;
      return;
    }
    if (!TX_HASH_RE.test(submittedTxHash)) {
      setReceiptState({
        phase: "unavailable",
        reason: "RISC-V receipt polling requires a 32-byte transaction hash",
      });
      return;
    }

    receiptPollStartedAtRef.current = Date.now();
    setReceiptState({ phase: "polling" });

    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    };

    const poll = async () => {
      if (cancelled) return;
      const startedAt = receiptPollStartedAtRef.current;
      if (
        startedAt !== null &&
        Date.now() - startedAt > MRV_RECEIPT_POLL_MAX_MS
      ) {
        setReceiptState({ phase: "timeout" });
        stop();
        return;
      }

      const r = await bgWalletMrvNativeReceiptStatus({
        txHash: submittedTxHash,
        chainIdHex,
      });
      if (cancelled) return;
      if (!r.ok) {
        setReceiptState({
          phase: "unavailable",
          reason: r.reason ?? "RISC-V receipt polling failed",
          ...(r.code !== undefined ? { code: r.code } : {}),
          ...(r.method !== undefined ? { method: r.method } : {}),
          ...(r.via !== undefined ? { via: r.via } : {}),
        });
        stop();
        return;
      }
      if (r.receipt === null) {
        setReceiptState((prev) => {
          const via = r.via ?? (prev.phase === "polling" ? prev.via : undefined);
          return {
            phase: "polling",
            ...(via !== undefined ? { via } : {}),
          };
        });
        return;
      }
      setReceiptState({
        phase: receiptPhase(r.receipt.status),
        receipt: r.receipt,
        ...(r.via !== undefined ? { via: r.via } : {}),
      });
      stop();
    };

    interval = setInterval(() => void poll(), MRV_RECEIPT_POLL_INTERVAL_MS);
    void poll();

    return () => {
      cancelled = true;
      stop();
    };
  }, [chainIdHex, submittedTxHash]);

  useEffect(() => {
    let cancelled = false;

    const checkReplayReadiness = async () => {
      setMarketReplayState({ phase: "loading" });
      try {
        const head = await bgWalletChainBlockNumber();
        if (cancelled) return;
        if (!head.ok) {
          setMarketReplayState({
            phase: "unavailable",
            reason: head.reason ?? "current block unavailable",
          });
          return;
        }

        const toBlock = parseSafeHexBlockNumber(head.blockHex);
        if (toBlock === null) {
          setMarketReplayState({
            phase: "unavailable",
            reason: `invalid block height ${head.blockHex}`,
            operator: head.operator,
          });
          return;
        }

        const fromBlock = Math.max(
          0,
          toBlock - NATIVE_MARKET_REPLAY_LOOKBACK_BLOCKS,
        );
        const reply = await bgNativeMarketOrderBookDeltas({
          fromBlock,
          toBlock,
          limit: NATIVE_MARKET_REPLAY_LIMIT,
        });
        if (cancelled) return;
        if (!reply.ok) {
          setMarketReplayState({
            phase: "unavailable",
            reason: reply.reason ?? "native market replay check failed",
            fromBlock,
            toBlock,
            operator: head.operator,
          });
          return;
        }

        setMarketReplayState({
          phase: "ready",
          fromBlock,
          toBlock,
          operator: head.operator,
          outcome: reply.outcome,
        });
      } catch (e) {
        if (cancelled) return;
        setMarketReplayState({
          phase: "unavailable",
          reason: (e as Error).message,
        });
      }
    };

    void checkReplayReadiness();

    return () => {
      cancelled = true;
    };
  }, [chainIdHex]);

  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div
          style={{
            flex: 1,
            fontSize: 13,
            fontWeight: 600,
            textAlign: "center",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
          }}
        >
          RISC-V
          <span
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 8.5,
              fontWeight: 600,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--fg-400)",
              border: "1px solid var(--fg-700)",
              borderRadius: 3,
              padding: "0 4px",
            }}
          >
            MRV
          </span>
        </div>
        <div style={{ width: 36 }} />
      </div>

      <div className="ext-body">
        <div className="ext-card" style={{ padding: 14 }}>
          <div className="ext-card__head">
            <h3>Native contract preview</h3>
          </div>
          <div style={bodyCopy}>
            Build a RISC-V (MRV native) contract deploy or call plan. This page
            previews execution units, native fees, typed addresses, and the
            JSON-safe transaction extension before signing. After submission,
            the wallet polls transaction receipt inclusion status when the RPC
            supports it; it does not prove live RISC-V execution.
          </div>
          <div style={chainPill}>Chain {chainIdHex}</div>
        </div>

        <NativeMarketReplayReadinessCard state={marketReplayState} />

        <div className="ext-card" style={{ padding: 14 }}>
          <div
            className="ext-tabs"
            role="tablist"
            aria-label="RISC-V plan mode"
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
                resetSubmissionState();
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
                resetSubmissionState();
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
                  placeholder={NATIVE_CONTRACT_PLACEHOLDER}
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
            <Field label="Max fee override">
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

          <Field label="Value">
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

        {plan && (
          <MrvNativePlanPreview
            plan={plan}
            onSubmit={() => void handleSubmit()}
            submitting={submitting}
            submitResult={submitResult}
            submitError={submitError}
            receiptState={receiptState}
          />
        )}
      </div>
    </>
  );
}

export function NativeMarketReplayReadinessCard({
  state,
}: {
  state: NativeMarketReplayReadinessState;
}) {
  if (state.phase === "loading") {
    return (
      <div className="ext-card" style={{ padding: 14 }}>
        <div className="ext-card__head">
          <h3>Native market replay</h3>
        </div>
        <div style={bodyCopy}>Checking recent orderbook replay status...</div>
      </div>
    );
  }

  if (state.phase === "unavailable") {
    return (
      <div className="ext-card" style={{ padding: 14 }}>
        <div className="ext-card__head">
          <h3>Native market replay</h3>
        </div>
        <div style={replayStatusRow}>
          <span style={replayStatusWarn}>unavailable</span>
          {state.fromBlock !== undefined && state.toBlock !== undefined && (
            <span style={submitMeta}>
              blocks {state.fromBlock}-{state.toBlock}
            </span>
          )}
        </div>
        <div style={submitMeta}>{state.reason}</div>
        {state.operator && <div style={submitMeta}>operator {state.operator}</div>}
        <div style={submitMeta}>No market rows shown from fallback data.</div>
      </div>
    );
  }

  const { outcome } = state;
  const deltas = outcome.data?.deltas ?? [];
  const isLive = outcome.kind === "live";
  const statusLabel =
    outcome.kind === "live"
      ? "Replay endpoint live"
      : outcome.kind === "mock-not-deployed"
        ? "Replay endpoint not deployed"
        : outcome.kind === "mock-error"
          ? "Replay response rejected"
          : "Replay endpoint offline";

  return (
    <div className="ext-card" style={{ padding: 14 }}>
      <div className="ext-card__head">
        <h3>Native market replay</h3>
      </div>
      <div style={replayStatusRow}>
        <span style={isLive ? replayStatusLive : replayStatusWarn}>
          {statusLabel}
        </span>
        <span style={submitMeta}>
          blocks {state.fromBlock}-{state.toBlock}
        </span>
      </div>
      <div style={submitMeta}>
        {state.operator ? `operator ${state.operator}` : "operator unknown"}
        {` · ${outcome.durationMs}ms`}
      </div>
      {isLive && outcome.data !== null ? (
        <>
          <div style={submitMeta}>
            Rows returned {deltas.length}
            {outcome.data.nextCursor ? " · more pages available" : ""}
          </div>
          {readReplaySourceLabel(outcome.data.source) && (
            <div style={submitMeta}>
              source {readReplaySourceLabel(outcome.data.source)}
            </div>
          )}
          {deltas.length === 0 ? (
            <div style={submitMeta}>No replay deltas returned for this window.</div>
          ) : (
            <div style={replayDeltaList}>
              {deltas.slice(0, 3).map((delta) => (
                <div
                  key={`${delta.blockHeight}:${delta.txIndex}:${delta.logIndex}:${delta.orderId}`}
                  style={replayDeltaRow}
                >
                  <div style={receiptTitle}>
                    {delta.action} · {delta.eventName}
                  </div>
                  <div style={submitMeta}>
                    block {delta.blockHeight} · {delta.side ?? "side -"}{" "}
                    {delta.price ?? "-"} @ {delta.remaining ?? delta.quantity ?? "-"}
                  </div>
                  <div style={monoWrap}>
                    {shortReplayId(delta.marketId)} / {shortReplayId(delta.orderId)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          {"reason" in outcome && <div style={submitMeta}>{outcome.reason}</div>}
          <div style={submitMeta}>No market rows shown from fallback data.</div>
        </>
      )}
    </div>
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
    "max execution fee",
    { required: false, allowZero: true },
  );
  if (!maxExecutionFeeLythoshiHex.ok) return maxExecutionFeeLythoshiHex;

  const priorityTipLythoshiHex = coerceHexQuantityInput(
    form.priorityTipLythoshi,
    "priority tip",
    { required: false, allowZero: true },
  );
  if (!priorityTipLythoshiHex.ok) return priorityTipLythoshiHex;

  const valueWeiHex = coerceHexQuantityInput(form.valueLythoshi, "value", {
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
  let typedContractAddress: string;
  try {
    typedContractAddress = requireTypedMrvContractAddress(contractAddress).typed;
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  return {
    ok: true,
    mode,
    args: {
      ...base,
      contractAddress: typedContractAddress,
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
  onSubmit,
  submitting = false,
  submitResult = null,
  submitError = null,
  receiptState = { phase: "idle" },
  submitDisabledReason = null,
}: {
  plan: WalletMrvNativeSubmissionPlan;
  onSubmit?: () => void;
  submitting?: boolean;
  submitResult?: SendTxResult | null;
  submitError?: MrvNativeSubmitError | null;
  receiptState?: MrvNativeReceiptState;
  submitDisabledReason?: string | null;
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
          value={formatMrvLythAmount(plan.nativeTx.maxExecutionFeeLythoshi)}
        />
        <SummaryRow
          label="Priority tip"
          value={formatMrvLythAmount(plan.nativeTx.priorityTipLythoshi)}
        />
        <SummaryRow
          label="Total preview"
          value={formatMrvLythAmount(plan.feePreview.totalLythoshi)}
        />
        <SummaryRow
          label="Extension"
          value={`kind ${plan.extension.kind} / ${plan.extension.bodyHex}`}
        />
      </div>

      <div style={jsonLabel}>JSON-safe plan</div>
      <pre aria-label="RISC-V plan JSON" style={jsonBlock}>
        {JSON.stringify(plan, null, 2)}
      </pre>

      {onSubmit && (
        <>
          {submitDisabledReason && (
            <div style={warningBox}>{submitDisabledReason}</div>
          )}
          {submitError && (
            <div style={errorBox}>
              <div>{submitError.message}</div>
              {(submitError.method || submitError.via || submitError.code !== undefined) && (
                <div style={submitMeta}>
                  {submitError.method ? `RPC ${submitError.method}` : "Submission"}
                  {submitError.via ? ` via ${submitError.via}` : ""}
                  {submitError.code !== undefined ? ` (code ${submitError.code})` : ""}
                </div>
              )}
            </div>
          )}
          {submitResult && (
            <div style={successBox}>
              <div style={{ fontWeight: 700 }}>Transaction submitted</div>
              <div style={submitMeta}>Via {submitResult.via}</div>
              <div style={monoWrap}>{submitResult.txHash}</div>
              <div style={submitMeta}>
                Receipt polling checks transaction inclusion; no-EVM transcript
                self-check runs after native evidence is returned.
              </div>
              <MrvNativeReceiptStatus state={receiptState} />
            </div>
          )}
          <button
            onClick={onSubmit}
            disabled={submitting || submitResult !== null || submitDisabledReason !== null}
            style={{
              ...primaryButton,
              opacity:
                submitting || submitResult !== null || submitDisabledReason !== null
                  ? 0.65
                  : 1,
              cursor:
                submitting || submitResult !== null || submitDisabledReason !== null
                  ? "default"
                  : "pointer",
            }}
            type="button"
          >
            {submitting
              ? "Submitting..."
              : submitResult
                ? "Submitted"
                : "Sign and submit"}
          </button>
        </>
      )}
    </div>
  );
}

function MrvNativeReceiptStatus({ state }: { state: MrvNativeReceiptState }) {
  if (state.phase === "idle") return null;

  if (state.phase === "polling") {
    return (
      <div style={receiptBox}>
        <div style={receiptTitle}>Receipt status: waiting for inclusion</div>
        <div style={submitMeta}>
          Polling eth_getTransactionReceipt
          {state.via ? ` via ${state.via}` : ""}.
        </div>
        <div style={submitMeta}>Native receipt evidence is checked after inclusion.</div>
        <div style={submitMeta}>Anchor-level round finality is not established here.</div>
      </div>
    );
  }

  if (state.phase === "timeout") {
    return (
      <div style={warningBox}>
        <div style={receiptTitle}>Receipt status unavailable</div>
        <div style={submitMeta}>
          No receipt returned within this popup polling window.
        </div>
        <div style={submitMeta}>No receipt transcript self-check is available.</div>
      </div>
    );
  }

  if (state.phase === "unavailable") {
    return (
      <div style={warningBox}>
        <div style={receiptTitle}>Receipt polling unavailable</div>
        <div style={submitMeta}>{state.reason}</div>
        {(state.method || state.via || state.code !== undefined) && (
          <div style={submitMeta}>
            {state.method ? `RPC ${state.method}` : "Receipt RPC"}
            {state.via ? ` via ${state.via}` : ""}
            {state.code !== undefined ? ` (code ${state.code})` : ""}
          </div>
        )}
        <div style={submitMeta}>No receipt transcript self-check is available.</div>
      </div>
    );
  }

  const blockNumber = formatHexQuantity(state.receipt.blockNumber);
  const statusHex = state.receipt.status ?? "-";
  const isReverted = state.phase === "reverted";
  const title =
    state.phase === "included"
      ? "Receipt status: included"
      : state.phase === "reverted"
        ? "Receipt status: reverted"
        : "Receipt status: included, status unavailable";
  const noEvmProof = state.receipt.nativeReceipt?.noEvmProof ?? null;
  const hasFinalityEvidence = noEvmProof?.finalityEvidence != null;
  const archiveVerification =
    state.receipt.nativeReceipt?.noEvmArchiveVerification ?? null;
  const finalityVerification =
    state.receipt.nativeReceipt?.noEvmFinalityVerification ?? null;

  return (
    <div style={isReverted ? receiptErrorBox : receiptBox}>
      <div style={receiptTitle}>{title}</div>
      <div style={submitMeta}>
        Status {statusHex}
        {blockNumber ? ` · block ${blockNumber}` : ""}
        {state.via ? ` · via ${state.via}` : ""}
      </div>
      {state.receipt.contractAddress && (
        <div style={submitMeta}>
          Contract {state.receipt.contractAddress}
        </div>
      )}
      {state.receipt.nativeReceipt ? (
        <>
          <div style={submitMeta}>
            Native receipt {state.receipt.nativeReceipt.schema ?? "unknown schema"}
            {state.receipt.nativeReceipt.txType !== null
              ? ` · txType 0x${state.receipt.nativeReceipt.txType.toString(16)}`
              : ""}
            {state.receipt.nativeReceipt.eventCount !== null
              ? ` · events ${state.receipt.nativeReceipt.eventCount}`
              : ""}
          </div>
          {state.receipt.nativeReceipt.receiptCommitment !== null && (
            <>
              <div style={submitMeta}>
                Receipt commitment evidence; no-EVM transcript status is shown
                separately.
              </div>
              <div style={monoWrap}>
                {state.receipt.nativeReceipt.receiptCommitment}
              </div>
            </>
          )}
          {state.receipt.nativeReceipt.noEvmProof === null ? (
            <div style={submitMeta}>
              Native receipt returned no no-EVM receipt-proof transcript payload.
            </div>
          ) : (
            <MrvNoEvmReceiptProofTranscriptDetails
              proof={state.receipt.nativeReceipt.noEvmProof}
              verification={state.receipt.nativeReceipt.noEvmProofVerification}
              archiveVerification={archiveVerification}
              finalityVerification={finalityVerification}
            />
          )}
        </>
      ) : state.receipt.nativeReceiptError ? (
        <>
          <div style={submitMeta}>
            Native receipt unavailable: {state.receipt.nativeReceiptError.reason}
          </div>
          <div style={submitMeta}>
            {state.receipt.nativeReceiptError.method ?? "lyth_nativeReceipt"}
            {state.receipt.nativeReceiptError.via
              ? ` via ${state.receipt.nativeReceiptError.via}`
              : ""}
            {state.receipt.nativeReceiptError.code !== undefined
              ? ` (code ${state.receipt.nativeReceiptError.code})`
              : ""}
          </div>
        </>
      ) : (
        <div style={submitMeta}>Native receipt evidence unavailable.</div>
      )}
      <div style={submitMeta}>
        {hasFinalityEvidence
          ? finalityVerification?.status === "verified"
            ? "Receipt self-check and wallet-side round-finality verification is shown."
            : finalityVerification?.status === "mismatch"
              ? "Receipt self-check and round-certificate material are shown; wallet-side round-finality verification did not pass."
              : "Receipt self-check and parsed round-certificate material are shown; wallet-side round-finality verification is not configured here."
          : "Transcript self-consistency only; anchor-level round finality is not established here."}
      </div>
    </div>
  );
}

function MrvNoEvmReceiptProofTranscriptDetails({
  proof,
  verification,
  archiveVerification,
  finalityVerification,
}: {
  proof: WalletMrvNoEvmReceiptProofTranscript;
  verification: WalletMrvNoEvmReceiptProofVerification | null;
  archiveVerification: WalletMrvNoEvmArchiveVerification | null;
  finalityVerification: WalletMrvNoEvmFinalityVerification | null;
}) {
  const isVerified = verification?.status === "verified";
  const isCompact = proof.proofKind === "compactInclusion";
  const proofLabel = isCompact
    ? "compact inclusion proof"
    : "receipt-proof transcript";
  const statusText =
    verification === null
      ? "Receipt proof self-check unavailable."
      : isVerified
        ? isCompact
          ? [
              "Compact inclusion self-check verified:",
              "target receipt, leaf, path, and receipts root match.",
            ].join(" ")
          : [
              "Transcript self-check verified:",
              "count, receipts root, and target receipt hash match.",
            ].join(" ")
        : isCompact
          ? "Compact inclusion self-check mismatch: recomputed path values differ."
          : "Transcript self-check mismatch: recomputed transcript values differ.";
  const sourceText = receiptProofHistorySourceText(proof);
  const targetBytesLength =
    proof.targetReceiptBytes === null
      ? null
      : Math.max(0, (proof.targetReceiptBytes.length - 2) / 2);
  const finalityStatusStyle =
    finalityVerification?.status === "verified"
      ? receiptProofVerifiedMeta
      : finalityVerification?.status === "mismatch"
        ? receiptProofMismatchMeta
        : submitMeta;
  const archiveStatusStyle =
    archiveVerification?.status === "verified"
      ? receiptProofVerifiedMeta
      : archiveVerification?.status === "mismatch" ||
          archiveVerification?.status === "malformed" ||
          archiveVerification?.status === "config-invalid"
        ? receiptProofMismatchMeta
        : submitMeta;

  return (
    <div
      aria-label="No-EVM receipt proof"
      style={receiptProofDetails}
    >
      <div style={submitMeta}>
        No-EVM {proofLabel} present;{" "}
        {isCompact ? "target-only receipt evidence" : "bounded receipt evidence"}{" "}
        only.
      </div>
      <div style={isVerified ? receiptProofVerifiedMeta : receiptProofMismatchMeta}>
        {statusText}
      </div>
      <div style={submitMeta}>
        Source: {sourceText}.{" "}
        {proof.finalityEvidence === null
          ? "Anchor-level round finality is not established here."
          : "Round-certificate material is present."}
      </div>
      {proof.archiveProof !== null && (
        <>
          <div style={submitMeta}>
            Archive binding: {receiptArchiveProofSourceText(proof.archiveProof.source)}.
            Archive signatures{" "}
            {proof.archiveProof.signatures.length > 0
              ? `present (${proof.archiveProof.signatures.length})`
              : "absent"}
            ; finality evidence is reported separately.
          </div>
          <div style={archiveStatusStyle}>
            Archive signature check:{" "}
            {archiveVerificationStatusText(archiveVerification)}
            {archiveVerification?.details !== null &&
            archiveVerification?.details !== undefined
              ? ` · checked ${archiveVerification.details.checkedSignatures} · trusted ${archiveVerification.details.validSigners.length}/${archiveVerification.details.threshold}`
              : ""}
            .
          </div>
          {archiveVerification?.reason && (
            <div style={submitMeta}>
              Wallet archive check: {archiveVerification.reason}.
            </div>
          )}
          {archiveVerification?.details !== null &&
            archiveVerification?.details !== undefined &&
            archiveVerification.details.issues.length > 0 && (
              <ReceiptProofHashRow
                label="Archive signature issue"
                value={formatArchiveVerificationIssues(
                  archiveVerification.details.issues,
                )}
              />
            )}
          {archiveVerification?.details !== null &&
            archiveVerification?.details !== undefined &&
            archiveVerification.details.validSigners.length > 0 && (
              <ReceiptProofHashRow
                label="Trusted archive signers"
                value={archiveVerification.details.validSigners.join(", ")}
              />
            )}
          {proof.archiveProof.signatureDigest !== undefined && (
            <>
              <div style={submitMeta}>
                Snapshot archive signature digest material is present; this is
                not anchor-level round finality, and archive signature verification is
                reported separately.
              </div>
              <ReceiptProofHashRow
                label="Archive signature digest"
                value={proof.archiveProof.signatureDigest}
              />
            </>
          )}
          {proof.archiveProof.coveringSnapshot !== undefined && (
            <>
              <div style={submitMeta}>
                Covering snapshot parsed; archive snapshot signatures{" "}
                {proof.archiveProof.coveringSnapshot.signatures.length > 0
                  ? `present (${proof.archiveProof.coveringSnapshot.signatures.length})`
                  : "absent"}
                . Archive signature verification is reported separately.
              </div>
              <div style={submitMeta}>
                Snapshot height {proof.archiveProof.coveringSnapshot.snapshotHeight} ·
                checkpoint {proof.archiveProof.coveringSnapshot.checkpointFrom}-
                {proof.archiveProof.coveringSnapshot.checkpointTo}.
              </div>
              <ReceiptProofHashRow
                label="Snapshot manifest"
                value={proof.archiveProof.coveringSnapshot.manifestHash}
              />
              <ReceiptProofHashRow
                label="Snapshot signature digest"
                value={proof.archiveProof.coveringSnapshot.signatureDigest}
              />
              <ReceiptProofHashRow
                label="Snapshot content"
                value={proof.archiveProof.coveringSnapshot.contentHash}
              />
              <ReceiptProofHashRow
                label="Checkpoint content"
                value={proof.archiveProof.coveringSnapshot.checkpointContentHash}
              />
            </>
          )}
        </>
      )}
      {proof.finalityEvidence === null ? (
        <div style={submitMeta}>
          Finality evidence: absent; missing proof material remains authoritative.
        </div>
      ) : (
        <>
          <div style={finalityStatusStyle}>
            {finalityVerification?.status === "verified"
              ? "Finality evidence: wallet-verified round certificate"
              : finalityVerification?.status === "mismatch"
                ? "Finality evidence: round certificate verification mismatch"
                : "Finality evidence: round certificate parsed, not wallet-verified"}{" "}
            · round {proof.finalityEvidence.round} · signer count{" "}
            {proof.finalityEvidence.certificate.signerCount}.
          </div>
          {finalityVerification?.reason && (
            <div style={submitMeta}>Wallet round-finality check: {finalityVerification.reason}.</div>
          )}
          {finalityVerification?.details !== null &&
            finalityVerification?.details !== undefined && (
              <ReceiptProofHashRow
                label="Round threshold check"
                value={`${finalityVerification.details.acceptedSignatureCount}/${finalityVerification.details.requiredSignatureCount} signatures · ${finalityVerification.details.signatureValid ? "signature valid" : "signature invalid"}`}
              />
            )}
          <ReceiptProofHashRow
            label="Certificate signature"
            value={proof.finalityEvidence.certificate.signature}
          />
          <ReceiptProofHashRow
            label="Certificate signers"
            value={formatSignerIndices(
              proof.finalityEvidence.certificate.signerIndices,
            )}
          />
          <ReceiptProofHashRow
            label="Certificate bitmap"
            value={proof.finalityEvidence.certificate.signersBitmap}
          />
        </>
      )}
      <div style={submitMeta}>
        {proof.proofKind} · {proof.proofType} · {proof.rootAlgorithm} ·{" "}
        {proof.receiptCodec}
      </div>
      <div style={submitMeta}>
        block {proof.blockHeight} · txIndex {proof.txIndex} · receipts{" "}
        {proof.receiptCount} · transcript blobs {proof.receiptTranscript.length}
        {targetBytesLength !== null ? ` · target bytes ${targetBytesLength}` : ""}
      </div>
      {proof.missingProofMaterial.length > 0 && (
        <div style={submitMeta}>
          Missing proof material: {proof.missingProofMaterial.join("; ")}
        </div>
      )}
      <ReceiptProofHashRow label="Block hash" value={proof.blockHash} />
      <ReceiptProofHashRow label="Tx hash" value={proof.txHash} />
      <ReceiptProofHashRow label="Receipts root" value={proof.receiptsRoot} />
      <ReceiptProofHashRow
        label="Target receipt"
        value={proof.targetReceiptHash}
      />
      {proof.compactInclusionProof !== null && (
        <>
          <ReceiptProofHashRow
            label="Compact root"
            value={proof.compactInclusionProof.root}
          />
          <ReceiptProofHashRow
            label="Compact leaf"
            value={proof.compactInclusionProof.leafHash}
          />
        </>
      )}
      {verification !== null && (
        <>
          <ReceiptProofHashRow
            label={isCompact ? "Index check" : "Count check"}
            value={
              verification.receiptCountMatches
                ? isCompact
                  ? "in bounds"
                  : "matches"
                : `declared ${verification.receiptCount} / decoded ${verification.transcriptCount}`
            }
          />
          <ReceiptProofHashRow
            label="Root check"
            value={verification.receiptsRootMatches ? "matches" : "mismatch"}
          />
          {!verification.receiptsRootMatches && (
            <ReceiptProofHashRow
              label="Computed root"
              value={verification.computedReceiptsRoot}
            />
          )}
          <ReceiptProofHashRow
            label="Target check"
            value={
              verification.targetReceiptHashMatches ? "matches" : "mismatch"
            }
          />
          {!verification.targetReceiptHashMatches && (
            <ReceiptProofHashRow
              label="Computed target"
              value={verification.computedTargetReceiptHash}
            />
          )}
          {isCompact && verification.compactLeafHashMatches !== undefined && (
            <ReceiptProofHashRow
              label="Leaf check"
              value={verification.compactLeafHashMatches ? "matches" : "mismatch"}
            />
          )}
          {isCompact && verification.compactPathMatches !== undefined && (
            <ReceiptProofHashRow
              label="Path check"
              value={verification.compactPathMatches ? "matches" : "mismatch"}
            />
          )}
          {isCompact &&
            verification.compactLeafHashMatches === false &&
            verification.computedCompactLeafHash !== undefined && (
              <ReceiptProofHashRow
                label="Computed leaf"
                value={verification.computedCompactLeafHash}
              />
            )}
        </>
      )}
    </div>
  );
}

function receiptProofHistorySourceText(
  proof: WalletMrvNoEvmReceiptProofTranscript,
): string {
  switch (proof.historySource) {
    case "indexerReceiptArchive":
      return "indexer receipt archive";
    case "liveBlockCache":
      return "live block cache";
    case "legacyUnspecified":
      return "legacy or unspecified source";
  }
}

function receiptArchiveProofSourceText(
  source: NonNullable<WalletMrvNoEvmReceiptProofTranscript["archiveProof"]>["source"],
): string {
  switch (source) {
    case "indexerReceiptArchiveContentDigest":
      return "indexer receipt archive content digest";
  }
}

function archiveVerificationStatusText(
  verification: WalletMrvNoEvmArchiveVerification | null,
): string {
  switch (verification?.status) {
    case "verified":
      return "wallet-verified trusted snapshot signatures";
    case "mismatch":
      return "trusted snapshot signature verification mismatch";
    case "malformed":
      return "archive signature material malformed";
    case "config-invalid":
      return "trusted archive signer config invalid";
    case "unconfigured":
    case undefined:
      return "parsed, not wallet-verified";
  }
}

function formatArchiveVerificationIssues(
  issues: NonNullable<WalletMrvNoEvmArchiveVerification["details"]>["issues"],
): string {
  return issues
    .slice(0, 3)
    .map((issue) =>
      issue.signerId === undefined
        ? issue.message
        : `${issue.message} (${issue.signerId})`,
    )
    .join("; ");
}

function formatSignerIndices(indices: number[]): string {
  return indices.length === 0 ? "none" : indices.join(", ");
}

function ReceiptProofHashRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={receiptProofRow}>
      <span style={receiptProofLabel}>{label}</span>
      <span style={receiptProofValue}>{value}</span>
    </div>
  );
}

function receiptPhase(
  status: string | null,
): "included" | "reverted" | "unknown" {
  if (typeof status !== "string" || !/^0x[0-9a-fA-F]+$/.test(status)) {
    return "unknown";
  }
  const parsed = BigInt(status);
  if (parsed === 1n) return "included";
  if (parsed === 0n) return "reverted";
  return "unknown";
}

function formatHexQuantity(value: string | null): string | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    return null;
  }
  return BigInt(value).toString(10);
}

function parseSafeHexBlockNumber(value: string): number | null {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) return null;
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(parsed);
}

function readReplaySourceLabel(
  source: import("../../shared/native-market-orderbook.js").NativeMarketOrderBookRow | null,
): string | null {
  if (source === null) return null;
  const projection = source.projection;
  const provider = source.indexerProvider;
  if (typeof projection === "string" && typeof provider === "string") {
    return `${provider}/${projection}`;
  }
  if (typeof projection === "string") return projection;
  if (typeof provider === "string") return provider;
  return null;
}

function shortReplayId(value: string): string {
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}...${value.slice(-6)}`;
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

const warningBox: CSSProperties = {
  marginTop: 10,
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid rgba(242,180,65,0.35)",
  background: "rgba(242,180,65,0.08)",
  color: "var(--gold)",
  fontSize: 11,
  lineHeight: 1.45,
};

const successBox: CSSProperties = {
  marginTop: 10,
  padding: "9px 10px",
  borderRadius: 8,
  border: "1px solid rgba(75,190,120,0.38)",
  background: "rgba(75,190,120,0.08)",
  color: "var(--fg-100)",
  fontSize: 11,
  lineHeight: 1.45,
};

const receiptBox: CSSProperties = {
  marginTop: 8,
  padding: "8px 9px",
  borderRadius: 8,
  border: "1px solid rgba(75,190,120,0.26)",
  background: "rgba(0,0,0,0.16)",
};

const receiptErrorBox: CSSProperties = {
  ...receiptBox,
  border: "1px solid rgba(220,80,80,0.4)",
  background: "rgba(220,80,80,0.08)",
};

const receiptTitle: CSSProperties = {
  fontWeight: 700,
  color: "var(--fg-100)",
};

const submitMeta: CSSProperties = {
  marginTop: 4,
  color: "var(--fg-300)",
  fontSize: 10.5,
  lineHeight: 1.45,
};

const receiptProofVerifiedMeta: CSSProperties = {
  ...submitMeta,
  color: "#7bd99c",
};

const receiptProofMismatchMeta: CSSProperties = {
  ...submitMeta,
  color: "#ff9f9f",
};

const monoWrap: CSSProperties = {
  marginTop: 6,
  fontFamily: "var(--f-mono)",
  fontSize: 10.5,
  color: "var(--fg-100)",
  wordBreak: "break-all",
};

const receiptProofDetails: CSSProperties = {
  marginTop: 6,
  paddingTop: 6,
  borderTop: "1px solid rgba(255,255,255,0.08)",
};

const receiptProofRow: CSSProperties = {
  marginTop: 4,
  display: "grid",
  gridTemplateColumns: "86px minmax(0, 1fr)",
  gap: 6,
  alignItems: "start",
};

const receiptProofLabel: CSSProperties = {
  color: "var(--fg-500)",
  fontFamily: "var(--f-mono)",
  fontSize: 9.5,
  textTransform: "uppercase",
};

const receiptProofValue: CSSProperties = {
  minWidth: 0,
  color: "var(--fg-100)",
  fontFamily: "var(--f-mono)",
  fontSize: 10.5,
  wordBreak: "break-all",
};

const replayStatusRow: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 8,
  flexWrap: "wrap",
};

const replayStatusLive: CSSProperties = {
  color: "#7bd99c",
  fontSize: 11,
  fontWeight: 700,
};

const replayStatusWarn: CSSProperties = {
  color: "var(--gold)",
  fontSize: 11,
  fontWeight: 700,
};

const replayDeltaList: CSSProperties = {
  marginTop: 8,
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const replayDeltaRow: CSSProperties = {
  padding: "8px 9px",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.08)",
  background: "rgba(0,0,0,0.18)",
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
