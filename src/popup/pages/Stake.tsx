// Phase 7 — Stake page. Top-level orchestrator for the cluster
// directory → form → preview → submitting → success | error flow.
//
// Replaces the legacy placeholder Stake exported from components.tsx
// (which was a static four-button strategy mock with no chain wiring).
// AutovoteSelector + the four-button §23.9 path lands in Commit 3 as
// an alternative entry into the same submit step.
//
// Chain wiring: the form's Continue → preview → Confirm flow encodes a
// `delegate(uint32,uint16)` calldata via shared/staking-tx.ts (SDK
// encoders) and submits through the existing `bgWalletSendTx` IPC, with
// the staked LYTH amount sent as msg.value (the delegation principal).
// The delegation precompile (`0x100A`) is live + enabled on Sprintnet
// (`lyth_listActivePrecompiles`); the wallet surfaces any typed error
// the chain returns verbatim.

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Icon } from "../Icon";
import { monoscanTxUrl } from "../../shared/build-info";
import { AutovoteSelector } from "../components/AutovoteSelector";
import { ClusterPicker } from "../components/ClusterPicker";
import { RedelegateForm } from "../components/RedelegateForm";
import { RedemptionQueueCard } from "../components/RedemptionQueueCard";
import { RewardCard } from "../components/RewardCard";
import { StakeForm } from "../components/StakeForm";
import { UnstakeForm } from "../components/UnstakeForm";
import { useFeature } from "../hooks/useFeature";
import {
  bgStakingAutovoteSeed,
  bgStakingClusterDirectory,
  bgStakingDelegationCap,
  bgStakingDelegations,
  bgStakingPendingRewards,
  bgStakingRedemptionQueue,
  bgWalletBalance,
  bgWalletSendTx,
  type ClusterDirectoryEntry,
  type DelegationsView,
  type PendingRewardsView,
  type RedemptionQueueView,
} from "../bg";
import type { Account } from "../demo-data";
import {
  DELEGATION_PRECOMPILE,
  encodeClaimRewards,
  encodeDelegate,
  encodeRedelegate,
  encodeUndelegate,
  lythAmountToBps,
} from "../../shared/staking-tx";
import {
  LYTHOSHI_PER_LYTH,
  lythoshiToLythDecimal,
  parseHexQuantity,
} from "../../shared/native-amount";
import {
  pickMaxDecentralization,
  pickMaxDiversity,
  pickMaxYield,
  type AutovoteAllocation,
  type AutovoteMode,
  type AutovoteResult,
} from "../../shared/autovote";

type Step =
  | "pick"
  | "form"
  | "unstake-form"
  | "redelegate-form"
  | "redelegate-dst-pick"
  | "preview"
  | "submitting"
  | "success"
  | "error";

/** Action the user is preparing. Drives the preview/submit calldata
 *  encoding + the success copy. */
type Action = "delegate" | "undelegate" | "redelegate" | "claim";

/** Top-level interaction mode. `"manual"` = single-cluster pick →
 *  stake form path (commit 2). The four autovote modes route through
 *  AutovotePreview before submitting; for commit 3 only the first
 *  allocation submits (full batch lands as a follow-up). */
type EntryMode = "manual" | AutovoteMode;

// R18 — sessionStorage persistence so a round-trip through ClusterDetail
// restores the user's prior selection + step (App.tsx routes Stake and
// ClusterDetail as sibling screens, so Stake unmounts on navigation).
// Cleared by App.tsx when the user explicitly leaves Stake via onBack.
const STAKE_STATE_KEY = "monowallet_stake_state";

interface PersistedStakeState {
  step: Step;
  selectedClusterId: number | null;
  redelegateDstClusterId: number | null;
  amountStr: string;
  action: Action;
  entryMode: EntryMode;
  autovoteTargetBps: number;
}

/** Steps that are safe to restore from sessionStorage. Terminal /
 *  in-flight steps (submitting, success, error) reset to "pick" so the
 *  user doesn't land on a stale terminal screen after navigation. */
const RESTORABLE_STEPS: ReadonlySet<Step> = new Set<Step>([
  "pick",
  "form",
  "unstake-form",
  "redelegate-form",
  "redelegate-dst-pick",
  "preview",
]);

function loadStakeState(): PersistedStakeState | null {
  try {
    const raw = sessionStorage.getItem(STAKE_STATE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedStakeState>;
    if (
      typeof parsed.step !== "string" ||
      typeof parsed.amountStr !== "string"
    ) {
      return null;
    }
    const step = RESTORABLE_STEPS.has(parsed.step as Step)
      ? (parsed.step as Step)
      : "pick";
    return {
      step,
      selectedClusterId:
        typeof parsed.selectedClusterId === "number"
          ? parsed.selectedClusterId
          : null,
      redelegateDstClusterId:
        typeof parsed.redelegateDstClusterId === "number"
          ? parsed.redelegateDstClusterId
          : null,
      amountStr: parsed.amountStr,
      action: (parsed.action as Action) ?? "delegate",
      entryMode: (parsed.entryMode as EntryMode) ?? "manual",
      autovoteTargetBps:
        typeof parsed.autovoteTargetBps === "number"
          ? parsed.autovoteTargetBps
          : 5000,
    };
  } catch {
    return null;
  }
}

function saveStakeState(state: PersistedStakeState): void {
  try {
    sessionStorage.setItem(STAKE_STATE_KEY, JSON.stringify(state));
  } catch {
    // sessionStorage may be unavailable in some environments (private
    // mode quota, etc.); silent fail is fine — state-loss across nav is
    // a UX regression, not a correctness issue.
  }
}

export function clearStakeState(): void {
  try {
    sessionStorage.removeItem(STAKE_STATE_KEY);
  } catch {
    // see saveStakeState — silent fail is fine.
  }
}

/** Parse an `0x...` hex string into 32 bytes for the autovote seed. */
function hexToBytes(hex: string): Uint8Array | null {
  const stripped = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (stripped.length === 0 || stripped.length % 2 !== 0) return null;
  const out = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < out.length; i++) {
    const b = Number.parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(b)) return null;
    out[i] = b;
  }
  return out;
}

