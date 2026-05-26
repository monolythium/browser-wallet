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
import "./tokens.css";
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
import { SendNft, type SendNftTarget } from "./pages/SendNft";
import { Settings } from "./pages/Settings";
import { Security } from "./pages/Security";
import { Features } from "./pages/Features";
import { UnifiedOnboardingHintBar } from "./components/UnifiedOnboardingHintBar";
import { SetupHealthChip } from "./components/SetupHealthChip";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Stake } from "./pages/Stake";
import { Delegations } from "./pages/Delegations";
import { ClusterDetail } from "./pages/ClusterDetail";
import { NetworkDetail } from "./pages/NetworkDetail";
import { AddCustomChain } from "./pages/AddCustomChain";
import { EditChain } from "./pages/EditChain";
import { Operators } from "./pages/Operators";
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
import { Contacts } from "./pages/Contacts";
import { MultisigList } from "./pages/MultisigList";
import { ACCOUNTS, type Account } from "./demo-data";
import {
  bgListPending,
  bgKeystoreStatus,
  bgKeystoreLock,
  bgPing,
  bgKeystoreCreateNew,
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
  bgGetUiOpenMode,
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
  | "about"
  | "reveal-phrase"
  | "reset-wallet"
  | "receive"
  | "send"
  | "send-nft"
  | "stake"
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
  | "main-menu"
  | "contacts";

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
  name: "Monolythium · Sprintnet",
  // Bootstrap-window rpc. Mirrors SPRINTNET_OPERATOR_RPCS_DEFAULTS[0] in
  // src/background/networks.ts so a fresh-install's first paint targets a
  // live endpoint. Updated to operator-2 on 2026-05-11 regenesis (operator-1's
  // bls.key was destroyed; see networks.ts docstring).
  rpc: "http://192.0.2.1:8545",
  builtin: true,
  official: true,
  active: true,
  nativeCurrency: { name: "Monolythium LYTH", symbol: "LYTH", decimals: 18 },
};

