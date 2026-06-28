// Stake page. Top-level orchestrator for the cluster
// directory → form → preview → submitting → success | error flow.
//
// Replaces the legacy placeholder Stake exported from components.tsx
// (which was a static four-button strategy mock with no chain wiring).
// AutovoteSelector + the four-button §23.9 path is
// an alternative entry into the same submit step.
//
// NON-CUSTODIAL delegation: the user picks a PERCENT of their balance to
// delegate to a cluster (= weightBps). The form's Continue → preview →
// Confirm flow encodes `delegate(uint32,uint16)` calldata via
// shared/staking-tx.ts (SDK encoders) and submits through `bgWalletSendTx`
// with value = 0 — NO tokens are escrowed. The wallet's contribution to a
// cluster is the effective weight (balance × weightBps / 10000) of its live
// balance; the LYTH stays liquid and spendable. The delegation precompile
// (`0x100A`) is live + enabled on the testnet (`lyth_listActivePrecompiles`);
// the wallet surfaces any typed error the chain returns verbatim.

import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Icon } from "../Icon";
import { hoverBg, hoverBright } from "../hover";
import { monoscanTxUrl, monoscanAddressUrl } from "../../shared/build-info";
import { classifySendError, errorLinksOperators, severityColours } from "../../shared/send-error";
import { bech32mDisplay } from "../../shared/bech32m";
import { formatNativeLythAmount } from "../../shared/native-fee-display";
import { ClipboardIcon, CheckIcon } from "../components/AddressLine";
import { ExternalLink } from "../components/ExternalLink";
import { AutovoteSelector } from "../components/AutovoteSelector";
import { ClusterPicker } from "../components/ClusterPicker";
import { RedelegateForm } from "../components/RedelegateForm";
import { RewardCard, pendingRewardsArePositive } from "../components/RewardCard";
import { StakeForm } from "../components/StakeForm";
import { UnstakeForm } from "../components/UnstakeForm";
import { useFeature } from "../hooks/useFeature";
import {
  bgStakingAutovoteSeed,
  bgStakingClusterDirectory,
  bgStakingDelegationCap,
  bgStakingDelegations,
  bgStakingPendingRewards,
  bgWalletBalance,
  bgWalletSendTx,
  type ClusterDirectoryEntry,
  type DelegationsView,
  type PendingRewardsView,
} from "../bg";
import { buildClaimMeta } from "../claim-meta";
import { useInFlightClaim, useClaimConfirmed } from "../hooks/useInFlightClaim";
import type { Account } from "../demo-data";
import {
  DELEGATION_PRECOMPILE,
  effectiveWeightWholeLythoshi,
  encodeClaimRewards,
  encodeDelegate,
  encodeRedelegate,
  encodeUndelegate,
  percentToBps,
} from "../../shared/staking-tx";
import {
  LYTHOSHI_PER_LYTH,
  NATIVE_LYTH_DECIMALS,
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
import {
  isPerWalletCapRevert,
  isWalletTotalCapRevert,
  PER_WALLET_CAP_REVERT_MESSAGE,
  WALLET_TOTAL_CAP_REVERT_MESSAGE,
} from "../../shared/staking";

type Step =
  | "pick"
  | "form"
  | "unstake-form"
  | "redelegate-form"
  | "redelegate-dst-pick"
  | "unstake-all"
  | "preview"
  | "submitting"
  | "success"
  | "error";

/** Action the user is preparing. Drives the preview/submit calldata
 *  encoding + the success copy. */
type Action = "delegate" | "undelegate" | "redelegate" | "claim";

/** Top-level interaction mode. `"manual"` = single-cluster pick →
 *  stake form path. The four autovote modes route through
 *  AutovotePreview before submitting; only the first allocation submits. */
type EntryMode = "manual" | AutovoteMode;

// sessionStorage persistence so a round-trip through ClusterDetail
// restores the user's prior selection + step (App.tsx routes Stake and
// ClusterDetail as sibling screens, so Stake unmounts on navigation).
// Cleared by App.tsx when the user explicitly leaves Stake via onBack.
const STAKE_STATE_KEY = "monowallet_stake_state";

// Pending-rewards poll cadence. Matches App.tsx BALANCE_POLL_MS (3 s ≈
// block-time) so the wallet keeps one refresh rhythm.
const REWARDS_POLL_MS = 3_000;

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
   *  on the testnet. */
  chainId: string;
  /** Optional entry point — when the page is opened from the
   *  Delegations dashboard, the parent supplies a pre-selected
   *  cluster + the unstake / redelegate-from-this-cluster action.
   *  Resets to manual delegate on mount when omitted. */
  initialAction?: "delegate" | "undelegate" | "redelegate";
  initialClusterId?: number;
  /** When supplied, the ClusterPicker rows expose
   *  a "View details →" affordance that calls this with the directory
   *  entry. App navigates to the dedicated cluster-detail screen. */
  onShowClusterDetail?: (
    cluster: import("../../shared/staking").ClusterDirectoryEntry,
  ) => void;
  /** Opens the operator directory — wired to the genesis-mismatch error's
   *  "Operators" word so it becomes a button (mirrors Send). */
  onOpenOperators?: () => void;
  onBack: () => void;
}