interface StakeProps {
  account: Account;
  /** Active chain id (hex). Submitter routes through `bgWalletSendTx`
   *  with this id so the SW knows to take the ML-DSA-65 envelope path
   *  on Sprintnet. */
  chainId: string;
  /** Optional entry point — when the page is opened from the
   *  Delegations dashboard, the parent supplies a pre-selected
   *  cluster + the unstake / redelegate-from-this-cluster action.
   *  Resets to manual delegate on mount when omitted. */
  initialAction?: "delegate" | "undelegate" | "redelegate";
  initialClusterId?: number;
  /** Phase 11 Commit 6 — when supplied, the ClusterPicker rows expose
   *  a "View details →" affordance that calls this with the directory
   *  entry. App navigates to the dedicated cluster-detail screen. */
  onShowClusterDetail?: (
    cluster: import("../../shared/staking").ClusterDirectoryEntry,
  ) => void;
  onBack: () => void;
}

export function Stake({
  account,
  chainId,
  initialAction,
  initialClusterId,
  onShowClusterDetail,
  onBack,
}: StakeProps) {
  // R18 — restore prior Stake state when the user returns from a sibling
  // screen (ClusterDetail). Deep-link props always win over the restored
  // value so Delegations → "Unstake" still pre-positions correctly.
  const savedState = loadStakeState();

  // Initial step depends on whether the parent has deep-linked us into
  // a specific action. Delegations → "Unstake" on cluster N opens us
  // at `unstake-form` with the cluster pre-selected.
  const initialStep: Step =
    initialAction === "undelegate"
      ? "unstake-form"
      : initialAction === "redelegate"
        ? "redelegate-form"
        : (savedState?.step ?? "pick");
  const [step, setStep] = useState<Step>(initialStep);

  // Cluster directory state.
  const [clusters, setClusters] = useState<ClusterDirectoryEntry[]>([]);
  const [clustersError, setClustersError] = useState<string | null>(null);

  // Delegation context state.
  const [delegations, setDelegations] = useState<DelegationsView | null>(null);
  const [capBps, setCapBps] = useState<number | null>(null);
  const [balanceLythoshi, setBalanceLythoshi] = useState<bigint | null>(null);
  const [rewards, setRewards] = useState<PendingRewardsView | null>(null);
  const [rewardsMock, setRewardsMock] = useState(true);
  const [redemptionQueue, setRedemptionQueue] =
    useState<RedemptionQueueView | null>(null);
  const [redemptionQueueMock, setRedemptionQueueMock] = useState(false);
  const [redemptionQueueError, setRedemptionQueueError] =
    useState<string | null>(null);

  // Phase 9 — §28.5 Q29 TRADING_INTERFACE flag gates the advanced
  // reward analytics surface (per-cluster breakdown inside RewardCard).
  // Default OFF → users see only the total + claim button.
  const tradingInterfaceOn = useFeature("TRADING_INTERFACE");

  // Selection + form state.
  const [entryMode, setEntryMode] = useState<EntryMode>(
    savedState?.entryMode ?? "manual",
  );
  const [selectedClusterId, setSelectedClusterId] = useState<number | null>(
    initialClusterId ?? savedState?.selectedClusterId ?? null,
  );
  const [redelegateDstClusterId, setRedelegateDstClusterId] = useState<number | null>(
    savedState?.redelegateDstClusterId ?? null,
  );
  const [amountStr, setAmountStr] = useState(savedState?.amountStr ?? "");
  const [action, setAction] = useState<Action>(
    initialAction ?? savedState?.action ?? "delegate",
  );
  const [autovoteTargetBps, setAutovoteTargetBps] = useState<number>(
    savedState?.autovoteTargetBps ?? 5000,
  );
  const [autovoteSeed, setAutovoteSeed] = useState<Uint8Array | null>(null);
  const [autovotePlan, setAutovotePlan] = useState<AutovoteResult | null>(null);

  // Submission state.
  const [txHash, setTxHash] = useState<string | null>(null);
  const [hashCopied, setHashCopied] = useState(false);
  const [submitError, setSubmitError] = useState<{
    message: string;
    code: number | null;
    method: string | null;
    via: string | null;
  } | null>(null);

  // R18 — persist key form / selection state on every change so a
  // round-trip through ClusterDetail returns the user to the same
  // place. App.tsx clears the key on explicit Stake exit.
  useEffect(() => {
    saveStakeState({
      step,
      selectedClusterId,
      redelegateDstClusterId,
      amountStr,
      action,
      entryMode,
      autovoteTargetBps,
    });
  }, [
    step,
    selectedClusterId,
    redelegateDstClusterId,
    amountStr,
    action,
    entryMode,
    autovoteTargetBps,
  ]);

  // Load the cluster directory on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await bgStakingClusterDirectory();
        if (cancelled || !r.ok) {
          if (!cancelled && !r.ok) setClustersError(r.reason);
          return;
        }
        setClusters(r.data.clusters.slice());
      } catch (e) {
        if (cancelled) return;
        setClustersError((e as Error).message ?? "directory fetch failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load active delegations + cap + autovote seed when the account
  // changes. The seed comes from the SW (which has the unlocked
  // ML-DSA-65 pubkey) so the popup never sees secret material.
  useEffect(() => {
    if (!account.addr.startsWith("0x")) return;
    let cancelled = false;
    setRedemptionQueue(null);
    setRedemptionQueueMock(false);
    setRedemptionQueueError(null);
    void (async () => {
      const [delR, capR, balR, seedR, queueR] = await Promise.all([
        bgStakingDelegations(account.addr),
        bgStakingDelegationCap(),
        bgWalletBalance(account.addr, chainId),
        bgStakingAutovoteSeed(),
        bgStakingRedemptionQueue(account.addr),
      ]);
      if (cancelled) return;
      if (delR.ok) setDelegations(delR.data);
      if (capR.ok) setCapBps(capR.data.capBps);
      if (balR.ok) {
        const parsedBalance = parseHexQuantity(balR.balanceHex);
        if (parsedBalance !== null) setBalanceLythoshi(parsedBalance);
      }
      if (seedR.ok) {
        const seedBytes = hexToBytes(seedR.seedHex);
        if (seedBytes !== null) setAutovoteSeed(seedBytes);
      }
      if (queueR.ok) {
        setRedemptionQueue(queueR.data);
        setRedemptionQueueMock(queueR.via === "mock");
      } else {
        setRedemptionQueueError(queueR.reason);
      }
      // Pending rewards: depends on the active delegation set, so we
      // fan it out after the delegations resolve. Chain GAP today —
      // the SW returns mock-derived figures with `via: "mock"`.
      if (delR.ok) {
        const rewR = await bgStakingPendingRewards(account.addr, delR.data.rows);
        if (!cancelled && rewR.ok) {
          setRewards(rewR.data);
          setRewardsMock(rewR.via === "mock");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account.addr, chainId]);

  // Recompute the autovote plan whenever inputs change. The plan
  // doesn't submit on its own — the user reviews it on the preview
  // screen before the chain call.
  useEffect(() => {
    if (entryMode === "manual" || entryMode === "custom") {
      setAutovotePlan(null);
      return;
    }
    if (clusters.length === 0 || autovoteSeed === null) {
      setAutovotePlan(null);
      return;
    }
    const input = {
      clusters,
      targetTotalBps: autovoteTargetBps,
      capBps,
      seed: autovoteSeed,
      // §23.6 launch minimum diversification = 2 (Phase 12). The wallet
      // can tighten this as the chain reports phase transitions via
      // capBps — for now the static floor matches launch.
      minDiversification: 2,
    };
    const plan =
      entryMode === "max-yield"
        ? pickMaxYield(input)
        : entryMode === "max-diversity"
          ? pickMaxDiversity(input)
          : pickMaxDecentralization(input);
    setAutovotePlan(plan);
  }, [entryMode, autovoteTargetBps, clusters, capBps, autovoteSeed]);

  // Existing weight in the selected cluster.
  const existingWeightBps = useMemo(() => {
    if (selectedClusterId === null || delegations === null) return 0;
    return delegations.rows.find((r) => r.cluster === selectedClusterId)?.weightBps ?? 0;
  }, [selectedClusterId, delegations]);

  const selectedCluster = useMemo(
    () =>
      selectedClusterId === null
        ? null
        : (clusters.find((c) => c.clusterId === selectedClusterId) ?? null),
    [selectedClusterId, clusters],
  );

  // Submission. Encodes delegate / undelegate / redelegate / claim
  // calldata based on the current `action` and routes through
  // bgWalletSendTx; the SW wraps it into the ML-DSA-65 envelope path
  // for Sprintnet.
  const handleConfirm = async () => {
    if (action !== "claim") {
      if (selectedCluster === null || balanceLythoshi === null) return;
      if (action === "redelegate" && redelegateDstClusterId === null) return;
    }
    setStep("submitting");
    setSubmitError(null);
    setTxHash(null);
    try {
      let data: string;
      let executionUnitLimitHex: string;
      // Native LYTH principal sent as `msg.value`. Only `delegate` commits
      // principal (mono-core ops.rs `principal_delta = ctx.value`); the
      // others are weight-only / selector-only. valueWeiHex carries native
      // lythoshi (8-decimal), matching the Send path's value convention.
      let valueWeiHex = "0x0";
      if (action === "claim") {
        data = encodeClaimRewards();
        executionUnitLimitHex = "0x14820"; // 84000 — selector-only allowance
      } else if (action === "undelegate") {
        // Chain `undelegate(uint32 cluster)` removes the wallet's entire
        // row for the cluster (full-row removal; no partial unstake) and
        // queues the principal for redemption — no amount/weight arg.
        data = encodeUndelegate(selectedCluster!.clusterId);
        executionUnitLimitHex = "0x186A0";
      } else {
        const amountLythoshi = parseLythAmountToLythoshi(amountStr);
        if (amountLythoshi === null || balanceLythoshi === null) {
          setSubmitError({
            message: "invalid amount",
            code: null,
            method: null,
            via: null,
          });
          setStep("error");
          return;
        }
        const bps = lythAmountToBps(amountLythoshi, balanceLythoshi);
        if (action === "delegate") {
          data = encodeDelegate(selectedCluster!.clusterId, bps);
          // delegate is principal-backed: the entered LYTH amount is the
          // staked principal and must travel as msg.value (NOT 0x0, which
          // would lock a voting weight with zero recoverable capital).
          // weightBps in the calldata is the separate voting-power share.
          valueWeiHex = "0x" + amountLythoshi.toString(16);
        } else {
          data = encodeRedelegate(
            selectedCluster!.clusterId,
            redelegateDstClusterId!,
            bps,
          );
        }
        // The delegation precompile's execution-unit budget isn't measured yet
        // (chain GAP — needs Nayiem). Use a generous overhead-aware
        // estimate; redelegate carries one extra arg so we bump the
        // budget slightly for that path.
        executionUnitLimitHex = action === "redelegate" ? "0x1D4C0" : "0x186A0";
      }
      const r = await bgWalletSendTx({
        to: DELEGATION_PRECOMPILE,
        valueWeiHex,
        chainIdHex: chainId,
        data,
        executionUnitLimitHex,
      });
      if (r.ok) {
        setTxHash(r.result.txHash);
        setStep("success");
      } else {
        setSubmitError({
          message: r.reason ?? `${action} rejected`,
          code: typeof r.code === "number" ? r.code : null,
          method: typeof r.method === "string" ? r.method : null,
          via: typeof r.via === "string" ? r.via : null,
        });
        setStep("error");
      }
    } catch (e) {
      setSubmitError({
        message: (e as Error).message ?? `${action} failed`,
        code: null,
        method: null,
        via: null,
      });
      setStep("error");
    }
  };

  /** Initiate a claim — skips the preview step because a claim has
   *  no parameters to confirm (it claims across every active
   *  delegation). Submit fires directly. Inlined rather than routing
   *  through handleConfirm because handleConfirm reads `action` from
   *  state, which would still be the previous value at this call
   *  point (React state updates are async). */
  const handleClaim = async () => {
    setAction("claim");
    setStep("submitting");
    setSubmitError(null);
    setTxHash(null);
    try {
      const r = await bgWalletSendTx({
        to: DELEGATION_PRECOMPILE,
        valueWeiHex: "0x0",
        chainIdHex: chainId,
        data: encodeClaimRewards(),
        executionUnitLimitHex: "0x14820", // 84000 — selector-only allowance
      });
      if (r.ok) {
        setTxHash(r.result.txHash);
        setStep("success");
      } else {
        setSubmitError({
          message: r.reason ?? "claim rejected",
          code: typeof r.code === "number" ? r.code : null,
          method: typeof r.method === "string" ? r.method : null,
          via: typeof r.via === "string" ? r.via : null,
        });
        setStep("error");
      }
    } catch (e) {
      setSubmitError({
        message: (e as Error).message ?? "claim failed",
        code: null,
        method: null,
        via: null,
      });
      setStep("error");
    }
  };

  const handleCopyHash = async () => {
    if (txHash === null) return;
    try {
      await navigator.clipboard.writeText(txHash);
      setHashCopied(true);
      setTimeout(() => setHashCopied(false), 2000);
    } catch {
      // clipboard write can fail in iframes; silent
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div
          style={{ flex: 1, fontSize: 13, fontWeight: 600, textAlign: "center" }}
        >
          {step === "pick"
            ? "Stake"
            : step === "form"
              ? "Stake — amount"
              : step === "unstake-form"
                ? "Unstake — amount"
                : step === "redelegate-form"
                  ? "Redelegate"
                  : step === "redelegate-dst-pick"
                    ? "Redelegate — destination"
                    : step === "preview"
                      ? action === "delegate"
                        ? "Review delegation"
                        : action === "undelegate"
                          ? "Review unstake"
                          : "Review swap"
                      : step === "submitting"
                        ? action === "claim"
                          ? "Claiming…"
                          : "Submitting…"
                        : step === "success"
                          ? action === "claim"
                            ? "Claimed"
                            : action === "undelegate"
                              ? "Unstaked"
                              : action === "redelegate"
                                ? "Swapped"
                                : "Delegated"
                          : "Error"}
        </div>
        <div style={{ width: 28 }} />
      </div>

      <div className="ext-body">
        {step === "pick" && (
          <>
            <SummaryBanner
              delegations={delegations}
              balanceLythoshi={balanceLythoshi}
            />

            {/* Pending rewards — surfaces only when there's something
                to claim or an active delegation that could accrue. */}
            {delegations !== null && delegations.rows.length > 0 && (
              <RewardCard
                rewards={rewards}
                isMock={rewardsMock}
                clusters={clusters}
                onClaim={() => void handleClaim()}
                claimDisabled={false}
                showAdvancedAnalytics={tradingInterfaceOn}
              />
            )}

            {account.addr.startsWith("0x") && (
              <RedemptionQueueCard
                queue={redemptionQueue}
                isMock={redemptionQueueMock}
                error={redemptionQueueError}
                clusters={clusters}
              />
            )}

            {/* Existing delegations — manage Unstake / Redelegate per row */}
            {delegations !== null && delegations.rows.length > 0 && (
              <ExistingDelegations
                delegations={delegations}
                clusters={clusters}
                balanceLythoshi={balanceLythoshi}
                onUnstake={(clusterId) => {
                  setAction("undelegate");
                  setSelectedClusterId(clusterId);
                  setRedelegateDstClusterId(null);
                  setAmountStr("");
                  setStep("unstake-form");
                }}
                onRedelegate={(clusterId) => {
                  setAction("redelegate");
                  setSelectedClusterId(clusterId);
                  setRedelegateDstClusterId(null);
                  setAmountStr("");
                  setStep("redelegate-form");
                }}
              />
            )}

            {/* §23.9 four-button autovote + manual entry */}
            <div className="ext-card" style={{ padding: 12 }}>
              <EntryModeToggle
                entryMode={entryMode}
                onChange={(mode) => {
                  setEntryMode(mode);
                  setAction("delegate");
                  setSelectedClusterId(null);
                }}
              />
            </div>

            {entryMode !== "manual" && (
              <AutovotePlanCard
                entryMode={entryMode}
                plan={autovotePlan}
                clusters={clusters}
                targetBps={autovoteTargetBps}
                onTargetChange={setAutovoteTargetBps}
                capBps={capBps}
                seedAvailable={autovoteSeed !== null}
                onProceed={() => {
                  if (autovotePlan === null) return;
                  if (autovotePlan.allocations.length === 0) return;
                  // Commit 3 ships a single-tx submit of the FIRST
                  // allocation. Multi-allocation batching lands in a
                  // follow-up so the same `bgWalletSendTx` envelope
                  // path keeps the audit shape simple for Phase 7.
                  const first = autovotePlan.allocations[0]!;
                  setSelectedClusterId(first.cluster);
                  setAmountStr(
                    allocationToLythAmountStr(first, balanceLythoshi),
                  );
                  setStep("preview");
                }}
              />
            )}

            {entryMode === "manual" && (
              <>
                {clustersError !== null ? (
                  <div style={errBanner}>{clustersError}</div>
                ) : clusters.length === 0 ? (
                  <div
                    style={{
                      padding: 18,
                      textAlign: "center",
                      fontSize: 12,
                      color: "var(--fg-400)",
                      fontFamily: "var(--f-mono)",
                    }}
                  >
                    Loading cluster directory…
                  </div>
                ) : (
                  <ClusterPicker
                    clusters={clusters}
                    selectedClusterId={selectedClusterId}
                    {...(onShowClusterDetail
                      ? { onShowDetails: onShowClusterDetail }
                      : {})}
                    onSelect={(id) => {
                      setAction("delegate");
                      setSelectedClusterId(id);
                      setStep("form");
                    }}
                  />
                )}
              </>
            )}
          </>
        )}

        {step === "unstake-form" && selectedCluster !== null && (
          <UnstakeForm
            cluster={selectedCluster}
            currentWeightBps={existingWeightBps}
            balanceWei={balanceLythoshi}
            onContinue={() => setStep("preview")}
            onBack={() => setStep("pick")}
          />
        )}

        {step === "redelegate-form" && selectedCluster !== null && (
          <RedelegateForm
            srcCluster={selectedCluster}
            srcWeightBps={existingWeightBps}
            dstCluster={
              redelegateDstClusterId === null
                ? null
                : (clusters.find((c) => c.clusterId === redelegateDstClusterId) ?? null)
            }
            dstExistingWeightBps={
              delegations?.rows.find((r) => r.cluster === redelegateDstClusterId)
                ?.weightBps ?? 0
            }
            capBps={capBps}
            amountStr={amountStr}
            onAmountChange={setAmountStr}
            onPickDestination={() => setStep("redelegate-dst-pick")}
            balanceWei={balanceLythoshi}
            onContinue={() => setStep("preview")}
            onBack={() => setStep("pick")}
          />
        )}

        {step === "redelegate-dst-pick" && (
          <>
            <div
              style={{
                marginBottom: 8,
                fontFamily: "var(--f-mono)",
                fontSize: 10,
                color: "var(--fg-400)",
                lineHeight: 1.5,
              }}
            >
              Pick the destination cluster. Source and destination must
              differ.
            </div>
            <ClusterPicker
              clusters={clusters.filter(
                (c) => c.clusterId !== selectedClusterId,
              )}
              selectedClusterId={redelegateDstClusterId}
              {...(onShowClusterDetail
                ? { onShowDetails: onShowClusterDetail }
                : {})}
              onSelect={(id) => {
                setRedelegateDstClusterId(id);
                setStep("redelegate-form");
              }}
            />
          </>
        )}

        {step === "form" && selectedCluster !== null && (
          <StakeForm
            cluster={selectedCluster}
            amountStr={amountStr}
            onAmountChange={setAmountStr}
            balanceWei={balanceLythoshi}
            existingWeightBps={existingWeightBps}
            capBps={capBps}
            onContinue={() => setStep("preview")}
            onBack={() => setStep("pick")}
          />
        )}

        {step === "preview" && selectedCluster !== null && (
          <PreviewView
            cluster={selectedCluster}
            action={action}
            destCluster={
              action === "redelegate" && redelegateDstClusterId !== null
                ? (clusters.find((c) => c.clusterId === redelegateDstClusterId) ?? null)
                : null
            }
            amountStr={amountStr}
            balanceLythoshi={balanceLythoshi}
            existingWeightBps={existingWeightBps}
            onConfirm={() => void handleConfirm()}
            onBack={() =>
              setStep(
                action === "delegate"
                  ? "form"
                  : action === "undelegate"
                    ? "unstake-form"
                    : "redelegate-form",
              )
            }
          />
        )}

        {step === "submitting" && <SubmittingView />}

        {step === "success" && txHash !== null && (
          <SuccessView
            action={action}
            txHash={txHash}
            copied={hashCopied}
            onCopy={() => void handleCopyHash()}
            onDone={onBack}
          />
        )}

        {step === "error" && submitError !== null && (
          <ErrorView
            error={submitError}
            onRetry={() => {
              setSubmitError(null);
              setStep("form");
            }}
            onCancel={onBack}
          />
        )}
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary banner — shown on the picker step
// ─────────────────────────────────────────────────────────────────────────────

interface SummaryBannerProps {
  delegations: DelegationsView | null;
  balanceLythoshi: bigint | null;
}

function SummaryBanner({ delegations, balanceLythoshi }: SummaryBannerProps) {
  const stakedBps = delegations?.totalBps ?? 0;
  const stakedLythoshi =
    balanceLythoshi !== null && stakedBps > 0
      ? (balanceLythoshi * BigInt(stakedBps)) / 10_000n
      : 0n;
  const liquidLythoshi =
    balanceLythoshi !== null ? balanceLythoshi - stakedLythoshi : null;
  return (
    <div className="ext-card" style={{ padding: 12, marginBottom: 4 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 12,
          fontSize: 11.5,
        }}
      >
        <KvStack
          label="Liquid"
          value={
            liquidLythoshi === null
              ? "—"
              : `${formatLythoshi(liquidLythoshi)} LYTH`
          }
          tone="var(--fg-100)"
        />
        <KvStack
          label="Staked"
          value={
            stakedLythoshi === 0n && balanceLythoshi !== null
              ? "0 LYTH"
              : balanceLythoshi === null
                ? "—"
                : `${formatLythoshi(stakedLythoshi)} LYTH (${(stakedBps / 100).toFixed(2)}%)`
          }
          tone="var(--gold)"
        />
      </div>
    </div>
  );
}

function KvStack({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: string;
}) {
  return (
    <div>
      <div
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 9.5,
          color: "var(--fg-500)",
          letterSpacing: "0.1em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 13,
          fontWeight: 600,
          color: tone,
          marginTop: 2,
        }}
      >
        {value}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-step renders
// ─────────────────────────────────────────────────────────────────────────────

interface PreviewViewProps {
  cluster: ClusterDirectoryEntry;
  action: Action;
  destCluster: ClusterDirectoryEntry | null;
  amountStr: string;
  balanceLythoshi: bigint | null;
  existingWeightBps: number;
  onConfirm: () => void;
  onBack: () => void;
}

function PreviewView({
  cluster,
  action,
  destCluster,
  amountStr,
  balanceLythoshi,
  existingWeightBps,
  onConfirm,
  onBack,
}: PreviewViewProps) {
  const amountLythoshi = parseLythAmountToLythoshi(amountStr);
  const aprBps = cluster.aprBps ?? null;
  const isUndelegate = action === "undelegate";
  // Undelegate is full-row removal — the chain has no partial unstake, so
  // the "moved" weight is the entire existing delegation regardless of any
  // amount field, and the LYTH shown is the full delegated principal.
  const fullDelegationLythoshi =
    balanceLythoshi !== null && existingWeightBps > 0
      ? (balanceLythoshi * BigInt(existingWeightBps)) / 10_000n
      : 0n;
  const moveBps = isUndelegate
    ? existingWeightBps
    : amountLythoshi !== null && balanceLythoshi !== null && balanceLythoshi > 0n
      ? lythAmountToBps(amountLythoshi, balanceLythoshi)
      : 0;
  const totalAfterBps =
    action === "delegate"
      ? existingWeightBps + moveBps
      : Math.max(0, existingWeightBps - moveBps); // source after undelegate/redelegate
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="ext-card" style={{ padding: 14 }}>
        <Row
          k={action === "redelegate" ? "Source cluster" : "Cluster"}
          v={cluster.name ?? `cluster-${cluster.clusterId}`}
        />
        {action === "redelegate" && destCluster !== null && (
          <Row
            k="Destination"
            v={destCluster.name ?? `cluster-${destCluster.clusterId}`}
            tone="var(--gold)"
          />
        )}
        <Row
          k="Amount"
          v={
            isUndelegate
              ? `${formatLythoshi(fullDelegationLythoshi)} LYTH (entire delegation)`
              : `${amountStr} LYTH`
          }
          tone="var(--gold)"
        />
        <Row
          k={
            action === "delegate"
              ? "Added weight"
              : action === "undelegate"
                ? "Removed weight"
                : "Moved weight"
          }
          v={`${(moveBps / 100).toFixed(2)}%`}
        />
        <Row
          k={
            action === "delegate"
              ? "Total weight after"
              : action === "undelegate"
                ? "Remaining at cluster"
                : "Remaining at source"
          }
          v={`${(totalAfterBps / 100).toFixed(2)}%`}
        />
        <Row
          k="APR"
          v={aprBps === null ? "—" : `${(aprBps / 100).toFixed(2)}%`}
        />
        <Row
          k={
            action === "redelegate"
              ? "Cluster swap"
              : action === "undelegate"
                ? "Redemption"
                : "Unbonding"
          }
          v={
            action === "redelegate"
              ? "Instant"
              : action === "undelegate"
                ? "Queued (claim on maturity)"
                : "Instant (zero-unbond)"
          }
          tone={action === "undelegate" ? "var(--gold)" : "var(--ok)"}
        />
      </div>

      <div className="ext-card" style={{ padding: 12 }}>
        <div
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 9.5,
            color: "var(--fg-500)",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            marginBottom: 4,
          }}
        >
          Chain
        </div>
        <div
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 10.5,
            color: "var(--fg-300)",
            lineHeight: 1.6,
          }}
        >
          {action === "delegate" &&
            "Submits `delegate(uint32 cluster, uint16 weightBps)` to the delegation precompile via the encrypted-mempool path; the LYTH amount is sent as msg.value (your staked principal)."}
          {action === "undelegate" &&
            "Submits `undelegate(uint32 cluster)` — removes your entire delegation row; principal enters the redemption queue (claim on maturity)."}
          {action === "redelegate" &&
            "Submits `redelegate(srcCluster, dstCluster, weightBps)` — instant cluster swap, no cooldown."}{" "}
          Sprintnet may reject the call until the gate is activated.
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 8,
        }}
      >
        <button onClick={onBack} style={secondaryBtn}>
          Back
        </button>
        <button
          className="ext-act prim"
          onClick={onConfirm}
          style={{
            padding: 12,
            flexDirection: "row",
            gap: 8,
          }}
        >
          <Icon name="check" size={12} /> Confirm
        </button>
      </div>
    </div>
  );
}

function SubmittingView() {
  return (
    <div
      style={{
        padding: "60px 20px",
        textAlign: "center",
        fontSize: 12.5,
        color: "var(--fg-300)",
        fontFamily: "var(--f-mono)",
      }}
    >
      <Icon name="stake" size={32} />
      <div style={{ marginTop: 16 }}>Submitting delegation…</div>
      <div
        style={{ fontSize: 10, color: "var(--fg-500)", marginTop: 6, lineHeight: 1.5 }}
      >
        Encrypted-mempool envelope → cluster → admission gate
      </div>
    </div>
  );
}

interface SuccessViewProps {
  action: Action;
  txHash: string;
  copied: boolean;
  onCopy: () => void;
  onDone: () => void;
}

function SuccessView({ action, txHash, copied, onCopy, onDone }: SuccessViewProps) {
  const title =
    action === "claim"
      ? "Rewards claim submitted"
      : action === "undelegate"
        ? "Unstake submitted (instant)"
        : action === "redelegate"
          ? "Cluster swap submitted (instant)"
          : "Delegation submitted";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div
        style={{
          padding: "40px 20px",
          textAlign: "center",
          color: "var(--ok)",
        }}
      >
        <Icon name="check" size={40} />
        <div
          style={{ marginTop: 16, fontSize: 13.5, fontWeight: 600 }}
        >
          {title}
        </div>
      </div>
      <div className="ext-card" style={{ padding: 12 }}>
        <div
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 9.5,
            color: "var(--fg-500)",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
          }}
        >
          Transaction hash
        </div>
        <div
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 10.5,
            color: "var(--fg-200)",
            marginTop: 6,
            wordBreak: "break-all",
          }}
        >
          {txHash}
        </div>
        <button onClick={onCopy} style={{ ...secondaryBtn, marginTop: 8, width: "100%" }}>
          {copied ? "Copied" : "Copy hash"}
        </button>
        <a
          href={monoscanTxUrl(txHash)}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            ...secondaryBtn,
            marginTop: 8,
            width: "100%",
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            textDecoration: "none",
          }}
        >
          <Icon name="globe" size={13} /> View on Monoscan
        </a>
      </div>
      <button onClick={onDone} className="ext-act prim" style={{ padding: 12 }}>
        Done
      </button>
    </div>
  );
}

