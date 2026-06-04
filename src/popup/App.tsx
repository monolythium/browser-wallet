// Monolythium Wallet popup — screen orchestrator.
//
// Two ways the popup is shown:
//
//   1. user clicks the toolbar action -> default popup -> onboarding/lock/home
//   2. background spawned an approval window via chrome.windows.create with
//      `?approval=<id>` in the URL -> we show the matching ReqConnect /
//      ReqSendTx / ReqPersonalSignReal / ReqTypedSign / ReqAddChain and post
//      the user's decision back through the chrome.runtime channel.
//
// The keystore lives entirely in the service worker. The popup never sees
// the private key — it only sends the password during unlock and reads back
// boolean/address state through `popup` IPC messages.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  SESSION_KEY_WALLET_LOCKED,
  STORAGE_KEY_VAULTS_CONTAINER_V4,
} from "../shared/constants";
import { hexLythoshiToLythNumber } from "../shared/native-amount";
import {
  activityPendingKey,
  validatePendingActivityCache,
} from "../shared/activity";
import {
  CWS_LISTING_URL,
  STORAGE_KEY_WALLET_UPDATE,
  shouldCheckWalletUpdate,
  nextUpdateAvailable,
  parseWalletUpdateCache,
  requestWalletUpdateStatus,
} from "../shared/wallet-update";
import "./tokens.css";
import "./themes.css";
import "./glass.css";
import "./ext.css";
import {
  Home, Accounts, Networks, Bridge,
  ReqConnect,
  ReqSheet, ChainStatusBanner,
  ReqSendTx, ReqPersonalSignReal, ReqTypedSign, ReqAddChain,
} from "./components";
import { Receive } from "./pages/Receive";
import { Send } from "./pages/Send";
import { Settings } from "./pages/Settings";
import { Security } from "./pages/Security";
import { Features } from "./pages/Features";
import { Theme } from "./pages/Theme";
import { UnifiedOnboardingHintBar } from "./components/UnifiedOnboardingHintBar";
import { SetupHealthChip } from "./components/SetupHealthChip";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Stake, clearStakeState } from "./pages/Stake";
import { AgentPolicy } from "./pages/AgentPolicy";
import { Delegations } from "./pages/Delegations";
import { ClusterDetail } from "./pages/ClusterDetail";
import { NetworkDetail } from "./pages/NetworkDetail";
import { AddCustomChain } from "./pages/AddCustomChain";
import { EditChain } from "./pages/EditChain";
import { Operators } from "./pages/Operators";
import { NotificationSettings } from "./pages/NotificationSettings";
import { About } from "./pages/About";
import { Welcome } from "./pages/Welcome";
import { SetPassword } from "./pages/SetPassword";
import { ShowPhrase } from "./pages/ShowPhrase";
import { VerifyPhrase } from "./pages/VerifyPhrase";
import { ImportWallet } from "./pages/ImportWallet";
import { UnlockScreen } from "./pages/UnlockScreen";
import { RevealPhrase } from "./pages/RevealPhrase";
import { ResetWallet } from "./pages/ResetWallet";
import { ConnectedSites } from "./pages/ConnectedSites";
import { ForgotPassword } from "./pages/ForgotPassword";
import { MrvNative } from "./pages/MrvNative";
import { Pending as MultisigPending } from "./pages/Pending";
import { MultisigGovernance } from "./components/MultisigGovernance";
import { MainMenu } from "./pages/MainMenu";
import { Notifications } from "./pages/Notifications";
import { NewWalletFlow } from "./pages/NewWalletFlow";
import { generateOnboardingMnemonic } from "./lib/onboarding-mnemonic";
import { explainImportError } from "./lib/import-error";
import { Contacts } from "./pages/Contacts";
import { MultisigList } from "./pages/MultisigList";
import { useFeature } from "./hooks/useFeature";
import { ACCOUNTS, type Account } from "./demo-data";
import {
  bgListPending,
  bgKeystoreStatus,
  bgKeystoreLock,
  bgPing,
  bgKeystoreCreateFromMnemonic,
  bgResolveApproval,
  bgVaultsList,
  bgWalletActiveAccount,
  bgWalletBalance,
  bgWalletActivityGet,
  bgWalletIndexerSnapshot,
  bgWalletActiveChain,
  bgWalletSetActiveChain,
  bgChainList,
  bgPolicyChainList,
  bgGetUiOpenMode,
  bgGetUnread,
  bgSetUiOpenMode,
  type UiOpenMode,
  type VaultSummary,
  type PendingApproval,
  type KeystoreStatus,
  type ConnectRequest,
  type SendTxRequest,
  type PersonalSignRequest,
  type TypedSignRequest,
  type AddChainRequest,
  type ChainEntry,
  type PolicyChainEntry,
  type WalletIndexerSnapshot,
} from "./bg";

type Screen =
  | "loading"
  | "welcome"
  | "set-password-create"
  | "show-phrase"
  | "verify-phrase"
  | "import"
  | "set-password-import"
  | "forgot-password"
  | "locked"
  | "home"
  | "accounts"
  | "networks"
  | "network-detail"
  | "network-add"
  | "network-edit"
  | "settings"
  | "operators"
  | "notification-settings"
  | "about"
  | "reveal-phrase"
  | "reset-wallet"
  | "receive"
  | "send"
  | "stake"
  | "agent-policy"
  | "delegations"
  | "cluster-detail"
  | "bridge"
  | "mrv-native"
  | "approval"
  | "connected-sites"
  | "multisig-pending"
  | "multisig-governance"
  | "multisig-list"
  | "security"
  | "features"
  | "theme"
  | "main-menu"
  | "contacts"
  | "new-wallet-flow"
  | "notifications";

// Screens where a SW-pushed walletLocked=true signal should NOT kick the
// user back to the Unlock screen. Onboarding flows are protected because
// kicking off them mid-flow would lose the recovery phrase display or the
// user's typed mnemonic. forgot-password and reset-wallet are protected for
// the same reason — a user mid-reset must not be redirected to Unlock.
// reveal-phrase is intentionally NOT exempt: a lock signal mid-reveal
// correctly forces re-auth before the seed can be re-displayed.
const LOCK_SIGNAL_EXEMPT: ReadonlySet<Screen> = new Set<Screen>([
  "approval",
  "loading",
  "welcome",
  "set-password-create",
  "show-phrase",
  "verify-phrase",
  "import",
  "set-password-import",
  "forgot-password",
  "reset-wallet",
]);

interface UiApproval {
  approval: PendingApproval;
}

/**
 * Sprintnet fallback used during the bootstrap window before the first
 * chain-list IPC fetch resolves, and as the safety net if the persisted
 * active chain id points at a chain that's no longer in the registry
 * (e.g. user removed a custom chain). Shape mirrors what the service
 * worker returns from `chain-list` so the popup never has to special-
 * case the bootstrap state.
 */
const SPRINTNET_FALLBACK: ChainEntry = {
  chainId: "0x10F2C",
  chainIdNum: 69420,
  name: "Monolythium Testnet",
  // Bootstrap-window rpc. Mirrors SPRINTNET_OPERATOR_RPCS_DEFAULTS[0] in
  // src/background/networks.ts so a fresh-install's first paint targets a
  // live endpoint. Points at operator-2 after the regenesis in which
  // operator-1's bls.key was destroyed; see networks.ts docstring.
  rpc: "http://192.0.2.1:8545",
  builtin: true,
  official: true,
  active: true,
  nativeCurrency: { name: "Monolythium LYTH", symbol: "LYTH", decimals: 18 },
};

/** While a broadcast tx is still pending, reconcile this often (ms). The chain
 *  produces BLS fast blocks well under a second, so a tx is typically included
 *  within ~1s; poll at 1.5s so a confirm surfaces near the chain's real speed.
 *  This poll lives at the App level (not the Activity tab) so it runs on EVERY
 *  screen while the popup is open — a tx sent from Send/Home flips without
 *  waiting for a tab change or the 30s background alarm. The SW only does the
 *  heavy reconcile when a pending row exists, so each tick is cheap otherwise. */
const PENDING_REPOLL_MS = 1_500;