export function Stake({
  account,
  chainId,
  initialAction,
  initialClusterId,
  onShowClusterDetail,
  onOpenOperators,
  onBack,
}: StakeProps) {
  // Restore prior Stake state when the user returns from a sibling
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

  // #2 — guard against a double claim-broadcast. Reads the durable in-flight
  // signal (persisted), so it holds even if the popup was closed + reopened
  // mid-claim (local `step` state would be lost).
  const claimInFlight = useInFlightClaim(account.addr, chainId);

  // Cluster directory state.
  const [clusters, setClusters] = useState<ClusterDirectoryEntry[]>([]);
  const [clustersError, setClustersError] = useState<string | null>(null);
  const devMode = useFeature("DEVELOPER_MODE");

  // Delegation context state.
  const [delegations, setDelegations] = useState<DelegationsView | null>(null);
  const [capBps, setCapBps] = useState<number | null>(null);
  const [balanceLythoshi, setBalanceLythoshi] = useState<bigint | null>(null);
  const [rewards, setRewards] = useState<PendingRewardsView | null>(null);
  const [rewardsMock, setRewardsMock] = useState(true);
  // Set when the pending-rewards read returns ok:false (hard error). Drives
  // RewardCard's honest-absence state instead of perpetual "Loading…".
  const [rewardsError, setRewardsError] = useState<string | null>(null);

  // §28.5 Q29 TRADING_INTERFACE flag gates the advanced
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
  // #2 — auto-dismiss the claim SuccessView once the claim confirms on-chain
  // (its pending row is receipt-bridged), so the user no longer has to tap Done.
  const claimSuccessConfirmed = useClaimConfirmed(
    account.addr,
    chainId,
    action === "claim" && step === "success" ? txHash : null,
  );
  useEffect(() => {
    if (!claimSuccessConfirmed) return;
    // Brief grace so the success is visibly seen, then close (== onDone).
    const t = setTimeout(() => onBack(), 1500);
    return () => clearTimeout(t);
  }, [claimSuccessConfirmed, onBack]);
  const [hashCopied, setHashCopied] = useState(false);
  const [submitError, setSubmitError] = useState<{
    message: string;
    code: number | null;
    method: string | null;
    via: string | null;
  } | null>(null);

  // "Unstake all" sequential flow. The chain has no bulk undelegate, so we
  // walk the wallet's clusters one review-form at a time (biggest stake
  // first). `unstakeAllQueue` is a snapshot of cluster ids; `unstakeAllIndex`
  // is the current position.
  const [unstakeAllQueue, setUnstakeAllQueue] = useState<number[]>([]);
  const [unstakeAllIndex, setUnstakeAllIndex] = useState(0);
  const [unstakeAllBusy, setUnstakeAllBusy] = useState(false);
  const [unstakeAllError, setUnstakeAllError] = useState<string | null>(null);

  // Persist key form / selection state on every change so a
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
    setRewardsError(null);
    void (async () => {
      const [delR, capR, balR, seedR] = await Promise.all([
        bgStakingDelegations(account.addr),
        bgStakingDelegationCap(),
        bgWalletBalance(account.addr, chainId),
        bgStakingAutovoteSeed(),
      ]);
      if (cancelled) return;
      if (delR.ok) setDelegations(delR.data);
      // F-3.8/#25: only adopt a LIVE cap; a via:"mock" (offline) read carries a
      // fabricated 50% launch cap that must not render as real (capBps stays
      // null → cap badge hidden; the 0x100A precompile enforces the true cap).
      if (capR.ok) setCapBps(capBpsFromCapResult(capR));
      if (balR.ok) {
        const parsedBalance = parseHexQuantity(balR.balanceHex);
        if (parsedBalance !== null) setBalanceLythoshi(parsedBalance);
      }
      if (seedR.ok) {
        const seedBytes = hexToBytes(seedR.seedHex);
        if (seedBytes !== null) setAutovoteSeed(seedBytes);
      }
      // Pending rewards: depends on the active delegation set, so we
      // fan it out after the delegations resolve. Chain GAP today —
      // the SW returns mock-derived figures with `via: "mock"`.
      if (delR.ok) {
        const rewR = await bgStakingPendingRewards(account.addr, delR.data.rows);
        if (!cancelled) {
          if (rewR.ok) {
            setRewards(rewR.data);
            setRewardsMock(rewR.via === "mock");
          } else {
            // Hard ok:false (malformed / non-"method absent" RPC error) —
            // surface honest absence instead of leaving the card on "Loading…".
            setRewardsError(rewR.reason);
          }
        }
      } else if (!cancelled) {
        // Delegations failed to load → pending rewards can't be keyed off the
        // active set; show honest absence rather than perpetual loading.
        setRewardsError(delR.reason);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account.addr, chainId]);

  // Poll pending rewards on the shared cadence (REWARDS_POLL_MS ==
  // App.BALANCE_POLL_MS) so the Claim amount stays live without a manual
  // refresh. The live lyth_pendingRewards RPC is keyed on the wallet only; the
  // rows arg just feeds the never-displayed mock fallback, so [] is fine. A
  // transient poll failure keeps the last good value (no error/clear on !ok).
  useEffect(() => {
    if (!account.addr.startsWith("0x")) return;
    const id = setInterval(() => {
      void (async () => {
        const rewR = await bgStakingPendingRewards(account.addr, []);
        if (rewR.ok) {
          setRewards(rewR.data);
          setRewardsMock(rewR.via === "mock");
        }
      })();
    }, REWARDS_POLL_MS);
    return () => clearInterval(id);
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
  // for the testnet.
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
      // The delegation weight (bps) captured PURELY as notification metadata.
      // For delegate/redelegate it's the same uint16 already encoded into
      // `data` (signed tx byte-identical); for undelegate it's the existing
      // full-row weight being removed (not encoded — undelegate is full-row).
      // Claim leaves it undefined (no weight).
      let delegationWeightBps: number | undefined;
      // NON-CUSTODIAL: delegation never carries native value. The chain
      // reverts (UnexpectedValue / tag 0x020e) if any value is attached —
      // tokens stay liquid in the wallet, weighted by `weightBps`.
      const valueWeiHex = "0x0";
      if (action === "claim") {
        data = encodeClaimRewards();
        executionUnitLimitHex = "0x14820"; // 84000 — selector-only allowance
      } else if (action === "undelegate") {
        // Chain `undelegate(uint32 cluster)` instantly removes the wallet's
        // entire row for the cluster (full-row removal; no partial unstake).
        // No redemption queue or cooldown — nothing was escrowed.
        data = encodeUndelegate(selectedCluster!.clusterId);
        executionUnitLimitHex = "0x186A0";
        // Notification metadata: undelegate removes the FULL row, so the % to
        // show is the cluster's existing weight (no bps is encoded in `data`).
        // Pass `undefined`, NOT 0, when the cache doesn't hold the weight — see
        // undelegateNotificationWeightBps.
        delegationWeightBps = undelegateNotificationWeightBps(existingWeightBps);
      } else {
        // `amountStr` is a PERCENT of balance (0–100) in both the manual
        // and autovote paths. Convert to weightBps for the calldata.
        const bps = percentToBps(Number(amountStr));
        if (bps <= 0 || balanceLythoshi === null) {
          setSubmitError({
            message: "invalid percent",
            code: null,
            method: null,
            via: null,
          });
          setStep("error");
          return;
        }
        delegationWeightBps = bps; // notification metadata — same bps as the calldata
        if (action === "delegate") {
          // Balance-weighted, non-custodial: weightBps only. No msg.value.
          data = encodeDelegate(selectedCluster!.clusterId, bps);
        } else {
          data = encodeRedelegate(
            selectedCluster!.clusterId,
            redelegateDstClusterId!,
            bps,
          );
        }
        // The delegation precompile's execution-unit budget isn't measured yet
        // (chain GAP — execution-unit budget not yet measured on-chain). Use a generous overhead-aware
        // estimate; redelegate carries one extra arg so we bump the
        // budget slightly for that path.
        executionUnitLimitHex = action === "redelegate" ? "0x1D4C0" : "0x186A0";
      }
      // Redelegate destination cluster name (for the from→to toast — the
      // activity row resolves it from the live directory, but the toast can't).
      const redelegateDstName =
        action === "redelegate" && redelegateDstClusterId !== null
          ? (clusters.find((c) => c.clusterId === redelegateDstClusterId)?.name ?? null)
          : null;
      const r = await bgWalletSendTx({
        to: DELEGATION_PRECOMPILE,
        valueWeiHex,
        chainIdHex: chainId,
        data,
        executionUnitLimitHex,
        // `action` is "delegate" | "undelegate" | "redelegate" at this call
        // site (claim has its own handler below). All three are valid
        // TxOpKind literals so this rides through verbatim.
        opKind: action,
        // Cluster metadata so the notification + detail can name the cluster
        // (the tx `to` is the delegation module, not the cluster). For
        // redelegate this is the SOURCE cluster. Pending-row metadata only —
        // never part of the signed tx. `name` is the real *.cluster.mono
        // directory name when registered; omitted when null.
        clusterId: selectedCluster!.clusterId,
        ...(selectedCluster!.name ? { clusterName: selectedCluster!.name } : {}),
        ...(action === "redelegate" && redelegateDstClusterId !== null
          ? { toClusterId: redelegateDstClusterId }
          : {}),
        ...(redelegateDstName ? { toClusterName: redelegateDstName } : {}),
        ...(delegationWeightBps !== undefined ? { delegationWeightBps } : {}),
      });
      if (r.ok) {
        setTxHash(r.result.txHash);
        setStep("success");
      } else {
        const code = typeof r.code === "number" ? r.code : null;
        // Map the chain's cap reverts — PerWalletCapExceeded (0x0213) and
        // WalletTotalExceeded (0x0205) — which the pre-flight guards now
        // prevent, but could still slip through on a race or a future cap
        // change — to clear messages instead of a generic "rejected". Specific
        // to those codes; other revert codes keep the raw reason.
        const message = isPerWalletCapRevert(r.reason, code)
          ? PER_WALLET_CAP_REVERT_MESSAGE
          : isWalletTotalCapRevert(r.reason, code)
            ? WALLET_TOTAL_CAP_REVERT_MESSAGE
            : (r.reason ?? `${action} rejected`);
        setSubmitError({
          message,
          code,
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

  // ── "Unstake all" sequential flow ──────────────────────────────────────
  // No bulk undelegate on-chain (undelegate is single-cluster), so this walks
  // the clusters one review-form at a time, biggest stake first.
  const handleUnstakeAll = () => {
    if (delegations === null || delegations.rows.length === 0) return;
    // Effective weight desc == weightBps desc (same balance across rows).
    const queue = [...delegations.rows]
      .sort((a, b) => b.weightBps - a.weightBps)
      .map((r) => r.cluster);
    setUnstakeAllQueue(queue);
    setUnstakeAllIndex(0);
    setUnstakeAllError(null);
    setUnstakeAllBusy(false);
    setAction("undelegate");
    setSelectedClusterId(queue[0] ?? null);
    setStep("unstake-all");
  };

  // Advance to the next cluster in the queue, or finish (back to the picker).
  const goToNextUnstake = (currentIndex: number) => {
    setUnstakeAllError(null);
    setUnstakeAllBusy(false);
    const next = currentIndex + 1;
    if (next >= unstakeAllQueue.length) {
      setUnstakeAllQueue([]);
      setUnstakeAllIndex(0);
      setSelectedClusterId(null);
      setStep("pick");
    } else {
      setUnstakeAllIndex(next);
      setSelectedClusterId(unstakeAllQueue[next] ?? null);
      setStep("unstake-all");
    }
  };

  const handleUnstakeAllCancel = () => {
    setUnstakeAllQueue([]);
    setUnstakeAllIndex(0);
    setUnstakeAllError(null);
    setUnstakeAllBusy(false);
    setSelectedClusterId(null);
    setStep("pick");
  };

  const handleUnstakeAllConfirm = async () => {
    const cluster = unstakeAllQueue[unstakeAllIndex];
    if (cluster === undefined) return;
    setUnstakeAllBusy(true);
    setUnstakeAllError(null);
    try {
      const meta = clusters.find((c) => c.clusterId === cluster);
      const rowWeightBps = delegations?.rows.find(
        (row) => row.cluster === cluster,
      )?.weightBps;
      const r = await bgWalletSendTx({
        to: DELEGATION_PRECOMPILE,
        valueWeiHex: "0x0",
        chainIdHex: chainId,
        data: encodeUndelegate(cluster),
        executionUnitLimitHex: "0x186A0",
        opKind: "undelegate",
        clusterId: cluster,
        ...(meta?.name ? { clusterName: meta.name } : {}),
        ...(rowWeightBps !== undefined ? { delegationWeightBps: rowWeightBps } : {}),
      });
      if (r.ok) {
        goToNextUnstake(unstakeAllIndex);
      } else {
        setUnstakeAllBusy(false);
        setUnstakeAllError(r.reason ?? "undelegate rejected");
      }
    } catch (e) {
      setUnstakeAllBusy(false);
      setUnstakeAllError((e as Error).message ?? "undelegate failed");
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
      // Capture the frozen fiat rate + currency BEFORE broadcast (shared helper —
      // identical at both claim sites). The claimed AMOUNT is NOT captured here
      // (the submit-time pending-rewards value is wrong); it is decoded from the
      // receipt's Claimed log after confirmation. valueWeiHex stays 0x0; metadata
      // never signs.
      const claim = await buildClaimMeta();
      const r = await bgWalletSendTx({
        to: DELEGATION_PRECOMPILE,
        valueWeiHex: "0x0",
        chainIdHex: chainId,
        data: encodeClaimRewards(),
        executionUnitLimitHex: "0x14820", // 84000 — selector-only allowance
        opKind: "claim",
        claimedAmount: claim.claimedAmount,
        rateAtClaim: claim.rateAtClaim,
        currency: claim.currency,
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
          style={{ flex: 1, fontSize: 15, fontWeight: 600, textAlign: "center" }}
        >
          {step === "pick"
            ? "Delegate"
            : step === "form"
              ? "Delegate — amount"
              : step === "unstake-form"
                ? "Undelegate — amount"
                : step === "redelegate-form"
                  ? "Redelegate"
                  : step === "redelegate-dst-pick"
                    ? "Redelegate — destination"
                    : step === "preview"
                      ? action === "delegate"
                        ? "Review delegation"
                        : action === "undelegate"
                          ? "Review undelegation"
                          : "Review redelegation"
                      : step === "submitting"
                        ? action === "claim"
                          ? "Claiming…"
                          : "Submitting…"
                        : step === "success"
                          ? action === "claim"
                            ? "Claimed"
                            : action === "undelegate"
                              ? "Undelegated"
                              : action === "redelegate"
                                ? "Redelegated"
                                : "Delegated"
                          : step === "unstake-all"
                            ? "Undelegate all"
                            : "Error"}
        </div>
        <div style={{ width: 36 }} />
      </div>

      <div className="ext-body">
        {step === "pick" && (
          <>
            <SummaryBanner
              delegations={delegations}
              balanceLythoshi={balanceLythoshi}
            />

            {/* Pending rewards + (for active delegators) the Unstake-all card.
                The reward card shows whenever there is a LIVE positive pending
                balance — even with no active delegation, so rewards still
                accrued after undelegating everything stay claimable. Unstake-all
                stays gated on having active delegations. */}
            {(pendingRewardsArePositive(rewards, rewardsMock) ||
              (delegations !== null && delegations.rows.length > 0)) && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    delegations !== null && delegations.rows.length > 0
                      ? "1fr 1fr"
                      : "1fr",
                  gap: 8,
                  marginBottom: 4,
                }}
              >
                <RewardCard
                  compact
                  rewards={rewards}
                  error={rewardsError}
                  isMock={rewardsMock}
                  clusters={clusters}
                  onClaim={() => void handleClaim()}
                  claimDisabled={claimInFlight}
                  claimPending={claimInFlight}
                  showAdvancedAnalytics={tradingInterfaceOn}
                />
                {delegations !== null && delegations.rows.length > 0 && (
                  <UnstakeAllCard
                    effectiveWeightLythoshi={effectiveWeightWholeLythoshi(
                      delegations.totalBps,
                      balanceLythoshi ?? 0n,
                    )}
                    totalBps={delegations.totalBps}
                    balanceLythoshi={balanceLythoshi}
                    onUnstakeAll={handleUnstakeAll}
                  />
                )}
              </div>
            )}

            {/* Existing delegations — manage Unstake / Redelegate per row */}
            {delegations !== null && delegations.rows.length > 0 && (
              <ExistingDelegations
                delegations={delegations}
                clusters={clusters}
                balanceLythoshi={balanceLythoshi}
                onStake={(clusterId) => {
                  setAction("delegate");
                  setSelectedClusterId(clusterId);
                  setRedelegateDstClusterId(null);
                  setAmountStr("");
                  setStep("form");
                }}
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
                  // Single-tx submit of the FIRST allocation, through the
                  // standard `bgWalletSendTx` envelope path. `amountStr`
                  // carries the allocation's percent-of-balance.
                  const first = autovotePlan.allocations[0]!;
                  setSelectedClusterId(first.cluster);
                  setAmountStr(allocationToPercentStr(first));
                  setStep("preview");
                }}
              />
            )}

            {entryMode === "manual" && (
              <>
                {clustersError !== null ? (
                  <div style={errBanner}>
                    {(() => {
                      const c = classifySendError(clustersError);
                      const body =
                        errorLinksOperators(c.kind) && onOpenOperators
                          ? genesisErrorBody(c.body, onOpenOperators)
                          : c.body;
                      return (
                        <>
                          {body}
                          {devMode && c.body !== clustersError && (
                            <div
                              style={{
                                marginTop: 6,
                                fontFamily: "var(--f-mono)",
                                fontSize: 10,
                                color: "var(--fg-500)",
                                lineHeight: 1.5,
                                wordBreak: "break-word",
                              }}
                            >
                              {clustersError}
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>
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
            balanceLythoshi={balanceLythoshi}
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
            balanceLythoshi={balanceLythoshi}
            onContinue={() => setStep("preview")}
            onBack={() => setStep("pick")}
          />
        )}

        {step === "redelegate-dst-pick" &&
          (() => {
            // Destination = the same `cluster_directory` the delegate picker
            // uses, excluding the source cluster — UNLESS excluding it would
            // empty the list (this testnet currently advertises a single
            // cluster, so the old unconditional filter rendered nothing).
            // Never down to an empty list.
            const excludingSource = clusters.filter(
              (c) => c.clusterId !== selectedClusterId,
            );
            const dstClusters =
              excludingSource.length > 0 ? excludingSource : clusters;
            const onlySourceAvailable =
              excludingSource.length === 0 && clusters.length > 0;
            return (
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
                  {onlySourceAvailable
                    ? "Only one cluster is currently advertised — redelegation needs a second cluster to move weight to."
                    : "Pick the destination cluster (must differ from the source)."}
                </div>
                {clusters.length === 0 ? (
                  <div
                    style={{
                      padding: 20,
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
                    clusters={dstClusters}
                    selectedClusterId={redelegateDstClusterId}
                    {...(onShowClusterDetail
                      ? { onShowDetails: onShowClusterDetail }
                      : {})}
                    onSelect={(id) => {
                      setRedelegateDstClusterId(id);
                      setStep("redelegate-form");
                    }}
                  />
                )}
              </>
            );
          })()}

        {step === "form" && selectedCluster !== null && (
          <StakeForm
            cluster={selectedCluster}
            amountStr={amountStr}
            onAmountChange={setAmountStr}
            balanceLythoshi={balanceLythoshi}
            existingWeightBps={existingWeightBps}
            totalDelegatedBps={delegations?.totalBps ?? 0}
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

        {step === "unstake-all" && selectedCluster !== null && (
          <PreviewView
            cluster={selectedCluster}
            action="undelegate"
            destCluster={null}
            amountStr=""
            balanceLythoshi={balanceLythoshi}
            existingWeightBps={existingWeightBps}
            onConfirm={() => void handleUnstakeAllConfirm()}
            onBack={handleUnstakeAllCancel}
            sequence={{
              index: unstakeAllIndex,
              total: unstakeAllQueue.length,
              busy: unstakeAllBusy,
              error: unstakeAllError,
              onSkip: () => goToNextUnstake(unstakeAllIndex),
              onCancel: handleUnstakeAllCancel,
            }}
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
            clusterLabel={
              clusters.find((c) => c.clusterId === selectedClusterId)?.name ??
              null
            }
            clusterId={selectedClusterId}
            walletAddr0x={account.addr}
            amountLythoshi={
              action === "delegate" && balanceLythoshi !== null
                ? effectiveWeightWholeLythoshi(percentToBps(Number(amountStr)), balanceLythoshi)
                : null
            }
          />
        )}

        {step === "error" && submitError !== null && (
          <ErrorView
            error={submitError}
            onRetry={() => {
              setSubmitError(null);
              // Route the retry to a step that actually renders for the
              // current action. A claim has no "form" step (it never selects
              // a cluster), so re-run it directly; undelegate/redelegate have
              // their own gated form steps; delegate uses "form".
              if (action === "claim") {
                void handleClaim();
                return;
              }
              if (action === "undelegate") {
                setStep("unstake-form");
                return;
              }
              if (action === "redelegate") {
                setStep("redelegate-form");
                return;
              }
              setStep("form");
            }}
            onCancel={onBack}
            {...(onOpenOperators ? { onOpenOperators } : {})}
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
  // Effective delegated weight = balance × totalBps. NON-CUSTODIAL: this is
  // NOT removed from the spendable balance — the full balance stays liquid,
  // the weight is just the contribution to clusters.
  const effectiveWeightLythoshi = effectiveWeightWholeLythoshi(
    stakedBps,
    balanceLythoshi ?? 0n,
  );
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
          label="Spendable balance"
          value={
            balanceLythoshi === null
              ? "—"
              : `${formatLythoshi(balanceLythoshi)} LYTH`
          }
          tone="var(--fg-100)"
        />
        <KvStack
          label="Effective weight"
          value={
            stakedBps === 0 && balanceLythoshi !== null
              ? "0 LYTH"
              : balanceLythoshi === null
                ? "—"
                : `${formatLythoshi(effectiveWeightLythoshi)} LYTH (${(stakedBps / 100).toFixed(2)}%)`
          }
          tone="var(--gold)"
        />
      </div>
      <div
        style={{
          marginTop: 10,
          fontFamily: "var(--f-mono)",
          fontSize: 10,
          color: "var(--fg-300)",
          lineHeight: 1.6,
        }}
      >
        Delegating is non-custodial — your full balance stays liquid and
        spendable. Effective weight tracks your live balance.
      </div>
    </div>
  );
}

interface UnstakeAllCardProps {
  effectiveWeightLythoshi: bigint;
  totalBps: number;
  balanceLythoshi: bigint | null;
  onUnstakeAll: () => void;
}

// Right-hand mini-card mirroring the compact RewardCard: total effective
// weight + an "Unstake all" button that walks every cluster's unstake review
// one at a time (the chain has no bulk undelegate).
function UnstakeAllCard({
  effectiveWeightLythoshi,
  totalBps,
  balanceLythoshi,
  onUnstakeAll,
}: UnstakeAllCardProps) {
  return (
    <div
      className="ext-card"
      style={{ padding: 10, display: "flex", flexDirection: "column" }}
    >
      <div
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 10,
          color: "var(--fg-400)",
          letterSpacing: "0.14em",
          textTransform: "uppercase",
        }}
      >
        Effective weight
      </div>
      <div
        style={{
          marginTop: 6,
          fontFamily: "var(--f-mono)",
          fontSize: 15,
          fontWeight: 600,
          color: "var(--gold)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {balanceLythoshi === null
          ? "—"
          : formatLythoshi(effectiveWeightLythoshi)}{" "}
        <span style={{ fontSize: 9.5, color: "var(--fg-400)" }}>
          LYTH ({(totalBps / 100).toFixed(2)}%)
        </span>
      </div>
      <button
        onClick={onUnstakeAll}
        style={{
          marginTop: 8,
          width: "100%",
          padding: "7px 10px",
          borderRadius: 8,
          border: "1px solid var(--err)",
          background: "rgba(255,255,255,0.03)",
          color: "var(--err)",
          fontFamily: "var(--f-sans)",
          fontSize: 11,
          fontWeight: 600,
          cursor: "pointer",
          transition: "filter 120ms",
        }}
        {...hoverBright}
      >
        Undelegate all
      </button>
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
  /** When set, this preview is one step of the "Unstake all" sequence:
   *  shows a progress header + a Cancel / Skip / Confirm trio (instead of
   *  Back / Confirm) with an inline error/busy state. */
  sequence?: {
    index: number;
    total: number;
    busy: boolean;
    error: string | null;
    onSkip: () => void;
    onCancel: () => void;
  };
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
  sequence,
}: PreviewViewProps) {
  const devMode = useFeature("DEVELOPER_MODE");
  const aprBps = cluster.aprBps ?? null;
  const isUndelegate = action === "undelegate";
  // Undelegate is full-row removal — the chain has no partial unstake, so
  // the "moved" weight is the entire existing delegation regardless of any
  // input. The LYTH shown is the effective weight that row represents at
  // the live balance (nothing is escrowed).
  const fullDelegationLythoshi = effectiveWeightWholeLythoshi(
    existingWeightBps,
    balanceLythoshi ?? 0n,
  );
  // `amountStr` is a percent of balance (0–100) for delegate/redelegate.
  const moveBps = isUndelegate ? existingWeightBps : percentToBps(Number(amountStr));
  // Effective weight this delegation contributes at the current balance.
  const moveLythoshi = effectiveWeightWholeLythoshi(moveBps, balanceLythoshi ?? 0n);
  const totalAfterBps =
    action === "delegate"
      ? existingWeightBps + moveBps
      : Math.max(0, existingWeightBps - moveBps); // source after undelegate/redelegate
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {sequence && (
        <div
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 10,
            color: "var(--fg-300)",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          Undelegate all · cluster {sequence.index + 1} of {sequence.total}
        </div>
      )}
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
          k={isUndelegate ? "Effective weight" : "Delegate"}
          v={
            isUndelegate
              ? `${formatLythoshi(fullDelegationLythoshi)} LYTH (entire delegation)`
              : `${(moveBps / 100).toFixed(2)}% of balance`
          }
          tone="var(--gold)"
        />
        {!isUndelegate && balanceLythoshi !== null && (
          <Row
            k="Effective weight"
            v={`${formatLythoshi(moveLythoshi)} LYTH (stays liquid)`}
          />
        )}
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
          k={action === "redelegate" ? "Cluster redelegation" : action === "undelegate" ? "Undelegate" : "Custody"}
          v={
            action === "redelegate"
              ? "Instant"
              : action === "undelegate"
                ? "Instant (no cooldown)"
                : "Non-custodial (tokens stay in wallet)"
          }
          tone="var(--ok)"
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
          {devMode ? (
            <>
              {action === "delegate" &&
                "Submits `delegate(uint32 cluster, uint16 weightBps)` to the delegation precompile (0x100A) via plaintext mesh_submitTx with value = 0 (non-custodial — no escrow). Your effective weight = balance × weightBps."}
              {action === "undelegate" &&
                "Submits `undelegate(uint32 cluster)` — instantly removes your entire delegation row. No redemption queue or cooldown."}
              {action === "redelegate" &&
                "Submits `redelegate(srcCluster, dstCluster, weightBps)` — instant cluster redelegation, no cooldown."}{" "}
              Monolythium Testnet may reject the call until the gate is activated.
            </>
          ) : (
            <>
              {action === "delegate" &&
                "Delegates a percent of your balance to the cluster. Your LYTH stays in your wallet and remains spendable — nothing is locked. "}
              {action === "undelegate" &&
                "Removes your delegation instantly. Your tokens were never locked, so there is nothing to wait for. "}
              {action === "redelegate" &&
                "Moves your delegation to another cluster instantly. "}
              Monolythium Testnet may reject this until delegation is enabled.
            </>
          )}
        </div>
      </div>

      {sequence ? (
        <>
          {sequence.error !== null && (
            <div
              style={{
                fontFamily: "var(--f-mono)",
                fontSize: 10,
                color: "var(--err)",
                lineHeight: 1.5,
                wordBreak: "break-word",
              }}
            >
              {sequence.error}
            </div>
          )}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1.3fr",
              gap: 8,
            }}
          >
            <button
              onClick={sequence.onCancel}
              disabled={sequence.busy}
              style={{ ...secondaryBtn, opacity: sequence.busy ? 0.6 : 1 }}
              {...hoverBg("rgba(255,255,255,0.04)")}
            >
              Cancel
            </button>
            <button
              onClick={sequence.onSkip}
              disabled={sequence.busy}
              style={{ ...secondaryBtn, opacity: sequence.busy ? 0.6 : 1 }}
              {...hoverBg("rgba(255,255,255,0.04)")}
            >
              Skip
            </button>
            <button
              className="ext-act prim-soft"
              onClick={onConfirm}
              disabled={sequence.busy}
              style={{
                padding: 12,
                flexDirection: "row",
                justifyContent: "center",
                gap: 6,
                opacity: sequence.busy ? 0.6 : 1,
                cursor: sequence.busy ? "default" : "pointer",
              }}
            >
              {sequence.busy ? (
                "Submitting…"
              ) : (
                <>
                  <Icon name="check" size={12} /> Undelegate
                </>
              )}
            </button>
          </div>
          <div
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 11,
              color: "var(--fg-400)",
              lineHeight: 1.7,
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            <div>
              <strong style={{ color: "var(--err)" }}>Undelegate</strong> removes
              this cluster, then continues.
            </div>
            <div>
              <strong style={{ color: "var(--fg-300)" }}>Skip</strong> keeps it
              delegated and moves on.
            </div>
            <div>
              <strong style={{ color: "var(--fg-300)" }}>Cancel</strong> stops
              here.
            </div>
          </div>
        </>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 8,
          }}
        >
          <button
            onClick={onBack}
            style={secondaryBtn}
            {...hoverBg("rgba(255,255,255,0.04)")}
          >
            Back
          </button>
          <button
            className="ext-act prim-soft"
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
      )}
    </div>
  );
}

function SubmittingView() {
  const devMode = useFeature("DEVELOPER_MODE");
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
        {devMode
          ? "mesh_submitTx → cluster → admission gate"
          : "Broadcasting to the network…"}
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
  /** Cluster display label (directory name, or `cluster-<id>` fallback). */
  clusterLabel: string | null;
  /** Numeric cluster id (clusters are id-indexed; no per-cluster address). */
  clusterId: number | null;
  /** The delegator's own wallet raw 0x address. */
  walletAddr0x: string;
  /** Delegated amount for the delegate action; null for claim/undelegate/redelegate. */
  amountLythoshi: bigint | null;
}

/** One receipt row: uppercase mono label + right-aligned value node. */
function ReceiptRow({ label, value }: { label: string; value: ReactNode }) {
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
          fontSize: 11,
          color: "var(--fg-100)",
          textAlign: "right",
          wordBreak: "break-all",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function SuccessView({
  action,
  txHash,
  copied,
  onCopy,
  onDone,
  clusterLabel,
  clusterId,
  walletAddr0x,
  amountLythoshi,
}: SuccessViewProps) {
  const title =
    action === "claim"
      ? "Claim submitted"
      : action === "undelegate"
        ? "Undelegate submitted"
        : action === "redelegate"
          ? "Cluster redelegation submitted"
          : "Delegation submitted";
  const walletBech = bech32mDisplay(walletAddr0x);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div
        style={{
          padding: "40px 20px 12px",
          textAlign: "center",
          color: "var(--warn)",
        }}
      >
        <Icon name="clock" size={40} />
        <div
          style={{
            marginTop: 16,
            fontSize: 13.5,
            fontWeight: 600,
            color: "var(--fg-100)",
          }}
        >
          {title}
        </div>
        <div
          style={{
            marginTop: 6,
            fontFamily: "var(--f-mono)",
            fontSize: 11,
            color: "var(--fg-400)",
            lineHeight: 1.5,
          }}
        >
          Waiting for on-chain confirmation — track it in Activity.
        </div>
      </div>
      <div className="ext-card" style={{ padding: 12 }}>
        {/* Hash (top) — clickable to the Monoscan tx page + address-style copy. */}
        <div
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 9.5,
            color: "var(--fg-500)",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            marginBottom: 6,
          }}
        >
          Transaction hash
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 10px",
            borderRadius: 8,
            background: "rgba(0,0,0,0.25)",
            border: "1px solid var(--fg-700)",
          }}
        >
          <ExternalLink
            href={monoscanTxUrl(txHash)}
            title="View transaction on Monoscan"
            style={{
              flex: 1,
              fontFamily: "var(--f-mono)",
              fontSize: 10.5,
            }}
          >
            {txHash}
          </ExternalLink>
          <button
            onClick={onCopy}
            aria-label="Copy transaction hash"
            {...hoverBg("transparent")}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 22,
              height: 22,
              padding: 0,
              background: "transparent",
              border: "none",
              color: copied ? "var(--ok, #5fc97a)" : "var(--fg-400)",
              cursor: "pointer",
              flexShrink: 0,
              borderRadius: 6,
              transition: "background 120ms",
            }}
          >
            {copied ? <CheckIcon /> : <ClipboardIcon />}
          </button>
        </div>

        <div style={{ marginTop: 8 }}>
          {/* Cluster — id-indexed; the directory carries no bech32m address,
              so there is no honest Monoscan cluster link (no-mock). */}
          <ReceiptRow
            label="Cluster"
            value={
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-end",
                  gap: 2,
                }}
              >
                <span style={{ color: "var(--fg-100)", fontFamily: "var(--f-sans)", fontWeight: 600 }}>
                  {clusterLabel ?? (clusterId !== null ? `cluster-${clusterId}` : "—")}
                </span>
                {clusterId !== null && (
                  <span style={{ color: "var(--fg-500)" }}>cluster #{clusterId}</span>
                )}
              </div>
            }
          />
          <ReceiptRow
            label="Delegator"
            value={
              <ExternalLink
                href={monoscanAddressUrl(walletBech)}
                title="View address on Monoscan"
              >
                {walletBech}
              </ExternalLink>
            }
          />
          {amountLythoshi !== null && (
            <ReceiptRow label="Amount" value={formatNativeLythAmount(amountLythoshi)} />
          )}
        </div>
      </div>
      <a
        href={monoscanTxUrl(txHash)}
        target="_blank"
        rel="noopener noreferrer"
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "rgba(255,255,255,0.09)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "rgba(255,255,255,0.04)";
        }}
        style={{
          ...secondaryBtn,
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
      <button onClick={onDone} className="ext-act prim-soft" style={{ padding: 12 }}>
        Done
      </button>
    </div>
  );
}

/** Render the genesis-mismatch error body with the trailing "Operators"
 *  word as a button that opens the operator directory. Falls back to the
 *  plain string when the marker is absent. Mirrors Send's treatment so the
 *  stake-flow genesis error is consistent. Display/nav only. */
function genesisErrorBody(body: string, onOpenOperators: () => void) {
  const marker = "Operators";
  const i = body.lastIndexOf(marker);
  if (i < 0) return body;
  return (
    <>
      {body.slice(0, i)}
      <button
        type="button"
        onClick={onOpenOperators}
        {...hoverBright}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 3,
          background: "none",
          border: "none",
          padding: 0,
          font: "inherit",
          color: "var(--gold)",
          textDecoration: "underline",
          cursor: "pointer",
          transition: "filter 120ms",
        }}
      >
        {marker}
        <Icon name="external" size={11} />
      </button>
      {body.slice(i + marker.length)}
    </>
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
  /** When set and the error classifies as genesis-mismatch, the body's
   *  "Operators" word becomes a button opening the operator directory. */
  onOpenOperators?: () => void;
}

function ErrorView({
  error,
  onRetry,
  onCancel,
  onOpenOperators,
}: ErrorViewProps) {
  const classified = classifySendError(error.message);
  // S6 INFO #9: tint the error surface from classified.severity (shared with
  // Send.tsx) so a warn-severity transient (e.g. spending-policy-unavailable)
  // renders amber, not error-red.
  const colours = severityColours(classified.severity);
  const devMode = useFeature("DEVELOPER_MODE");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div
        style={{
          padding: "40px 20px",
          textAlign: "center",
          color: colours.fg,
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
          background: colours.cardBg,
          border: `1px solid ${colours.borderRgba}`,
        }}
      >
        <div
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 11,
            color: colours.fg,
            wordBreak: "break-word",
            lineHeight: 1.5,
          }}
        >
          {errorLinksOperators(classified.kind) && onOpenOperators
            ? genesisErrorBody(classified.body, onOpenOperators)
            : classified.body}
        </div>
        {/* Raw error detail (message + code/method/via) is developer-only
            noise; the plain classified body above is what all users see. */}
        {devMode && (
          <div
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 9.5,
              color: "var(--fg-500)",
              marginTop: 8,
              wordBreak: "break-word",
              lineHeight: 1.5,
            }}
          >
            {error.message}
            {(error.code !== null ||
              error.method !== null ||
              error.via !== null) && (
              <div style={{ marginTop: 6 }}>
                {error.code !== null && <>code {error.code} · </>}
                {error.method !== null && <>{error.method} · </>}
                {error.via !== null && <>via {error.via}</>}
              </div>
            )}
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
        <button
          onClick={onCancel}
          style={secondaryBtn}
          {...hoverBg("rgba(255,255,255,0.04)")}
        >
          Cancel
        </button>
        <button onClick={onRetry} className="ext-act prim-soft" style={{ padding: 12 }}>
          Retry
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers + styles
// ─────────────────────────────────────────────────────────────────────────────

/**
 * F-3.8 / #25 — resolve the per-cluster delegation cap (bps) for DISPLAY from a
 * `staking-delegation-cap` read, honoring the no-mock-fallback principle. A
 * `via:"mock"` result (chain offline) carries a fabricated §23.6 launch cap
 * (5000 bps = 50%); rendering that as a real percentage is forbidden, so a
 * non-live read yields `null` — the cap badge is hidden (StakeForm /
 * RedelegateForm already gate on `capBps !== null`) and the 0x100A delegation
 * precompile still enforces the true cap chain-side. Only a live read sets a
 * concrete cap. (Mirrors the existing `via === "mock"` idiom used for the
 * rewards / redemption-queue mock flags.)
 */
export function capBpsFromCapResult(capR: {
  ok: boolean;
  via?: string | null;
  data?: { capBps: number | null };
}): number | null {
  if (!capR.ok || capR.via === "mock") return null;
  // capBps === null is the legitimate "cap disabled (u32::MAX)" state; either
  // way a non-concrete cap collapses to null (badge hidden / unlimited).
  return capR.data?.capBps ?? null;
}

/** Notification weight for an undelegate. The op encodes no bps (it removes the
 *  full row), so the toast's "%" is the cluster's existing weight. The on-mount
 *  delegations cache can be stale (e.g. after an in-session delegate), making the
 *  read 0; return `undefined`, NOT 0, so the toast shows the cluster name without
 *  a misleading "0%" (and never the raw delegation precompile address). */
export function undelegateNotificationWeightBps(
  existingWeightBps: number,
): number | undefined {
  return existingWeightBps > 0 ? existingWeightBps : undefined;
}

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

/** Convert an autovote allocation row into the percent-of-balance string
 *  the StakeForm + preview expect (weightBps → percent). */
export function allocationToPercentStr(alloc: AutovoteAllocation): string {
  if (alloc.weightBps <= 0) return "0";
  return (alloc.weightBps / 100).toString();
}

// ─────────────────────────────────────────────────────────────────────────────
// ExistingDelegations — per-cluster active stake with Unstake / Redelegate
// ─────────────────────────────────────────────────────────────────────────────

interface ExistingDelegationsProps {
  delegations: DelegationsView;
  clusters: ReadonlyArray<ClusterDirectoryEntry>;
  balanceLythoshi: bigint | null;
  onStake: (clusterId: number) => void;
  onUnstake: (clusterId: number) => void;
  onRedelegate: (clusterId: number) => void;
}

function ExistingDelegations({
  delegations,
  clusters,
  balanceLythoshi,
  onStake,
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
            fontSize: 10,
            color: "var(--fg-400)",
            letterSpacing: "0.06em",
            textTransform: "none",
          }}
        >
          {delegations.rows.length} cluster
          {delegations.rows.length === 1 ? "" : "s"} ·{" "}
          <strong style={{ color: "var(--gold)" }}>
            {(delegations.totalBps / 100).toFixed(2)}% total
          </strong>
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
                  alignItems: "baseline",
                  gap: 8,
                  marginBottom: 8,
                }}
              >
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: "var(--fg-100)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    minWidth: 0,
                  }}
                >
                  {c?.name ?? `cluster-${row.cluster}`}
                </span>
                <span
                  style={{
                    marginLeft: "auto",
                    flexShrink: 0,
                    fontFamily: "var(--f-mono)",
                    fontSize: 12,
                    color: "var(--fg-100)",
                  }}
                >
                  <strong style={{ color: "var(--gold)" }}>
                    {(row.weightBps / 100).toFixed(2)}%
                  </strong>
                  {amountLythoshi !== null && (
                    <>
                      {" "}
                      ·{" "}
                      <strong style={{ color: "var(--fg-100)" }}>
                        {formatLythoshi(amountLythoshi)} LYTH
                      </strong>
                    </>
                  )}
                </span>
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr 1fr",
                  gap: 6,
                }}
              >
                <button
                  onClick={() => onStake(row.cluster)}
                  style={stakeMoreBtnStyle}
                  {...hoverBright}
                >
                  Delegate
                </button>
                <button
                  onClick={() => onRedelegate(row.cluster)}
                  style={redelegateBtnStyle}
                  {...hoverBright}
                >
                  Redelegate
                </button>
                <button
                  onClick={() => onUnstake(row.cluster)}
                  style={unstakeBtnStyle}
                  {...hoverBright}
                >
                  Undelegate
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Per-row delegation actions, semantically coloured (all theme tokens that
// re-theme): Stake = green (add), Redelegate = gold/accent (move), Unstake =
// red (remove).
const delegationActionBtnBase: CSSProperties = {
  padding: "6px 8px",
  borderRadius: 6,
  background: "rgba(255,255,255,0.03)",
  fontFamily: "var(--f-mono)",
  fontSize: 10,
  cursor: "pointer",
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  transition: "filter 120ms",
};

const stakeMoreBtnStyle: CSSProperties = {
  ...delegationActionBtnBase,
  border: "1px solid var(--ok)",
  color: "var(--ok)",
};

const redelegateBtnStyle: CSSProperties = {
  ...delegationActionBtnBase,
  border: "1px solid var(--gold)",
  background: "var(--gold-bg)",
  color: "var(--gold)",
};

const unstakeBtnStyle: CSSProperties = {
  ...delegationActionBtnBase,
  border: "1px solid var(--err)",
  color: "var(--err)",
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
          {...hoverBright}
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
          {...hoverBright}
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
            background: "rgba(var(--warn-glow), 0.08)",
            border: "1px solid rgba(var(--warn-glow), 0.4)",
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
            className="ext-act prim-soft"
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
  transition: "background 120ms",
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