interface ErrorViewProps {
  error: {
    message: string;
    code: number | null;
    method: string | null;
    via: string | null;
  };
  onRetry: () => void;
  onCancel: () => void;
}

function ErrorView({ error, onRetry, onCancel }: ErrorViewProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div
        style={{
          padding: "40px 20px",
          textAlign: "center",
          color: "var(--err)",
        }}
      >
        <Icon name="warn" size={40} />
        <div
          style={{ marginTop: 16, fontSize: 13, fontWeight: 600 }}
        >
          Delegation failed
        </div>
      </div>
      <div
        style={{
          padding: 12,
          borderRadius: 10,
          background: "rgba(220,80,80,0.08)",
          border: "1px solid rgba(220,80,80,0.4)",
        }}
      >
        <div
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 11,
            color: "var(--err)",
            wordBreak: "break-word",
            lineHeight: 1.5,
          }}
        >
          {error.message}
        </div>
        {(error.code !== null || error.method !== null || error.via !== null) && (
          <div
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 9.5,
              color: "var(--fg-500)",
              marginTop: 8,
            }}
          >
            {error.code !== null && <>code {error.code} · </>}
            {error.method !== null && <>{error.method} · </>}
            {error.via !== null && <>via {error.via}</>}
          </div>
        )}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 8,
        }}
      >
        <button onClick={onCancel} style={secondaryBtn}>
          Cancel
        </button>
        <button onClick={onRetry} className="ext-act prim" style={{ padding: 12 }}>
          Retry
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers + styles
// ─────────────────────────────────────────────────────────────────────────────

