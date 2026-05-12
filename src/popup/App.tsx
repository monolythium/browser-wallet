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
import { SESSION_KEY_WALLET_LOCKED } from "../shared/constants";
import "./tokens.css";
import "./glass.css";
import "./ext.css";
import {
  Home, Accounts, Networks, Stake, Bridge,
  ReqConnect,
  ReqSheet, ChainStatusBanner,
  ReqSendTx, ReqPersonalSignReal, ReqTypedSign, ReqAddChain,
} from "./components";
import { Receive } from "./pages/Receive";
import { Send } from "./pages/Send";
import { Settings } from "./pages/Settings";
import { NetworkDetail } from "./pages/NetworkDetail";
import { AddCustomChain } from "./pages/AddCustomChain";
import { EditChain } from "./pages/EditChain";
import { Operators } from "./pages/Operators";
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
import { ACCOUNTS, type Account } from "./demo-data";
import {
  bgListPending,
  bgKeystoreStatus,
  bgKeystoreCreateNew,
  bgKeystoreCreateFromMnemonic,
  bgResolveApproval,
  bgWalletActiveAccount,
  bgWalletBalance,
  bgWalletActivityGet,
  bgWalletIndexerSnapshot,
  bgWalletActiveChain,
  bgWalletSetActiveChain,
  bgChainList,
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
  | "reveal-phrase"
  | "reset-wallet"
  | "receive"
  | "send"
  | "stake"
  | "bridge"
  | "approval"
  | "connected-sites";

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
  // live endpoint. Updated to val-2 on 2026-05-11 regenesis (val-1's
  // bls.key was destroyed; see networks.ts docstring).
  rpc: "http://192.0.2.1:8545",
  builtin: true,
  official: true,
  active: true,
  nativeCurrency: { name: "Monolythium LYTH", symbol: "LYTH", decimals: 18 },
};

export default function App() {
  const [screen, setScreen] = useState<Screen>("loading");
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

  // Re-fetch keystore status + dependent identity/chain state. Used by the
  // mount bootstrap, the unlock/create flows, and the SW-pushed lock signal.
  // Empty deps deliberately — this captures the first-render closures and
  // the underlying setters/imports are stable across renders.
  const refreshKeystoreStatus = useCallback(async () => {
    const ks = await bgKeystoreStatus();
    setKeystore(ks);
    if (ks.algo === "mldsa") {
      await loadActiveAccount();
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
      const wei = BigInt(r.balanceHex);
      // 18-decimal LYTH; Number() loses precision above ~9e15 LYTH but
      // that's far beyond any realistic Sprintnet balance.
      const lyth = Number(wei) / 1e18;
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
      if (areaName !== "session") return;
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
    screen === "receive" ||
    screen === "send" ||
    screen === "reveal-phrase" ||
    screen === "reset-wallet";

  return (
    <div className="ext" data-denom={acc.denom}>
      {showBannerStrip && (
        <ChainStatusBanner
          network={activeChain}
          onOpenNetworks={() => setScreen("networks")}
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
          onOpenOnboard={() => setScreen("welcome")}
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
          onBack={() => setScreen("home")}
          address={keystore?.address ?? ""}
          algo={keystore?.algo ?? "secp256k1"}
          onShowPhrase={() => setScreen("reveal-phrase")}
          onShowConnectedSites={() => setScreen("connected-sites")}
          onResetWallet={() => setScreen("reset-wallet")}
          onOpenOperators={() => setScreen("operators")}
        />
      )}

      {screen === "operators" && (
        <Operators onBack={() => setScreen("settings")} />
      )}

      {screen === "reveal-phrase" && (
        <RevealPhrase onBack={() => setScreen("settings")} />
      )}

      {screen === "connected-sites" && (
        <ConnectedSites onBack={() => setScreen("settings")} />
      )}

      {screen === "reset-wallet" && (
        <ResetWallet
          onBack={() => setScreen("settings")}
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
        />
      )}

      {screen === "stake" && (
        <Stake onBack={() => setScreen("home")} />
      )}

      {screen === "bridge" && (
        <Bridge onBack={() => setScreen("home")} />
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