export default function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  // Round 7 TASK 4 — current UI open mode (popup vs sidepanel). The
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
  // Round 7 TASK 4 — back-navigation stack. When user navigates via the
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
  const [generated, setGenerated] = useState<{ mnemonic: string; address: string } | null>(null);
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
  const activeChain: ChainEntry =
    chainList.find((c) => c.chainId === activeChainId) ?? SPRINTNET_FALLBACK;
  // Currently-viewed chain on NetworkDetail / EditChain. Set when the user
  // taps a row on the Networks list; cleared when they back out.
  const [selectedChainId, setSelectedChainId] = useState<string | null>(null);
  // Phase 5 Commit 7 — selected NFT for the SendNft route. Set when
  // NftDetail's Send CTA fires; cleared when SendNft routes back to
  // Home or the user navigates away. Lives at App-level because
  // NftTab → NftDetail → SendNft spans the Home/page boundary.
  const [pendingSendNft, setPendingSendNft] = useState<SendNftTarget | null>(null);
  // Phase 7 — Delegations → Stake deeplink. When a Delegations-page
  // "Unstake" / "Redelegate" CTA fires, App stores the action + the
  // source cluster so the Stake page can land directly on the form.
  // Cleared on Stake → home navigation.
  const [stakeDeepLink, setStakeDeepLink] = useState<{
    action: "undelegate" | "redelegate";
    clusterId: number;
  } | null>(null);
  // Phase 11 Commit 6 — selected cluster for the cluster-detail panel.
  // Set when the user navigates from ClusterPicker or Delegations row
  // → cluster detail. The cluster directory row is held inline rather
  // than re-fetched: it's already in the parent's state from the
  // staking-cluster-directory call that populated the picker.
  const [selectedCluster, setSelectedCluster] = useState<
    import("../shared/staking").ClusterDirectoryEntry | null
  >(null);
  const selectedChain: ChainEntry | null =
    selectedChainId !== null
      ? (chainList.find((c) => c.chainId === selectedChainId) ?? null)
      : null;

  const loadChainState = async () => {
    const [activeRes, list] = await Promise.all([
      bgWalletActiveChain(),
      bgChainList(),
    ]);
    setChainList(list);
    if (activeRes.ok) setActiveChainId(activeRes.chainId);
  };

  // Fetch the unlocked v3 keypair and patch `acc` with its real EVM
  // address + algo. Demo data stays as the fallback shape; only the
  // identity-bearing fields are overridden so Home keeps rendering the
  // same component without a rewrite.
  const loadActiveAccount = async () => {
    const r = await bgWalletActiveAccount();
    if (!r.ok) return;
    setAcc((prev) => ({
      ...prev,
      id: "v3-active",
      label: "ML-DSA-65 wallet",
      addr: r.account.address,
      algo: r.account.algo === "mldsa" ? "mldsa" : "slhdsa",
      custody: r.account.custody,
      denom: "public",
      balance: null,
      pinned: true,
    }));
  };

  // Phase 8 — track the active vault summary so we can detect when
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

  // Phase 4.4 — activity refresh trigger. Verbatim mirror of the
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

  // Phase 5.0.1 — wake the SW out of MV3 idle BEFORE any real call
  // goes out. Without this, the first `bgKeystoreStatus()` below
  // (and the picker / chain banner mounts that follow) sometimes
  // race the SW boot and surface as "Unchecked runtime.lastError:
  // No SW receiving end" in the console. Fire-and-forget; the
  // followup calls also retry once on the same error class.
  useEffect(() => {
    void bgPing();
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
        // Round 4 TASK 1 — vault container changes (create / import /
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

  // Phase 4.4 — dep-driven activity refresh. Same shape as the balance
  // effect above. When (acc.addr, activeChain.chainId) changes, the
  // useCallback identity flips and this effect re-fires.
  useEffect(() => {
    void refreshActivity();
  }, [refreshActivity]);

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

  // Phase 8 — re-fetch the active vault summary whenever the user
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

  const handleCreateNew = async (password: string) => {
    setCreateError(null);
    const r = await bgKeystoreCreateNew(password);
    if (!r.ok) {
      setCreateError(r.reason ?? "failed to create vault");
      return;
    }
    setGenerated({ mnemonic: r.mnemonic, address: r.address });
    await refreshKeystoreStatus();
    setScreen("show-phrase");
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
      setImportError(r.reason ?? "failed to import wallet");
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
    screen === "mrv-native" ||
    screen === "receive" ||
    screen === "send" ||
    screen === "reveal-phrase" ||
    screen === "reset-wallet" ||
    // Round 7 TASK 4 / 5 / 7 — banner shows on the new menu + contacts
    // + multisig-list screens so the chain-status indicator stays
    // continuous when the user navigates between menu sub-pages.
    screen === "main-menu" ||
    screen === "contacts" ||
    screen === "multisig-list";

  // Round 10 TASK 6 — fullscreen brand wordmark. Read once at render
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
        <span className="accent">◇</span>Monolythium Wallet
      </div>
    )}
    <div className="ext" data-denom={acc.denom}>
      {showBannerStrip && (
        <ChainStatusBanner
          network={activeChain}
          onOpenNetworks={() => setScreen("networks")}
          {...(screen === "home"
            ? {
                onSettings: () => navigateTo("settings"),
                onConnectedSites: () => navigateTo("connected-sites"),
                // Round 7 TASK 4 — top-bar lock-button replaced with the
                // hamburger menu trigger. Lock moves into the MainMenu's
                // bottom (danger) section.
                onMenu: () => navigateTo("main-menu"),
              }
            : {})}
        />
      )}

      {screen === "loading" && <div className="ext-body" style={{ padding: 24, color: "var(--fg-300)" }}>Loading…</div>}

      {screen === "welcome" && (
        <Welcome
          onCreateNew={() => {
            setCreateError(null);
            setGenerated(null);
            setScreen("set-password-create");
          }}
          onImport={() => {
            setImportError(null);
            setPendingMnemonic(null);
            setScreen("import");
          }}
          onForgotPassword={() => setScreen("forgot-password")}
        />
      )}

      {screen === "forgot-password" && (
        <ForgotPassword
          onBack={() => setScreen("welcome")}
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

      {screen === "show-phrase" && generated && (
        <ShowPhrase
          mnemonic={generated.mnemonic}
          onConfirmed={() => setScreen("verify-phrase")}
          onBack={() => setScreen("home")}
        />
      )}

      {screen === "verify-phrase" && generated && (
        <VerifyPhrase
          mnemonic={generated.mnemonic}
          onVerified={() => {
            setGenerated(null);
            setScreen("home");
          }}
          onBack={() => setScreen("show-phrase")}
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

      {screen === "locked" && (
        <UnlockScreen address={keystore?.address ?? null} />
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
          onOpenSendNft={(target) => {
            setPendingSendNft(target);
            setScreen("send-nft");
          }}
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

      {screen === "networks" && (
        <Networks
          current={activeChain}
          chains={chainList}
          onBack={() => setScreen("home")}
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
          // Round 11 TASK 1 — Settings → Connected Sites pushes onto
          // the screen stack via navigateTo so back from Connected
          // Sites correctly returns to Settings (same fix-pattern as
          // Round 9 TASK 2's Settings → About).
          onShowConnectedSites={() => navigateTo("connected-sites")}
          // Round 11 TASK 3 — Settings → Reset wallet now pushes the
          // stack so back from ResetWallet returns to Settings. The
          // same ResetWallet screen is reached from the hamburger's
          // "Reset wallet" entry (which pushes "main-menu");
          // navigateBack handles both pushers.
          onResetWallet={() => navigateTo("reset-wallet")}
          onOpenOperators={() => setScreen("operators")}
          onOpenMrvNative={() => setScreen("mrv-native")}
          // Round 9 TASK 2 — Settings → About now pushes onto the
          // screen stack via navigateTo so About's onBack (which
          // uses navigateBack) returns to Settings. Without
          // navigateTo, the click would not push a stack entry and
          // navigateBack would fall back to home, skipping Settings.
          onOpenAbout={() => navigateTo("about")}
          onOpenDelegations={() => setScreen("delegations")}
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

      {screen === "operators" && (
        <Operators onBack={() => setScreen("settings")} />
      )}

      {screen === "mrv-native" && (
        <MrvNative
          chainIdHex={activeChain.chainId}
          onBack={() => setScreen("settings")}
        />
      )}

      {/* Round 7 TASK 4 — MainMenu (hamburger). Reached from the top-
         bar menu button on home. Each menu item uses navigateTo so
         the destination's onBack pops back here. */}
      {screen === "main-menu" && (
        <MainMenu
          uiMode={uiMode}
          onBack={navigateBack}
          onOpenFullscreen={() => {
            // Round 8 TASK 3 — open the wallet in a regular Chrome tab.
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
            // Round 8 TASK 2 — INSTANT switch (no manual icon click).
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
              // sidepanel → popup. Round 9 TASK 1 fix: the Round 8
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
          onSettings={() => navigateTo("settings")}
          onAbout={() => navigateTo("about")}
          onLockWallet={() => {
            void bgKeystoreLock();
            // The SW writes walletLocked=true and the
            // chrome.storage.onChanged listener (App.tsx mount-
            // effect) flips screen → "locked" on its own. Local
            // setScreen is belt-and-braces against IPC race.
            setScreen("locked");
          }}
          // Round 11 TASK 3 — destructive reset reached from the
          // hamburger menu. navigateTo pushes "main-menu" so back from
          // ResetWallet (via navigateBack) returns to the menu instead
          // of skipping to home.
          onResetWallet={() => navigateTo("reset-wallet")}
        />
      )}

      {/* Round 7 TASK 5 — Contacts page. Reached from MainMenu;
         onBack via navigateBack to return to the menu. */}
      {screen === "contacts" && <Contacts onBack={navigateBack} />}

      {/* Round 7 TASK 7 — Multisig wallets top-level list. Reached
         from MainMenu. Tapping a row switches the active vault to
         that multisig and opens the existing Pending dashboard. */}
      {screen === "multisig-list" && (
        <MultisigList
          onBack={navigateBack}
          onOpenPending={() => {
            // Route into the existing Phase 8 multisig-pending screen;
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

      {/* Round 11 TASK 1 — back from Connected Sites was hardcoded to
         "settings", which broke the top-bar entry path (home → top-bar
         Connected Sites → back should return to home, not Settings).
         navigateBack pops the screen-stack so both entry paths work:
         top-bar (push "home") and hamburger-menu (push "main-menu")
         each return to their pusher. */}
      {screen === "connected-sites" && (
        <ConnectedSites onBack={navigateBack} />
      )}

      {/* Round 11 TASK 3 — ResetWallet's onBack was hardcoded to
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

      {screen === "send-nft" && pendingSendNft && (
        <SendNft
          fromAddress={acc.addr.startsWith("0x") ? acc.addr : null}
          chainId={activeChain.chainId}
          nft={pendingSendNft}
          onBack={() => {
            setPendingSendNft(null);
            setScreen("home");
          }}
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
            setScreen("cluster-detail");
          }}
          onBack={() => {
            const wasDeepLinked = stakeDeepLink !== null;
            setStakeDeepLink(null);
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
            setScreen("cluster-detail");
          }}
        />
      )}

      {screen === "cluster-detail" && selectedCluster !== null && (
        <ClusterDetail
          cluster={selectedCluster}
          walletAddress={acc.addr.startsWith("0x") ? acc.addr : null}
          onBack={() => {
            setSelectedCluster(null);
            // Most cluster-detail entry points come from Stake or
            // Delegations; default back-target is delegations.
            setScreen("delegations");
          }}
        />
      )}

      {screen === "bridge" && (
        <Bridge
          indexer={indexerSnapshot}
          onBack={() => setScreen("home")}
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