const NATIVE_LYTH_DECIMALS = 8;

export function parseLythAmountToLythoshi(s: string): bigint | null {
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const dot = s.indexOf(".");
  const intPart = dot < 0 ? s : s.slice(0, dot);
  const fracPart = dot < 0 ? "" : s.slice(dot + 1);
  if (fracPart.length > NATIVE_LYTH_DECIMALS) return null;
  const padded =
    fracPart + "0".repeat(NATIVE_LYTH_DECIMALS - fracPart.length);
  try {
    const lythoshi =
      BigInt(intPart) * LYTHOSHI_PER_LYTH +
      (padded.length > 0 ? BigInt(padded) : 0n);
    return lythoshi > 0n ? lythoshi : null;
  } catch {
    return null;
  }
}

/** Convert an autovote allocation row + the wallet balance into the
 *  LYTH-amount string the StakeForm + preview expect. Floors to 6
 *  decimal places for display continuity with the manual flow. */
export function allocationToLythAmountStr(
  alloc: AutovoteAllocation,
  balanceLythoshi: bigint | null,
): string {
  if (
    balanceLythoshi === null ||
    balanceLythoshi === 0n ||
    alloc.weightBps <= 0
  ) {
    return "0";
  }
  const allocationLythoshi =
    (balanceLythoshi * BigInt(alloc.weightBps)) / 10_000n;
  return lythoshiToLythDecimal(allocationLythoshi, 6);
}

