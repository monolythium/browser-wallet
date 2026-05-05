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

import { useCallback, useEffect, useState } from "react";
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
import { Welcome } from "./pages/Welcome";
import { SetPassword } from "./pages/SetPassword";
import { ShowPhrase } from "./pages/ShowPhrase";
import { VerifyPhrase } from "./pages/VerifyPhrase";
import { ImportWallet } from "./pages/ImportWallet";
import { UnlockScreen } from "./pages/UnlockScreen";
import { RevealPhrase } from "./pages/RevealPhrase";
import { ResetWallet } from "./pages/ResetWallet";
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
  bgWalletIndexerSnapshot,
  bgWalletActiveChain,
  bgWalletSetActiveChain,
  bgChainList,
  type PendingApproval,
  type KeystoreStatus,
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
  | "settings"
  | "reveal-phrase"
  | "reset-wallet"
  | "receive"
  | "send"
  | "stake"
  | "bridge"
  | "approval";

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
  rpc: "http://192.0.2.7:8545",
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

  // SW-pushed lock signal — chrome.storage.session is set with
  // walletLocked=true whenever the SW auto-locks (alarm fired) or any code
  // path explicitly locks. Refetch state and route the popup back to the
  // Unlock screen so the user can't act on a stale "unlocked" UI.
  useEffect(() => {
    const listener: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (
      changes,
      areaName,
    ) => {
      if (areaName !== "session") return;
      const change = changes[SESSION_KEY_WALLET_LOCKED];
      if (change && change.newValue === true) {
        void (async () => {
          await refreshKeystoreStatus();
          setScreen((prev) =>
            LOCK_SIGNAL_EXEMPT.has(prev) ? prev : "locked",
          );
        })();
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [refreshKeystoreStatus]);

  // visibilitychange safety net — when the popup becomes visible again
  // (e.g. an approval window regaining focus), re-sync state in case the
  // SW silently restarted and lost the unlocked backend in between.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") void refreshKeystoreStatus();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [refreshKeystoreStatus]);

  // Balance refresh — runs whenever the active account or active
  // chain changes. Reads from `activeChain.chainId`, which the
  // service worker resolves from chrome.storage (`mono.chain.active`)
  // and falls back to Sprintnet on first launch.
  useEffect(() => {
    if (!acc.addr.startsWith("0x")) return;
    let cancelled = false;
    void (async () => {
      const r = await bgWalletBalance(acc.addr, activeChain.chainId);
      if (cancelled) return;
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
    })();
    return () => {
      cancelled = true;
    };
  }, [acc.addr, activeChain.chainId]);

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
    screen === "settings" ||
    screen === "receive" ||
    screen === "send" ||
    screen === "reveal-phrase" ||
    screen === "reset-wallet";

  return (
    <div className="ext" data-denom={acc.denom}>
      {showBannerStrip && <ChainStatusBanner />}

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
          onOpenNetworks={() => setScreen("networks")}
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
          onPick={(chainId) => { void handlePickChain(chainId); }}
        />
      )}

      {screen === "settings" && (
        <Settings
          onBack={() => setScreen("home")}
          address={keystore?.address ?? ""}
          algo={keystore?.algo ?? "secp256k1"}
          onShowPhrase={() => setScreen("reveal-phrase")}
          onResetWallet={() => setScreen("reset-wallet")}
        />
      )}

      {screen === "reveal-phrase" && (
        <RevealPhrase onBack={() => setScreen("settings")} />
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
}

function ApprovalRoute({
  approval,
  keystore,
  onApprove,
  onReject,
  custody,
}: ApprovalRouteProps) {
  const a = approval.approval;

  // Common preflight: if the wallet is locked, show the unlock screen. The
  // approval target (Approve button) only renders once unlocked. Unlock
  // success flows through chrome.storage.onChanged → refreshKeystoreStatus,
  // so the conditional re-evaluates without local nav.
  if (keystore && !keystore.unlocked) {
    return (
      <ReqSheet onBack={onReject}>
        <UnlockScreen address={keystore.address ?? null} />
      </ReqSheet>
    );
  }

  const req = a.request;

  if (req.kind === "connect") {
    return (
      <ReqSheet onBack={onReject}>
        <ReqConnect custody={custody} onApprove={onApprove} onReject={onReject} />
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
        />
      </ReqSheet>
    );
  }
  // switch_chain or future approval kinds — fall through with a generic confirm.
  return (
    <ReqSheet onBack={onReject}>
      <ChainStatusBanner />
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