export default function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  // v5 pillar surfaces (agent spending-policy page) ship behind the
  // default-off "Agent commerce (experimental)" two-tier toggle. When
  // OFF the nav entry is hidden and the page is never mounted, so the
  // popup matches the pre-v5 experience exactly. Flip on via Settings →
  // Features.
  const agentCommerceEnabled = useFeature("AGENT_COMMERCE");
  // Current UI open mode (popup vs sidepanel). The
  // MainMenu's "Switch to ..." item reads this to label the toggle as
  // the OPPOSITE option. null while the SW IPC is in flight; modes
  // settle after the first bgGetUiOpenMode resolves.
  const [uiMode, setUiMode] = useState<UiOpenMode | null>(null);
  useEffect(() => {
    let cancelled = false;
    void bgGetUiOpenMode().then((r) => {
      if (cancelled) return;
      if (r.ok) setUiMode(r.mode);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Wallet-version update check vs the Chrome Web Store. Rate-limited
  // to ~2×/day via a cached lastCheckAt; reflects the last-known verdict
  // immediately, then refreshes via chrome.runtime.requestUpdateCheck.
  // Honest-absence: dev/unpacked or throttled → no banner.
  const [walletUpdateAvailable, setWalletUpdateAvailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const now = Date.now();
      const stored = await new Promise<unknown>((resolve) => {
        chrome.storage.local.get([STORAGE_KEY_WALLET_UPDATE], (res) =>
          resolve(res?.[STORAGE_KEY_WALLET_UPDATE]),
        );
      });
      if (cancelled) return;
      const cache = parseWalletUpdateCache(stored);
      const prior = cache?.updateAvailable ?? false;
      if (prior) setWalletUpdateAvailable(true);
      if (!shouldCheckWalletUpdate(cache?.lastCheckAt ?? null, now)) return;
      const status = await requestWalletUpdateStatus();
      if (cancelled) return;
      const updateAvailable = nextUpdateAvailable(status, prior);
      setWalletUpdateAvailable(updateAvailable);
      chrome.storage.local.set({
        [STORAGE_KEY_WALLET_UPDATE]: {
          lastCheckAt: now,
          updateAvailable,
          lastStatus: status,
        },
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome.runtime?.onUpdateAvailable) {
      return;
    }
    const onUpd = () => {
      setWalletUpdateAvailable(true);
      chrome.storage.local.set({
        [STORAGE_KEY_WALLET_UPDATE]: {
          lastCheckAt: Date.now(),
          updateAvailable: true,
          lastStatus: "update_available",
        },
      });
    };
    chrome.runtime.onUpdateAvailable.addListener(onUpd);
    return () => chrome.runtime.onUpdateAvailable.removeListener(onUpd);
  }, []);
  // Back-navigation stack. When user navigates via the
  // hamburger menu (main-menu → contacts), back from contacts should
  // return to main-menu, not home. Sub-screens entered from the home
  // top-bar or home tiles push their own predecessor (usually "home")
  // before changing screen, then read+pop on back. Stack is bounded
  // to ~8 entries; deeper navigation drops the oldest entry. Read-side
  // of the state isn't referenced directly (peek happens inside the
  // setStack callback in navigateBack); useRef would also work but
  // useState keeps the same hook shape for future inspection.
  const [, setScreenStack] = useState<Screen[]>([]);
  const navigateTo = useCallback((target: Screen) => {
    setScreenStack((prev) => {
      const next = [...prev, screen];
      return next.length > 8 ? next.slice(-8) : next;
    });
    setScreen(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);
  const navigateBack = useCallback(() => {
    setScreenStack((prev) => {
      const last = prev[prev.length - 1] ?? "home";
      setScreen(last);
      return prev.slice(0, -1);
    });
  }, []);
  const [keystore, setKeystore] = useState<KeystoreStatus | null>(null);
  const [activeApproval, setActiveApproval] = useState<UiApproval | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  // SECURITY: `generated` holds the in-flight first-setup
  // mnemonic ONLY in popup React memory until verify-phrase succeeds.
  // Previously the vault container was persisted at the Set Password
  // step (via bgKeystoreCreateNew), so closing the popup between
  // Show Phrase and Verify Phrase bypassed verification entirely —
  // next open landed on home with an unverified wallet. Now nothing
  // touches chrome.storage until `handleVerifyComplete` commits, so
  // popup-close at any pre-verify step leaves storage empty and the
  // next open routes back to Welcome. `address` is no longer carried
  // here because it's derived only at commit time. The state is
  // bound to the popup process lifetime; an SW restart can't corrupt
  // it (the SW has no copy until commit).
  const [generated, setGenerated] = useState<{ mnemonic: string } | null>(null);
  // SECURITY: first-setup password held in React state from
  // Set Password submit through Verify Phrase success. Cleared on
  // commit, on Welcome bounce-out, and on any abort path. NEVER
  // written to chrome.storage; the password hash + MEK derivation
  // happens server-side inside bgKeystoreCreateFromMnemonic at the
  // atomic commit step.
  const [pendingFirstSetupPassword, setPendingFirstSetupPassword] =
    useState<string | null>(null);
  // Captured by ImportWallet's onSubmit, consumed by SetPassword (import branch).
  // Cleared after successful vault creation or when the user backs out.
  const [pendingMnemonic, setPendingMnemonic] = useState<string | null>(null);

  const initialAccount: Account = ACCOUNTS[0]!;
  const [acc, setAcc] = useState<Account>(initialAccount);
  const [indexerSnapshot, setIndexerSnapshot] = useState<WalletIndexerSnapshot | null>(null);
  // Active-chain state. The service worker is the source of truth
  // (`mono.chain.active` in chrome.storage); we mirror it locally so
  // the balance/fee hooks can dep on it. `activeChain` falls back to
  // the Sprintnet shape during the bootstrap window before the first
  // chain-list fetch resolves AND when a stored active id points at a
  // now-deleted user-added chain.
  const [activeChainId, setActiveChainId] = useState<string>(SPRINTNET_FALLBACK.chainId);
  const [chainList, setChainList] = useState<ChainEntry[]>([]);
  const [policyChainList, setPolicyChainList] = useState<PolicyChainEntry[]>([]);
  const activeChain: ChainEntry =
    chainList.find((c) => c.chainId === activeChainId) ?? SPRINTNET_FALLBACK;
  // Currently-viewed chain on NetworkDetail / EditChain. Set when the user
  // taps a row on the Networks list; cleared when they back out.
  const [selectedChainId, setSelectedChainId] = useState<string | null>(null);
  // Delegations → Stake deeplink. When a Delegations-page
  // "Unstake" / "Redelegate" CTA fires, App stores the action + the
  // source cluster so the Stake page can land directly on the form.
  // Cleared on Stake → home navigation.
  const [stakeDeepLink, setStakeDeepLink] = useState<{
    action: "undelegate" | "redelegate";
    clusterId: number;
  } | null>(null);
  // Selected cluster for the cluster-detail panel.
  // Set when the user navigates from ClusterPicker or Delegations row
  // → cluster detail. The cluster directory row is held inline rather
  // than re-fetched: it's already in the parent's state from the
  // staking-cluster-directory call that populated the picker.
  const [selectedCluster, setSelectedCluster] = useState<
    import("../shared/staking").ClusterDirectoryEntry | null
  >(null);
  // Track which screen opened ClusterDetail so the back button
  // returns the user to the originating page (Stake or Delegations),
  // not a hardcoded default. Cleared on unmount of cluster-detail.
  const [clusterDetailEntrySource, setClusterDetailEntrySource] =
    useState<"stake" | "delegations" | null>(null);
  const selectedChain: ChainEntry | null =
    selectedChainId !== null
      ? (chainList.find((c) => c.chainId === selectedChainId) ?? null)
      : null;

  const loadChainState = async () => {
    const [activeRes, list, policyList] = await Promise.all([
      bgWalletActiveChain(),
      bgChainList(),
      bgPolicyChainList(),
    ]);
    setChainList(list);
    setPolicyChainList(policyList);
    if (activeRes.ok) setActiveChainId(activeRes.chainId);
  };

  // Fetch the unlocked v3 keypair and patch `acc` with its real EVM
  // address + algo. Demo data stays as the fallback shape; only the
  // identity-bearing fields are overridden so Home keeps rendering the
  // same component without a rewrite. The chip's visible label comes
  // from the active vault's `label` (via bgVaultsList → VaultPicker);
  // we deliberately do NOT override `acc.label` here — a prior override
  // ("ML-DSA-65 wallet") leaked through VaultPicker's fallback during
  // the pre-fetch tick and showed up as the apparent wallet name on
  // fresh installs.
  const loadActiveAccount = async () => {
    const r = await bgWalletActiveAccount();
    if (!r.ok) return;
    setAcc((prev) => ({
      ...prev,
      id: "v3-active",
      addr: r.account.address,
      algo: r.account.algo === "mldsa" ? "mldsa" : "slhdsa",
      custody: r.account.custody,
      denom: "public",
      // Preserve the last-known balance on a SAME-address refresh (refocus,
      // SW-restart, vault-flow re-hydrate) so Home doesn't flash "0.00" while
      // refreshBalance re-fetches — the prior value is still the real balance.
      // Only clear to null on an actual account SWITCH, where the prior
      // balance belongs to a different address and would be wrong to show.
      // (Never a synthesized 0 — refreshBalance repopulates the real value.)
      balance:
        r.account.address.toLowerCase() === prev.addr.toLowerCase()
          ? prev.balance
          : null,
      pinned: true,
    }));
  };

  // Track the active vault summary so we can detect when
  // the user is "on" a multisig vault (Send must propose, Settings
  // surfaces multisig section, Home pill renders M-of-N · K pending).
  const [activeVaultSummary, setActiveVaultSummary] =
    useState<VaultSummary | null>(null);
  const loadActiveVaultSummary = async () => {
    const r = await bgVaultsList();
    if (!r.ok) {
      setActiveVaultSummary(null);
      return;
    }
    const active = (r.vaults ?? []).find((v) => v.isActive);
    setActiveVaultSummary(active ?? null);
  };

  // Re-fetch keystore status + dependent identity/chain state. Used by the
  // mount bootstrap, the unlock/create flows, and the SW-pushed lock signal.
  // Empty deps deliberately — this captures the first-render closures and
  // the underlying setters/imports are stable across renders.
  const refreshKeystoreStatus = useCallback(async () => {
    const ks = await bgKeystoreStatus();
    setKeystore(ks);
    if (ks.algo === "mldsa") {
      await loadActiveAccount();
      await loadActiveVaultSummary();
    }
    await loadChainState();
    return ks;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Balance refresh. Reads from `activeChain.chainId`, which the service
  // worker resolves from chrome.storage (`mono.chain.active`) and falls back
  // to Sprintnet on first launch. The token ref discards stale fetches so a
  // slow result for a previous account/chain can't overwrite the current
  // balance — needed because refreshBalance is also called from event-driven
  // handlers (visibilitychange, screen-change-to-home) that don't have the
  // useEffect cleanup story to lean on.
  const balanceTokenRef = useRef(0);
  const refreshBalance = useCallback(async () => {
    if (!acc.addr.startsWith("0x")) return;
    const myToken = ++balanceTokenRef.current;
    const r = await bgWalletBalance(acc.addr, activeChain.chainId);
    if (myToken !== balanceTokenRef.current) return;
    if (!r.ok) {
      // Leave the existing balance in place; Home renders "0.00" when
      // null which is acceptable until we surface a load error.
      return;
    }
    try {
      const lyth = hexLythoshiToLythNumber(r.balanceHex);
      if (lyth === null) return;
      setAcc((prev) => ({ ...prev, balance: lyth }));
    } catch {
      // Malformed hex — ignore, balance stays null.
    }
  }, [acc.addr, activeChain.chainId]);

  // Activity refresh trigger. Verbatim mirror of the
  // balance pattern above. The actual cache state lives inside
  // useActivity (src/popup/hooks/useActivity.ts) which is mounted by
  // the Activity tab body. This callback fires bgWalletActivityGet
  // directly; the SW writes the result to chrome.storage, and the
  // hook's onChanged listener picks up the write and re-renders.
  // No prop drilling needed.
  const activityTokenRef = useRef(0);
  const refreshActivity = useCallback(async () => {
    if (!acc.addr.startsWith("0x")) return;
    const myToken = ++activityTokenRef.current;
    const r = await bgWalletActivityGet(acc.addr, activeChain.chainId);
    if (myToken !== activityTokenRef.current) return;
    // No local state to write — the SW persisted the cache to
    // chrome.storage on success, and the hook's storage listener
    // dispatches the result. On failure the hook surfaces an error
    // state of its own.
    void r;
  }, [acc.addr, activeChain.chainId]);

  // Wake the SW out of MV3 idle BEFORE any real call
  // goes out. Without this, the first `bgKeystoreStatus()` below
  // (and the picker / chain banner mounts that follow) sometimes
  // race the SW boot and surface as "Unchecked runtime.lastError:
  // No SW receiving end" in the console. Fire-and-forget; the
  // followup calls also retry once on the same error class.
  useEffect(() => {
    void bgPing();
  }, []);

  // Drive the top-bar bell's small unread dot. The dot
  // mirrors the global unread count (same source as the toolbar
  // badge and the MainMenu pill). We fetch on mount + subscribe
  // to `chrome.storage.onChanged` for any `mono.notifications.history.*`
  // write so the dot updates in real time as new records land, the
  // user marks one read, or "Mark all as read" fires — no polling tick.
  const [bannerUnread, setBannerUnread] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const r = await bgGetUnread();
      if (cancelled) return;
      setBannerUnread(r.ok ? r.count : 0);
    };
    void refresh();
    const listener: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (
      changes,
      area,
    ) => {
      if (area !== "local") return;
      if (
        Object.keys(changes).some((k) =>
          k.startsWith("mono.notifications.history."),
        )
      ) {
        void refresh();
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, []);

  // ---- mount-time bootstrap ----
  useEffect(() => {
    void (async () => {
      const url = new URL(window.location.href);
      const approvalId = url.searchParams.get("approval");
      if (approvalId) {
        // Approval window: just hydrate keystore (so the unlock prompt
        // can render correctly) and route to the approval screen.
        const ks = await bgKeystoreStatus();
        setKeystore(ks);
        const list = await bgListPending();
        const found = list.find((p) => p.id === approvalId);
        if (found) {
          setActiveApproval({ approval: found });
          setScreen("approval");
          return;
        }
        // Pending approval already resolved or vanished — close the window.
        window.close();
        return;
      }

      const ks = await refreshKeystoreStatus();
      if (!ks.hasVault) {
        setScreen("welcome");
      } else if (!ks.unlocked) {
        setScreen("locked");
      } else {
        setScreen("home");
      }
    })();
  }, [refreshKeystoreStatus]);

  // SW-pushed lock/unlock signal — chrome.storage.session.walletLocked is
  // the authoritative cross-context flag. The SW writes `true` when it
  // auto-locks (alarm fired) or any code path explicitly locks, and `false`
  // immediately after a successful unlock (resetAutoLock in service-worker.ts).
  // Both directions must be handled here so the popup's `keystore` state
  // and `screen` stay in sync without depending on a fresh mount:
  //   - lock  (newValue=true):  refresh + force "locked" except for exempt screens.
  //   - unlock (newValue=false): refresh + nudge "locked" → "home".
  // The unlock branch deliberately only nudges from "locked"; "approval" stays
  // put so ApprovalRoute re-renders with the refreshed keystore prop and
  // routes to the right Req* view, and onboarding screens stay put too.
  useEffect(() => {
    const listener: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (
      changes,
      areaName,
    ) => {
      if (areaName === "session") {
        const change = changes[SESSION_KEY_WALLET_LOCKED];
        if (!change) return;
        if (change.newValue === true) {
          void (async () => {
            await refreshKeystoreStatus();
            setScreen((prev) =>
              LOCK_SIGNAL_EXEMPT.has(prev) ? prev : "locked",
            );
          })();
        } else if (change.newValue === false) {
          void (async () => {
            await refreshKeystoreStatus();
            setScreen((prev) => (prev === "locked" ? "home" : prev));
          })();
        }
        return;
      }
      if (areaName === "local") {
        // Vault container changes (create / import /
        // select / rename) update `activeVaultId` and / or the vault
        // list in chrome.storage.local. The SW broadcasts
        // `accountsChanged` to tabs via chrome.tabs.sendMessage, but
        // the popup is not a tab and never sees that event. Mirror the
        // change here so `acc.addr` + `activeVaultSummary` refresh
        // immediately after a vault flow lands. refreshKeystoreStatus
        // re-fetches the active account + vault summary; the chip and
        // VaultPicker dropdown re-render off that state.
        if (STORAGE_KEY_VAULTS_CONTAINER_V4 in changes) {
          void refreshKeystoreStatus();
        }
        return;
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [refreshKeystoreStatus]);

  // Belt-and-braces lock→home: if any keystore refresh discovers the SW is
  // unlocked while the popup is still on the lock screen — e.g. the SW
  // restored its session after a hibernation race and there was no
  // walletLocked=false onChanged to flip us (it was already false) — route to
  // Home. Only flips FROM "locked", so it never disturbs onboarding/approval.
  useEffect(() => {
    if (keystore?.unlocked && screen === "locked") {
      setScreen("home");
    }
  }, [keystore?.unlocked, screen]);

  // visibilitychange safety net — when the popup becomes visible again
  // (e.g. an approval window regaining focus), re-sync state in case the
  // SW silently restarted and lost the unlocked backend in between, and
  // refresh the balance in case it changed while the popup was hidden.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      void refreshKeystoreStatus();
      void refreshBalance();
      void refreshActivity();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [refreshKeystoreStatus, refreshBalance, refreshActivity]);

  // Defensive: if the user is on a detail / edit screen but the selected
  // chain is no longer in the list (e.g. dApp removed it via a future
  // op, or chain-list refetch dropped it), bounce back to Networks. The
  // normal navigation paths set selectedChainId before routing here, so
  // this only fires on cross-context state shifts.
  useEffect(() => {
    if (
      (screen === "network-detail" || screen === "network-edit") &&
      selectedChainId !== null &&
      !chainList.some((c) => c.chainId === selectedChainId)
    ) {
      setSelectedChainId(null);
      setScreen("networks");
    }
  }, [screen, selectedChainId, chainList]);

  // Drive refreshBalance off (acc.addr, activeChain.chainId) deps via
  // refreshBalance's own dep array; this effect just kicks the first call
  // and re-fires whenever the callback identity changes.
  useEffect(() => {
    void refreshBalance();
  }, [refreshBalance]);

  // Dep-driven activity refresh. Same shape as the balance
  // effect above. When (acc.addr, activeChain.chainId) changes, the
  // useCallback identity flips and this effect re-fires.
  useEffect(() => {
    void refreshActivity();
  }, [refreshActivity]);

  // Pending-tx detection — track whether the active (addr, chain) has any
  // pending row, sourced from the same chrome.storage key the SW writes on
  // broadcast. Seeded on mount/dep-change + kept live via onChanged so the
  // poll below starts/stops the instant a pending row appears or terminalizes.
  const [hasPendingTx, setHasPendingTx] = useState(false);
  useEffect(() => {
    if (!acc.addr.startsWith("0x")) {
      setHasPendingTx(false);
      return;
    }
    const key = activityPendingKey(acc.addr.toLowerCase(), activeChain.chainId);
    let cancelled = false;
    const apply = (raw: unknown) => {
      if (cancelled) return;
      const v = validatePendingActivityCache(raw);
      setHasPendingTx((v?.pending.length ?? 0) > 0);
    };
    chrome.storage.local.get([key], (res) => apply(res?.[key]));
    const listener: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (
      changes,
      area,
    ) => {
      if (area !== "local") return;
      if (key in changes) apply(changes[key]?.newValue);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, [acc.addr, activeChain.chainId]);

  // App-wide pending reconcile poll — while a pending tx exists, reconcile
  // every PENDING_REPOLL_MS (firing immediately, no first-tick wait) REGARDLESS
  // of which screen is open, so the row flips to confirmed/failed at the chain's
  // real speed even from Send/Home. The Activity tab + notification surfaces
  // update reactively off the SW's storage writes. Stops when the set empties.
  useEffect(() => {
    if (!hasPendingTx) return;
    void refreshActivity();
    const id = setInterval(() => {
      void refreshActivity();
    }, PENDING_REPOLL_MS);
    return () => clearInterval(id);
  }, [hasPendingTx, refreshActivity]);

  // Refetch balance when the user lands on Home so in-popup navigations
  // (Send → Home, Networks → Home, etc.) reflect a balance that may have
  // changed while the user was on another screen. Also covers the post-send
  // bounce-back, which Send.tsx itself doesn't trigger on the parent state.
  useEffect(() => {
    if (screen === "home") {
      void refreshBalance();
      void refreshActivity();
    }
  }, [screen, refreshBalance, refreshActivity]);

  // Re-fetch the active vault summary whenever the user
  // navigates. Cheap (one IPC) and covers the cases where the user
  // switches active vault via VaultPicker (which doesn't have a
  // parent-callback hook today). Multisig-aware screens depend on
  // this state being current.
  useEffect(() => {
    if (keystore?.unlocked && keystore.algo === "mldsa") {
      void loadActiveVaultSummary();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, keystore?.unlocked, keystore?.algo]);

  // Indexer-backed wallet enrichments. These are partial and best-effort:
  // older testnet nodes return method-not-found until the latest mono-core
  // deploy lands, so Home keeps its existing fallback rows when arrays are empty.
  useEffect(() => {
    if (!acc.addr.startsWith("0x")) {
      setIndexerSnapshot(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const r = await bgWalletIndexerSnapshot(acc.addr, activeChain.chainId);
      if (cancelled) return;
      setIndexerSnapshot(r.ok ? r.snapshot : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [acc.addr, activeChain.chainId]);

  // Re-skin popup background per active denom (matches designs/src/ext-app.jsx).
  useEffect(() => {
    const root = document.querySelector(".ext");
    if (!root) return;
    root.setAttribute("data-denom", acc.denom);
    return () => {
      root.removeAttribute("data-denom");
    };
  }, [acc.denom]);

  // Custody mode comes from the background keystore. Today the only mode is
  // software ("sw" + secp256k1); when TPM / passkey / hardware-wallet backends
  // land, the service worker simply returns a different value here and the
  // approval views will reflect it without further popup changes.
  const custody = keystore?.custody ?? "sw";

  /**
   * Switch the active chain via the popup IPC. Mirrors what
   * `wallet_switchEthereumChain` does for dApps (validate, persist,
   * broadcast `chainChanged`) so connected dApps see the switch
   * immediately. Re-fetches the chain list so the new `active` flag
   * is right; balance + fee hooks pick up the change via their
   * `activeChain.chainId` deps.
   */
  const handlePickChain = async (chainId: string) => {
    const r = await bgWalletSetActiveChain(chainId);
    if (!r.ok) {
      // The Networks screen only renders chains the service worker
      // returned, so unknown-chainId here would be a programmer error.
      // Surfacing it would just confuse the user; swallow and stay on
      // the screen so the user can re-pick.
      return;
    }
    await loadChainState();
    setScreen("home");
  };

  // SECURITY: DEFERRED PERSISTENCE.
  //
  // Previously this called bgKeystoreCreateNew which generated the
  // mnemonic AND persisted the vault server-side, returning the
  // mnemonic for display. Closing the popup between Show Phrase and
  // Verify Phrase left a fully-persisted unverified wallet in
  // storage that the next open would route the user straight into,
  // defeating the verify-phrase guarantee.
  //
  // New flow (no chrome.storage write until verify success):
  //   1. Generate the mnemonic on the popup side using the SDK's
  //      generatePqm1Mnemonic + crypto.getRandomValues (same
  //      primitive + same CSPRNG-quality entropy the SW would use).
  //   2. Hold password + mnemonic in popup React state through the
  //      Show Phrase + Verify Phrase steps.
  //   3. On Verify success (handleVerifyComplete below), call
  //      bgKeystoreCreateFromMnemonic — the same atomic-persist path
  //      the Import flow uses — to commit the password + mnemonic
  //      together in a single chrome.storage.local.set.
  //
  // Closing the popup at any pre-commit step discards the React
  // state with zero chrome.storage side-effects. Next open lands
  // on Welcome.
  const handleCreateNew = (password: string) => {
    setCreateError(null);
    let mnemonic: string;
    try {
      mnemonic = generateOnboardingMnemonic();
    } catch (e) {
      setCreateError(
        `Could not generate recovery phrase: ${(e as Error).message}`,
      );
      return;
    }
    setPendingFirstSetupPassword(password);
    setGenerated({ mnemonic });
    setScreen("show-phrase");
  };

  // SECURITY: atomic commit on Verify Phrase success.
  // Runs at the END of first-setup: the only place where the new
  // wallet container is written to chrome.storage. On success we
  // immediately clear the held password + mnemonic so the React
  // state slot can't outlive its purpose.
  const handleVerifyComplete = async () => {
    if (pendingFirstSetupPassword === null || generated === null) {
      // Defensive — state got cleared mid-flow (e.g. user navigated
      // back to Welcome which clears state, then a stale callback
      // fired). Bounce back to Welcome and let the user restart.
      setPendingFirstSetupPassword(null);
      setGenerated(null);
      setCreateError(null);
      setScreen("welcome");
      return;
    }
    const password = pendingFirstSetupPassword;
    const mnemonic = generated.mnemonic;
    const r = await bgKeystoreCreateFromMnemonic(password, mnemonic);
    if (!r.ok) {
      // Commit failed (rare — invalid mnemonic shouldn't be possible
      // since we generated it ourselves; password length is validated
      // at Set Password step). Stay on Verify Phrase so the user can
      // retry; surface the error in the create-error slot which
      // Welcome shows on the next bounce.
      setCreateError(r.reason ?? "Could not finalize wallet setup.");
      return;
    }
    // Persisted successfully. Drop the held secrets, refresh state,
    // route home.
    setPendingFirstSetupPassword(null);
    setGenerated(null);
    setCreateError(null);
    await refreshKeystoreStatus();
    setScreen("home");
  };

  const handleImport = (mnemonic: string) => {
    setImportError(null);
    setPendingMnemonic(mnemonic);
    setScreen("set-password-import");
  };

  const handleImportSubmitPassword = async (password: string) => {
    if (!pendingMnemonic) {
      setImportError("internal: no mnemonic captured");
      setScreen("import");
      return;
    }
    setImportError(null);
    const r = await bgKeystoreCreateFromMnemonic(password, pendingMnemonic);
    if (!r.ok) {
      setImportError(explainImportError(r.reason ?? "Could not import wallet."));
      setScreen("import");
      return;
    }
    setPendingMnemonic(null);
    await refreshKeystoreStatus();
    setScreen("home");
  };

  const finalizeApproval = async (ok: boolean) => {
    if (!activeApproval) return;
    await bgResolveApproval(activeApproval.approval.id, { ok });
    window.close();
  };

  const showBannerStrip =
    screen === "home" ||
    screen === "accounts" ||
    screen === "networks" ||
    screen === "network-detail" ||
    screen === "network-add" ||
    screen === "network-edit" ||
    screen === "settings" ||
    screen === "operators" ||
    screen === "notification-settings" ||
    screen === "mrv-native" ||
    screen === "receive" ||
    screen === "send" ||
    screen === "reveal-phrase" ||
    screen === "reset-wallet" ||
    // Banner shows on the new menu + contacts
    // + multisig-list screens so the chain-status indicator stays
    // continuous when the user navigates between menu sub-pages.
    screen === "main-menu" ||
    screen === "contacts" ||
    screen === "multisig-list";

  // Fullscreen brand wordmark. Read once at render
  // time; main.tsx stamps data-mode on <html> before createRoot.render
  // runs, so the attribute is guaranteed to be present here. The
  // wordmark renders as a sibling above .ext only in fullscreen so
  // the centered card has a MetaMask-style brand header. Popup and
  // sidebar modes keep their bare layout (no wordmark).
  const isFullscreen =
    document.documentElement.dataset["mode"] === "fullscreen";

  return (
    <ErrorBoundary>
    {isFullscreen && (
      <div className="ext-fullscreen-brand">
        <span className="accent">◇</span>Monolythium Browser Wallet
      </div>
    )}
    <div className="ext" data-denom={acc.denom}>
      {showBannerStrip && (
        <ChainStatusBanner
          network={activeChain}
          // Top-bar Networks entry pushes onto the
          // screen stack so back from Networks correctly returns to
          // home. Without this, the hamburger-menu Networks path also
          // landed on home (since the hardcoded "home" fallback
          // matched), masking the bug — the actual fix is using the
          // stack at both entry pushers (top-bar + MainMenu).
          onOpenNetworks={() => navigateTo("networks")}
          unreadCount={bannerUnread}
          {...(screen === "home"
            ? {
                onSettings: () => navigateTo("settings"),
                onConnectedSites: () => navigateTo("connected-sites"),
                // Bell entry to the global notifications
                // page. Same destination as the MainMenu bell row;
                // exposing it on the top bar so the inbox is reachable
                // without opening the hamburger menu.
                onNotifications: () => navigateTo("notifications"),
                // Top-bar lock-button replaced with the
                // hamburger menu trigger. Lock moves into the MainMenu's
                // bottom (danger) section.
                onMenu: () => navigateTo("main-menu"),
              }
            : {})}
        />
      )}

      {screen === "home" && walletUpdateAvailable && (
        <button
          type="button"
          onClick={() =>
            window.open(CWS_LISTING_URL, "_blank", "noopener,noreferrer")
          }
          title="Open the Monolythium wallet on the Chrome Web Store"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            width: "100%",
            padding: "8px 14px",
            border: "none",
            borderBottom: "1px solid rgba(242,180,65,0.3)",
            background:
              "linear-gradient(90deg, rgba(242,180,65,0.18), rgba(242,180,65,0.04))",
            color: "var(--gold)",
            fontFamily: "var(--f-sans)",
            fontSize: 11.5,
            textAlign: "left",
            cursor: "pointer",
          }}
        >
          <span aria-hidden="true">⬆</span>
          <span>A wallet update is available — update on the Chrome Web Store ↗</span>
        </button>
      )}

      {screen === "loading" && <div className="ext-body" style={{ padding: 24, color: "var(--fg-300)" }}>Loading…</div>}

      {screen === "welcome" && (
        <Welcome
          onCreateNew={() => {
            setCreateError(null);
            // SECURITY: defensive clear of any in-flight
            // first-setup state from a previous abandoned attempt.
            setGenerated(null);
            setPendingFirstSetupPassword(null);
            setScreen("set-password-create");
          }}
          onImport={() => {
            setImportError(null);
            setPendingMnemonic(null);
            // SECURITY: same defensive clear when switching
            // from a create attempt to import.
            setGenerated(null);
            setPendingFirstSetupPassword(null);
            setScreen("import");
          }}
          // Welcome → ForgotPassword via navigateTo
          // so back returns to Welcome. The same ForgotPassword screen
          // is also reached from UnlockScreen's Forgot modal (which
          // pushes "locked"); navigateBack handles both pushers.
          onForgotPassword={() => navigateTo("forgot-password")}
        />
      )}

      {/* ForgotPassword's onBack flipped to
         navigateBack so it pops the stack instead of hardcoding
         "welcome". Both entry paths (Welcome and the new UnlockScreen
         Forgot modal) now return to their pusher. */}
      {screen === "forgot-password" && (
        <ForgotPassword
          onBack={navigateBack}
          onWipedThenImport={() => {
            setImportError(null);
            setPendingMnemonic(null);
            void refreshKeystoreStatus();
            setScreen("import");
          }}
        />
      )}

      {screen === "set-password-create" && (
        <SetPassword
          title="Create wallet"
          onBack={() => setScreen("welcome")}
          onSubmit={handleCreateNew}
          error={createError}
        />
      )}

      {/* Onboarding security: ShowPhrase + VerifyPhrase
         no longer receive an onBack callback during first-setup. Without
         the prop, both components hide their back chevron (replaced by
         a 36 px spacer to keep the title centered). User has to advance
         forward through the flow — write down the phrase, confirm, then
         verify — before reaching home. Previously back from ShowPhrase
         jumped straight to home, bypassing verification entirely. */}
      {screen === "show-phrase" && generated && (
        <ShowPhrase
          mnemonic={generated.mnemonic}
          onConfirmed={() => setScreen("verify-phrase")}
        />
      )}

      {/* SECURITY: Verify success triggers the atomic
         commit (bgKeystoreCreateFromMnemonic) and only THEN routes
         home. Previously this just cleared state because the vault
         was already persisted at the Set Password step — now the
         persistence happens RIGHT HERE, after the user has proven
         they wrote down the phrase. handleVerifyComplete clears the
         held password + mnemonic on success and bounces back to
         Welcome if the state got cleared mid-flow. */}
      {screen === "verify-phrase" && generated && (
        <VerifyPhrase
          mnemonic={generated.mnemonic}
          onVerified={() => void handleVerifyComplete()}
        />
      )}

      {screen === "import" && (
        <ImportWallet
          onSubmit={handleImport}
          onBack={() => {
            setImportError(null);
            setPendingMnemonic(null);
            setScreen("welcome");
          }}
          error={importError}
        />
      )}

      {screen === "set-password-import" && (
        <SetPassword
          title="Set wallet password"
          onBack={() => setScreen("import")}
          onSubmit={handleImportSubmitPassword}
          error={importError}
        />
      )}

      {/* UnlockScreen now hosts the Forgot
         password? entry point. The two callbacks route through the
         normal screen-stack: Import sends the user to the existing
         ForgotPassword screen (wipe + Reset & Import flow) via
         navigateTo so its back returns here; Reset lands on Welcome
         after the wipe completes inside UnlockScreen itself. */}
      {screen === "locked" && (
        <UnlockScreen
          address={keystore?.address ?? null}
          onUnlocked={() => {
            // Route to Home synchronously on a successful unlock instead of
            // depending SOLELY on the cross-context walletLocked=false storage
            // event. After an auto-lock + SW wake that event can fail to flip
            // the popup's screen (the "unlocked but stuck on the lock screen
            // until reopen" report); manual lock keeps the same warm popup/SW
            // so it always delivered. resetAutoLock re-armed the alarm minutes
            // out, so Home won't immediately re-lock.
            setScreen("home");
            void refreshKeystoreStatus();
          }}
          onForgotImport={() => navigateTo("forgot-password")}
          onForgotReset={() => {
            void refreshKeystoreStatus();
            setScreen("welcome");
          }}
        />
      )}

      {screen === "home" && (
        <Home
          account={acc}
          network={activeChain}
          indexer={indexerSnapshot}
          onOpenAccounts={() => setScreen("accounts")}
          onSettings={() => setScreen("settings")}
          onOpenReceive={() => setScreen("receive")}
          onOpenSend={() => setScreen("send")}
          onOpenStake={() => setScreen("stake")}
          onOpenBridge={() => setScreen("bridge")}
          // "New wallet" from the VaultPicker
          // dropdown routes through navigateTo so the screen stack
          // pushes "home" and NewWalletFlow's onCancel returns the
          // user back to home cleanly. The legacy single-page modal
          // is bypassed entirely for the fresh-mnemonic path; the
          // Import + Multisig dropdown entries still open
          // VaultAddModal as before.
          onNewWalletFlow={() => navigateTo("new-wallet-flow")}
          // Re-run hydration when VaultAddModal completes so the chip
          // shows the new vault's name immediately, instead of waiting
          // for a lock/unlock or reopen to remount the tree.
          onVaultComplete={() => void refreshKeystoreStatus()}
          topSlot={
            activeVaultSummary ? (
              <>
                <SetupHealthChip
                  vaultId={activeVaultSummary.id}
                  onOpenSecurity={() => setScreen("security")}
                />
                <UnifiedOnboardingHintBar
                  vaultId={activeVaultSummary.id}
                  onOpenSecurity={() => setScreen("security")}
                  onOpenFeatures={() => setScreen("features")}
                />
              </>
            ) : undefined
          }
        />
      )}

      {screen === "accounts" && (
        <Accounts
          current={acc}
          onBack={() => setScreen("home")}
          onPick={(a) => { setAcc(a); setScreen("home"); }}
        />
      )}

      {/* Back from Networks now respects screenStack
         so all entry pushers (top-bar pushes "home", hamburger menu
         pushes "main-menu") return to their pusher. The hardcoded
         "home" worked for the top-bar path but broke the hamburger
         path (same pattern as the About + Connected
         Sites). */}
      {screen === "networks" && (
        <Networks
          current={activeChain}
          chains={chainList}
          policyChains={policyChainList}
          onBack={navigateBack}
          onOpenDetail={(chainId) => {
            setSelectedChainId(chainId);
            setScreen("network-detail");
          }}
          onOpenAddCustom={() => setScreen("network-add")}
        />
      )}

      {screen === "network-detail" && selectedChain && (
        <NetworkDetail
          chain={selectedChain}
          isActive={selectedChain.chainId === activeChainId}
          onBack={() => {
            setSelectedChainId(null);
            setScreen("networks");
          }}
          onActivate={() => {
            void (async () => {
              await handlePickChain(selectedChain.chainId);
            })();
          }}
          onEdit={() => setScreen("network-edit")}
          onDeleted={() => {
            // SW removed the chain (and reset active to Sprintnet if it
            // was the active one). Re-fetch chain-list + active chain so
            // the popup picks up the new state, then route back.
            setSelectedChainId(null);
            void (async () => {
              await loadChainState();
              setScreen("networks");
            })();
          }}
        />
      )}

      {screen === "network-add" && (
        <AddCustomChain
          existingChainIds={new Set(chainList.map((c) => c.chainId))}
          onBack={() => setScreen("networks")}
          onAdded={(chainId) => {
            void (async () => {
              await loadChainState();
              setSelectedChainId(chainId);
              setScreen("network-detail");
            })();
          }}
        />
      )}

      {screen === "network-edit" && selectedChain && (
        <EditChain
          chain={selectedChain}
          onBack={() => setScreen("network-detail")}
          onSaved={() => {
            void (async () => {
              await loadChainState();
              setScreen("network-detail");
            })();
          }}
        />
      )}

      {screen === "settings" && (
        <Settings
          onBack={navigateBack}
          address={keystore?.address ?? ""}
          algo={keystore?.algo ?? "secp256k1"}
          onShowPhrase={() => setScreen("reveal-phrase")}
          // Settings → Connected Sites pushes onto
          // the screen stack via navigateTo so back from Connected
          // Sites correctly returns to Settings (same fix-pattern as
          // the Settings → About entry).
          onShowConnectedSites={() => navigateTo("connected-sites")}
          // Settings → Reset wallet now pushes the
          // stack so back from ResetWallet returns to Settings. The
          // same ResetWallet screen is reached from the hamburger's
          // "Reset wallet" entry (which pushes "main-menu");
          // navigateBack handles both pushers.
          onResetWallet={() => navigateTo("reset-wallet")}
          onOpenOperators={() => setScreen("operators")}
          onOpenNotificationSettings={() => setScreen("notification-settings")}
          onOpenMrvNative={() => setScreen("mrv-native")}
          // Settings → About now pushes onto the
          // screen stack via navigateTo so About's onBack (which
          // uses navigateBack) returns to Settings. Without
          // navigateTo, the click would not push a stack entry and
          // navigateBack would fall back to home, skipping Settings.
          onOpenAbout={() => navigateTo("about")}
          onOpenDelegations={() => setScreen("delegations")}
          // Settings → Theme pushes onto the screen stack via navigateTo
          // so Theme's onBack (navigateBack) returns to Settings — and the
          // same Theme page is reachable from the hamburger menu.
          onOpenTheme={() => navigateTo("theme")}
          {...(activeVaultSummary
            ? {
                onOpenSecurity: () => setScreen("security"),
                onOpenFeatures: () => setScreen("features"),
              }
            : {})}
          {...(activeVaultSummary?.kind === "multisig"
            ? {
                multisig: {
                  signerCount: activeVaultSummary.signerCount,
                  threshold: activeVaultSummary.threshold,
                  pendingCount: activeVaultSummary.pendingCount,
                  onOpenPending: () => setScreen("multisig-pending"),
                  onOpenGovernance: () => setScreen("multisig-governance"),
                },
              }
            : {})}
        />
      )}

      {screen === "security" && activeVaultSummary && (
        <Security
          onBack={() => setScreen("settings")}
          vaultId={activeVaultSummary.id}
          vaultAddress={activeVaultSummary.addr}
          chainIdHex={activeChain.chainId}
        />
      )}

      {screen === "features" && (
        <Features onBack={() => setScreen("settings")} />
      )}

      {/* Theme page. Reached from the Settings "Theme" category card AND
         the hamburger menu, both via navigateTo, so onBack (navigateBack)
         returns to whichever pushed it. */}
      {screen === "theme" && <Theme onBack={navigateBack} />}

      {screen === "operators" && (
        <Operators onBack={() => setScreen("settings")} />
      )}

      {screen === "notification-settings" && (
        <NotificationSettings onBack={() => setScreen("settings")} />
      )}

      {screen === "mrv-native" && (
        <MrvNative
          chainIdHex={activeChain.chainId}
          onBack={() => setScreen("settings")}
        />
      )}

      {/* MainMenu (hamburger). Reached from the top-
         bar menu button on home. Each menu item uses navigateTo so
         the destination's onBack pops back here. */}
      {screen === "main-menu" && (
        <MainMenu
          uiMode={uiMode}
          onBack={navigateBack}
          onOpenFullscreen={() => {
            // Open the wallet in a regular Chrome tab.
            // The detectMode in main.tsx branches on ?mode=fullscreen
            // and the data-mode CSS centers the wallet in a 480 px
            // column. Close the current popup/sidepanel surface after
            // the tab is created.
            void chrome.tabs
              .create({
                url: chrome.runtime.getURL(
                  "src/popup/index.html?mode=fullscreen",
                ),
              })
              .then(() => {
                window.close();
              });
          }}
          onSwitchMode={() => {
            // INSTANT switch (no manual icon click).
            // The chrome.sidePanel.open / chrome.action.openPopup
            // calls require user-gesture context, so they fire
            // SYNCHRONOUSLY inside the click handler before any
            // await. The bgSetUiOpenMode persistence + the
            // window.close cleanup fire-and-forget afterwards.
            const next: UiOpenMode = uiMode === "popup" ? "sidepanel" : "popup";
            if (next === "sidepanel") {
              // popup → sidepanel: open the side panel on the active
              // tab right now (gesture-eligible), then persist mode
              // + close the popup. The side panel's data-mode is
              // re-detected on its own page load from the
              // ?surface=sidepanel query in manifest.json.
              void chrome.tabs
                .query({ active: true, currentWindow: true })
                .then((tabs) => {
                  const tabId = tabs[0]?.id;
                  if (tabId !== undefined && chrome.sidePanel?.open) {
                    void chrome.sidePanel.open({ tabId });
                  }
                });
              void bgSetUiOpenMode("sidepanel").then((r) => {
                if (r.ok) setUiMode(r.mode);
                // Close the popup once the persistence write lands
                // so the storage.onChanged listener on the side
                // panel doesn't catch a stale active surface.
                window.close();
              });
            } else {
              // sidepanel → popup. The earlier
              // version voided chrome.action.openPopup but openPopup
              // was REJECTING silently because while the wallet is in
              // sidepanel mode the SW has set chrome.action.setPopup
              // to "" (empty — clicks-to-icon open the side panel,
              // not a popup). openPopup with no configured popup URL
              // rejects "No active popup."
              //
              // Fix: synchronously call chrome.action.setPopup to
              // bind the popup URL FIRST (gesture-eligible), then
              // immediately call chrome.action.openPopup (still
              // gesture-eligible), THEN persist mode async +
              // close window. The SW's onChanged listener will
              // re-apply the same setPopup on its own a moment
              // later — idempotent.
              let openPopupPromise: Promise<void> | undefined;
              try {
                if (chrome.action?.setPopup) {
                  // Promise-returning but fire-and-forget; the
                  // popup URL is applied effectively immediately
                  // for the openPopup call right below.
                  void chrome.action.setPopup({
                    popup: "src/popup/index.html",
                  });
                }
                if (chrome.action?.openPopup) {
                  openPopupPromise = chrome.action.openPopup();
                }
              } catch (err) {
                // Chrome < 127 or other API gap. Fall through —
                // sidepanel will close; user clicks the icon
                // manually to open the popup.
                console.warn("[mode-switch] openPopup unavailable:", err);
              }
              void bgSetUiOpenMode("popup").then((r) => {
                if (r.ok) setUiMode(r.mode);
              });
              // Wait for the popup to actually open before closing
              // the sidepanel — closing first would leave the user
              // with no UI on screen if openPopup fails mid-flight.
              if (openPopupPromise) {
                void openPopupPromise
                  .catch((err) => {
                    console.warn(
                      "[mode-switch] openPopup rejected:",
                      err,
                    );
                  })
                  .finally(() => {
                    window.close();
                  });
              } else {
                window.close();
              }
            }
          }}
          onContacts={() => navigateTo("contacts")}
          onConnectedSites={() => navigateTo("connected-sites")}
          onNetworks={() => navigateTo("networks")}
          onMultisig={() => navigateTo("multisig-list")}
          {...(agentCommerceEnabled
            ? { onAgentPolicy: () => navigateTo("agent-policy") }
            : {})}
          onSettings={() => navigateTo("settings")}
          // Theme — opens the same Theme page the Settings "Theme" category
          // routes to. navigateTo pushes "main-menu" so back returns here.
          onTheme={() => navigateTo("theme")}
          onAbout={() => navigateTo("about")}
          onLockWallet={() => {
            void bgKeystoreLock();
            // The SW writes walletLocked=true and the
            // chrome.storage.onChanged listener (App.tsx mount-
            // effect) flips screen → "locked" on its own. Local
            // setScreen is belt-and-braces against IPC race.
            setScreen("locked");
          }}
          // Destructive reset reached from the
          // hamburger menu. navigateTo pushes "main-menu" so back from
          // ResetWallet (via navigateBack) returns to the menu instead
          // of skipping to home.
          onResetWallet={() => navigateTo("reset-wallet")}
          // Notifications — open the global inbox. navigateTo
          // pushes "main-menu" so back from the Notifications page
          // returns to the menu.
          onNotifications={() => navigateTo("notifications")}
        />
      )}

      {/* Contacts page. Reached from MainMenu;
         onBack via navigateBack to return to the menu. */}
      {screen === "contacts" && <Contacts onBack={navigateBack} />}

      {/* Notifications page. Global inbox; reached from the
         hamburger menu's bell row. onBack via navigateBack returns to
         the menu. */}
      {screen === "notifications" && <Notifications onBack={navigateBack} />}

      {/* In-app new wallet flow. Reached from the
         VaultPicker dropdown's "New wallet" entry (push "home" onto
         the screen stack). Onboarding's first-setup flow does NOT
         route here — it continues to use the App-level show-phrase
         + verify-phrase screens directly (with their
         back-protection intact). The two flows share the inner
         ShowPhrase + VerifyPhrase components but compose them in
         separate navigation contexts. */}
      {screen === "new-wallet-flow" && (
        <NewWalletFlow
          onCancel={navigateBack}
          onComplete={() => {
            // The newly-created vault is now active. Refresh the
            // active-vault summary so home's chip + setup hints
            // reflect the new state, then route back. Clear the
            // screen stack so back doesn't bring the user back into
            // the just-completed flow.
            void loadActiveVaultSummary();
            void refreshKeystoreStatus();
            setScreen("home");
          }}
        />
      )}

      {/* Multisig wallets top-level list. Reached
         from MainMenu. Tapping a row switches the active vault to
         that multisig and opens the existing Pending dashboard. */}
      {screen === "multisig-list" && (
        <MultisigList
          onBack={navigateBack}
          onOpenPending={() => {
            // Route into the existing multisig-pending screen;
            // the active-vault switch already happened inside the row
            // click handler before this fires.
            setScreen("multisig-pending");
          }}
        />
      )}

      {screen === "about" && (
        <About
          onBack={navigateBack}
          {...(activeVaultSummary?.kind === "multisig"
            ? {
                multisig: {
                  label: activeVaultSummary.label,
                  signerCount: activeVaultSummary.signerCount,
                  threshold: activeVaultSummary.threshold,
                  pendingCount: activeVaultSummary.pendingCount,
                  onOpenGovernance: () => setScreen("multisig-governance"),
                },
              }
            : {})}
          {...(activeVaultSummary
            ? {
                phase9: {
                  vaultId: activeVaultSummary.id,
                  onOpenSecurity: () => setScreen("security"),
                  onOpenFeatures: () => setScreen("features"),
                },
                phase10: {
                  activeVaultId: activeVaultSummary.id,
                  onOpenSecurity: () => setScreen("security"),
                },
              }
            : {})}
        />
      )}

      {screen === "reveal-phrase" && (
        <RevealPhrase onBack={() => setScreen("settings")} />
      )}

      {/* Back from Connected Sites was hardcoded to
         "settings", which broke the top-bar entry path (home → top-bar
         Connected Sites → back should return to home, not Settings).
         navigateBack pops the screen-stack so both entry paths work:
         top-bar (push "home") and hamburger-menu (push "main-menu")
         each return to their pusher. */}
      {screen === "connected-sites" && (
        <ConnectedSites onBack={navigateBack} />
      )}

      {/* ResetWallet's onBack was hardcoded to
         "settings", which routed wrong when entered via the new
         hamburger-menu Reset wallet entry. navigateBack pops the
         screen stack so both entry paths (Settings → Reset and
         hamburger → Reset) return to their pusher. */}
      {screen === "reset-wallet" && (
        <ResetWallet
          onBack={navigateBack}
          onSuccess={() => {
            // SW already wiped + locked; refresh so keystore.hasVault
            // reflects the empty state, then route to Welcome — same
            // path the cold-boot bootstrap takes for a fresh wallet.
            void refreshKeystoreStatus();
            setCreateError(null);
            setImportError(null);
            setGenerated(null);
            setPendingMnemonic(null);
            // SECURITY: clear any in-flight first-setup
            // state on reset (defensive — reset-wallet from an
            // existing setup shouldn't have first-setup state, but
            // belt-and-braces against future flows).
            setPendingFirstSetupPassword(null);
            setScreen("welcome");
          }}
        />
      )}

      {screen === "receive" && (
        <Receive account={acc} onBack={() => setScreen("home")} />
      )}

      {screen === "send" && (
        <Send
          account={acc}
          chainId={activeChain.chainId}
          onBack={() => setScreen("home")}
          {...(activeVaultSummary?.kind === "multisig"
            ? { multisigVaultId: activeVaultSummary.id }
            : activeVaultSummary !== null
            ? { singleVaultId: activeVaultSummary.id }
            : {})}
        />
      )}

      {screen === "multisig-pending" && activeVaultSummary !== null && (
        <MultisigPending
          vaultId={activeVaultSummary.id}
          onBack={() => setScreen("settings")}
        />
      )}

      {screen === "multisig-governance" && activeVaultSummary !== null && (
        <MultisigGovernance
          vaultId={activeVaultSummary.id}
          onBack={() => setScreen("settings")}
        />
      )}

      {screen === "stake" && (
        <Stake
          account={acc}
          chainId={activeChain.chainId}
          {...(stakeDeepLink !== null
            ? {
                initialAction: stakeDeepLink.action,
                initialClusterId: stakeDeepLink.clusterId,
              }
            : {})}
          onShowClusterDetail={(cluster) => {
            setSelectedCluster(cluster);
            setClusterDetailEntrySource("stake");
            setScreen("cluster-detail");
          }}
          onBack={() => {
            const wasDeepLinked = stakeDeepLink !== null;
            setStakeDeepLink(null);
            // User is explicitly leaving Stake; clear the
            // persisted form / selection state so the next mount
            // starts fresh.
            clearStakeState();
            setScreen(wasDeepLinked ? "delegations" : "home");
          }}
        />
      )}

      {screen === "delegations" && (
        <Delegations
          account={acc}
          chainId={activeChain.chainId}
          onBack={() => setScreen("settings")}
          onUnstake={(clusterId) => {
            setStakeDeepLink({ action: "undelegate", clusterId });
            setScreen("stake");
          }}
          onRedelegate={(clusterId) => {
            setStakeDeepLink({ action: "redelegate", clusterId });
            setScreen("stake");
          }}
          onStakeMore={() => {
            setStakeDeepLink(null);
            setScreen("stake");
          }}
          onShowClusterDetail={(cluster) => {
            setSelectedCluster(cluster);
            setClusterDetailEntrySource("delegations");
            setScreen("cluster-detail");
          }}
        />
      )}

      {screen === "cluster-detail" && selectedCluster !== null && (
        <ClusterDetail
          cluster={selectedCluster}
          walletAddress={acc.addr.startsWith("0x") ? acc.addr : null}
          onBack={() => {
            const target = clusterDetailEntrySource ?? "delegations";
            setSelectedCluster(null);
            setClusterDetailEntrySource(null);
            setScreen(target);
          }}
        />
      )}

      {screen === "bridge" && (
        <Bridge
          indexer={indexerSnapshot}
          onBack={() => setScreen("home")}
        />
      )}

      {screen === "agent-policy" && agentCommerceEnabled && (
        <AgentPolicy
          account={acc}
          chainId={activeChain.chainId}
          onBack={() => setScreen("main-menu")}
        />
      )}

      {screen === "approval" && activeApproval && (
        <ApprovalRoute
          approval={activeApproval}
          keystore={keystore}
          onApprove={() => finalizeApproval(true)}
          onReject={() => finalizeApproval(false)}
          custody={custody}
          chain={activeChain}
        />
      )}
    </div>
    </ErrorBoundary>
  );
}

// ---- Sub-screens ----

interface ApprovalRouteProps {
  approval: UiApproval;
  keystore: KeystoreStatus | null;
  onApprove: () => void;
  onReject: () => void;
  custody: "tpm" | "passkey" | "hw" | "sw";
  chain: ChainEntry;
}

function ApprovalRoute({
  approval,
  keystore,
  onApprove,
  onReject,
  custody,
  chain,
}: ApprovalRouteProps) {
  const a = approval.approval;

  // Common preflight: if the wallet is locked, show the unlock screen. The
  // approval target (Approve button) only renders once unlocked. Unlock
  // success flows through chrome.storage.onChanged → refreshKeystoreStatus,
  // so the conditional re-evaluates without local nav.
  if (keystore && !keystore.unlocked) {
    return (
      <ReqSheet onBack={onReject}>
        <UnlockScreen address={keystore.address ?? null} chain={chain} />
      </ReqSheet>
    );
  }

  const req = a.request;

  if (req.kind === "connect") {
    return (
      <ReqSheet onBack={onReject}>
        <ReqConnect
          request={req as ConnectRequest}
          address={keystore?.address ?? ""}
          custody={custody}
          onApprove={onApprove}
          onReject={onReject}
          chain={chain}
        />
      </ReqSheet>
    );
  }
  if (req.kind === "personal_sign") {
    return (
      <ReqSheet onBack={onReject}>
        <ReqPersonalSignReal
          request={req as PersonalSignRequest}
          custody={custody}
          onApprove={onApprove}
          onReject={onReject}
          chain={chain}
        />
      </ReqSheet>
    );
  }
  if (req.kind === "typed_sign") {
    return (
      <ReqSheet onBack={onReject}>
        <ReqTypedSign
          request={req as TypedSignRequest}
          custody={custody}
          onApprove={onApprove}
          onReject={onReject}
          chain={chain}
        />
      </ReqSheet>
    );
  }
  if (req.kind === "send_tx") {
    return (
      <ReqSheet onBack={onReject}>
        <ReqSendTx
          request={req as SendTxRequest}
          custody={custody}
          signerAddress={keystore?.address ?? ""}
          onApprove={onApprove}
          onReject={onReject}
          chain={chain}
        />
      </ReqSheet>
    );
  }
  if (req.kind === "add_chain") {
    return (
      <ReqSheet onBack={onReject}>
        <ReqAddChain
          request={req as AddChainRequest}
          onApprove={onApprove}
          onReject={onReject}
          chain={chain}
        />
      </ReqSheet>
    );
  }
  // switch_chain or future approval kinds — fall through with a generic confirm.
  return (
    <ReqSheet onBack={onReject}>
      <ChainStatusBanner network={chain} />
      <div style={{ padding: 18 }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>Confirm request</h2>
        <pre style={{ marginTop: 10, fontFamily: "var(--f-mono)", fontSize: 10, color: "var(--fg-400)", whiteSpace: "pre-wrap" }}>
          {JSON.stringify(req, null, 2)}
        </pre>
      </div>
      <div className="req-foot">
        <button onClick={onReject}>Reject</button>
        <button className="prim" onClick={onApprove}>Approve</button>
      </div>
    </ReqSheet>
  );
}