// ─────────────────────────────────────────────────────────────────────────────
// ExistingDelegations — per-cluster active stake with Unstake / Redelegate
// ─────────────────────────────────────────────────────────────────────────────

interface ExistingDelegationsProps {
  delegations: DelegationsView;
  clusters: ReadonlyArray<ClusterDirectoryEntry>;
  balanceLythoshi: bigint | null;
  onUnstake: (clusterId: number) => void;
  onRedelegate: (clusterId: number) => void;
}

function ExistingDelegations({
  delegations,
  clusters,
  balanceLythoshi,
  onUnstake,
  onRedelegate,
}: ExistingDelegationsProps) {
  const clusterById = useMemo(() => {
    const m = new Map<number, ClusterDirectoryEntry>();
    for (const c of clusters) m.set(c.clusterId, c);
    return m;
  }, [clusters]);

  return (
    <div className="ext-card" style={{ padding: 12 }}>
      <div
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 10,
          color: "var(--fg-400)",
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          marginBottom: 8,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span>Active delegations</span>
        <span
          style={{
            fontSize: 9,
            color: "var(--fg-500)",
            letterSpacing: "0.06em",
            textTransform: "none",
          }}
        >
          {delegations.rows.length} cluster
          {delegations.rows.length === 1 ? "" : "s"} ·{" "}
          {(delegations.totalBps / 100).toFixed(2)}% total
        </span>
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        {delegations.rows.map((row) => {
          const c = clusterById.get(row.cluster);
          const amountLythoshi =
            balanceLythoshi !== null
              ? (balanceLythoshi * BigInt(row.weightBps)) / 10_000n
              : null;
          return (
            <div
              key={row.cluster}
              style={{
                padding: "8px 10px",
                borderRadius: 8,
                border: "1px solid var(--fg-700)",
                background: "rgba(255,255,255,0.02)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  marginBottom: 6,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: "var(--fg-100)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {c?.name ?? `cluster-${row.cluster}`}
                  </div>
                  <div
                    style={{
                      fontFamily: "var(--f-mono)",
                      fontSize: 9.5,
                      color: "var(--fg-400)",
                      marginTop: 2,
                    }}
                  >
                    {(row.weightBps / 100).toFixed(2)}%
                    {amountLythoshi !== null && (
                      <> · {formatLythoshi(amountLythoshi)} LYTH</>
                    )}
                  </div>
                </div>
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 6,
                }}
              >
                <button
                  onClick={() => onUnstake(row.cluster)}
                  style={delegationActionBtnStyle}
                >
                  Unstake
                </button>
                <button
                  onClick={() => onRedelegate(row.cluster)}
                  style={delegationActionBtnStyle}
                >
                  Redelegate
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const delegationActionBtnStyle: CSSProperties = {
  padding: "6px 8px",
  borderRadius: 6,
  border: "1px solid var(--fg-700)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-mono)",
  fontSize: 10,
  cursor: "pointer",
  letterSpacing: "0.06em",
  textTransform: "uppercase",
};

// ─────────────────────────────────────────────────────────────────────────────
// EntryModeToggle — switches between manual + four autovote modes
// ─────────────────────────────────────────────────────────────────────────────

interface EntryModeToggleProps {
  entryMode: EntryMode;
  onChange: (mode: EntryMode) => void;
}

function EntryModeToggle({ entryMode, onChange }: EntryModeToggleProps) {
  const isManual = entryMode === "manual";
  const autovoteMode = isManual ? "max-decentralization" : (entryMode as AutovoteMode);
  return (
    <div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 6,
          marginBottom: isManual ? 0 : 12,
        }}
      >
        <button
          onClick={() => onChange("manual")}
          style={{
            ...modeToggleBtn,
            background: isManual ? "var(--gold-bg)" : "rgba(255,255,255,0.03)",
            color: isManual ? "var(--gold)" : "var(--fg-200)",
            border: isManual
              ? "1px solid var(--gold)"
              : "1px solid var(--fg-700)",
          }}
        >
          Manual pick
        </button>
        <button
          onClick={() => onChange("max-decentralization")}
          style={{
            ...modeToggleBtn,
            background: !isManual ? "var(--gold-bg)" : "rgba(255,255,255,0.03)",
            color: !isManual ? "var(--gold)" : "var(--fg-200)",
            border: !isManual
              ? "1px solid var(--gold)"
              : "1px solid var(--fg-700)",
          }}
        >
          Autovote
        </button>
      </div>
      {!isManual && (
        <AutovoteSelector
          mode={autovoteMode}
          onChange={(m) => onChange(m)}
        />
      )}
    </div>
  );
}

const modeToggleBtn: CSSProperties = {
  padding: "8px 10px",
  borderRadius: 8,
  fontFamily: "var(--f-sans)",
  fontSize: 11.5,
  fontWeight: 600,
  cursor: "pointer",
  transition: "all 100ms var(--e-out)",
};

// ─────────────────────────────────────────────────────────────────────────────
// AutovotePlanCard — preview the allocation plan + target slider
// ─────────────────────────────────────────────────────────────────────────────

interface AutovotePlanCardProps {
  entryMode: AutovoteMode;
  plan: AutovoteResult | null;
  clusters: ReadonlyArray<ClusterDirectoryEntry>;
  targetBps: number;
  onTargetChange: (bps: number) => void;
  capBps: number | null;
  seedAvailable: boolean;
  onProceed: () => void;
}

function AutovotePlanCard({
  entryMode,
  plan,
  clusters,
  targetBps,
  onTargetChange,
  capBps,
  seedAvailable,
  onProceed,
}: AutovotePlanCardProps) {
  const clusterById = useMemo(() => {
    const m = new Map<number, ClusterDirectoryEntry>();
    for (const c of clusters) m.set(c.clusterId, c);
    return m;
  }, [clusters]);

  if (entryMode === "custom") {
    return (
      <div className="ext-card" style={{ padding: 12 }}>
        <div
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 10,
            color: "var(--fg-400)",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            marginBottom: 6,
          }}
        >
          Custom allocation
        </div>
        <div
          style={{
            fontSize: 11.5,
            color: "var(--fg-300)",
            lineHeight: 1.5,
          }}
        >
          Pick clusters manually below, then enter per-cluster amounts on the
          form. The wallet enforces the {capBps === null ? "unlimited" : `${(capBps / 100).toFixed(0)}%`}{" "}
          per-cluster cap at submission time and warns before any
          out-of-policy distribution is signed.
        </div>
      </div>
    );
  }

  return (
    <div className="ext-card" style={{ padding: 12 }}>
      {!seedAvailable && (
        <div
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 10.5,
            color: "var(--warn)",
            padding: "6px 8px",
            borderRadius: 6,
            background: "rgba(244,201,122,0.08)",
            border: "1px solid rgba(244,201,122,0.4)",
            marginBottom: 8,
            lineHeight: 1.5,
          }}
        >
          Unlock the wallet to load the per-user entropy seed.
        </div>
      )}

      {/* Target slider */}
      <div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 6,
          }}
        >
          <span
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 10,
              color: "var(--fg-400)",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
            }}
          >
            Stake target
          </span>
          <span
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 13,
              fontWeight: 600,
              color: "var(--gold)",
            }}
          >
            {(targetBps / 100).toFixed(0)}%
          </span>
        </div>
        <input
          type="range"
          min={500}
          max={10_000}
          step={500}
          value={targetBps}
          onChange={(e) => onTargetChange(Number(e.target.value))}
          style={{ width: "100%" }}
        />
      </div>

      {/* Plan summary */}
      {plan === null ? (
        <div
          style={{
            marginTop: 10,
            padding: 10,
            fontSize: 11,
            color: "var(--fg-400)",
            fontFamily: "var(--f-mono)",
            textAlign: "center",
          }}
        >
          Computing plan…
        </div>
      ) : plan.allocations.length === 0 ? (
        <div
          style={{
            marginTop: 10,
            padding: 10,
            fontSize: 11,
            color: "var(--err)",
            fontFamily: "var(--f-mono)",
            background: "rgba(220,80,80,0.08)",
            border: "1px solid rgba(220,80,80,0.4)",
            borderRadius: 8,
          }}
        >
          {plan.reason}
        </div>
      ) : (
        <div style={{ marginTop: 10 }}>
          <div
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 10,
              color: "var(--fg-400)",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              marginBottom: 6,
            }}
          >
            Proposed plan
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              maxHeight: 180,
              overflowY: "auto",
            }}
          >
            {plan.allocations.map((a) => {
              const c = clusterById.get(a.cluster);
              return (
                <div
                  key={a.cluster}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    fontSize: 11.5,
                    padding: "6px 8px",
                    borderRadius: 6,
                    background: "rgba(255,255,255,0.03)",
                    border: "1px solid var(--fg-700)",
                  }}
                >
                  <span
                    style={{
                      fontFamily: "var(--f-mono)",
                      color: "var(--fg-100)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {c?.name ?? `cluster-${a.cluster}`}
                  </span>
                  <span
                    style={{
                      fontFamily: "var(--f-mono)",
                      color: "var(--gold)",
                      fontWeight: 600,
                    }}
                  >
                    {(a.weightBps / 100).toFixed(2)}%
                  </span>
                </div>
              );
            })}
          </div>
          {plan.shortfallBps > 0 && (
            <div
              style={{
                marginTop: 8,
                fontFamily: "var(--f-mono)",
                fontSize: 9.5,
                color: "var(--warn)",
                lineHeight: 1.5,
              }}
            >
              Shortfall: {(plan.shortfallBps / 100).toFixed(2)}% — increase
              diversification or reduce target.
            </div>
          )}
          <div
            style={{
              marginTop: 8,
              fontFamily: "var(--f-mono)",
              fontSize: 9,
              color: "var(--fg-500)",
              lineHeight: 1.5,
            }}
          >
            {plan.reason}
          </div>
          <button
            onClick={onProceed}
            className="ext-act prim"
            disabled={plan.allocations.length === 0}
            style={{
              marginTop: 10,
              width: "100%",
              padding: 10,
              flexDirection: "row",
              gap: 8,
            }}
          >
            <Icon name="check" size={12} />
            Review first allocation
          </button>
          <div
            style={{
              marginTop: 6,
              fontFamily: "var(--f-mono)",
              fontSize: 9,
              color: "var(--fg-500)",
              lineHeight: 1.5,
              textAlign: "center",
            }}
          >
            Submits one tx per allocation. Phase 7 ships the first; multi-tx
            batching lands as a follow-up.
          </div>
        </div>
      )}
    </div>
  );
}

export function formatLythoshi(lythoshi: bigint, decimals = 4): string {
  return lythoshiToLythDecimal(lythoshi, decimals);
}

function Row({
  k,
  v,
  tone,
}: {
  k: string;
  v: string;
  tone?: string;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "120px 1fr",
        gap: 8,
        padding: "4px 0",
        alignItems: "baseline",
      }}
    >
      <span
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 9.5,
          color: "var(--fg-500)",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
        }}
      >
        {k}
      </span>
      <span
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 11,
          color: tone ?? "var(--fg-100)",
          wordBreak: "break-word",
        }}
      >
        {v}
      </span>
    </div>
  );
}

const secondaryBtn: CSSProperties = {
  padding: 12,
  borderRadius: 10,
  border: "1px solid var(--fg-700)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-sans)",
  fontSize: 12,
  cursor: "pointer",
};

const errBanner: CSSProperties = {
  padding: "10px 12px",
  borderRadius: 10,
  background: "rgba(220,80,80,0.08)",
  border: "1px solid rgba(220,80,80,0.4)",
  fontFamily: "var(--f-mono)",
  fontSize: 11,
  color: "var(--err)",
  lineHeight: 1.5,
};
