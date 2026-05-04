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

import { useEffect, useState } from "react";
import "./tokens.css";
import "./glass.css";
import "./ext.css";
import {
  Home, Accounts, Networks, Settings, Receive, Send, Stake, Bridge,
  ReqConnect, ReqOnboard,
  ReqSheet, ChainStatusBanner,
  ReqSendTx, ReqPersonalSignReal, ReqTypedSign, ReqAddChain,
} from "./components";
import { ACCOUNTS, type Account } from "./demo-data";
import {
  bgListPending,
  bgKeystoreStatus,
  bgKeystoreCreateNew,
  bgKeystoreUnlock,
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
  | "onboard-create"
  | "locked"
  | "home"
  | "accounts"
  | "networks"
  | "settings"
  | "receive"
  | "send"
  | "stake"
  | "bridge"
  | "approval";

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
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [generated, setGenerated] = useState<{ seedHex: string; address: string } | null>(null);

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

  // ---- mount-time bootstrap ----
  useEffect(() => {
    void (async () => {
      const ks = await bgKeystoreStatus();
      setKeystore(ks);

      const url = new URL(window.location.href);
      const approvalId = url.searchParams.get("approval");
      if (approvalId) {
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

      // No approval requested — show normal popup.
      if (!ks.hasVault) {
        setScreen("onboard-create");
      } else if (!ks.unlocked) {
        setScreen("locked");
      } else {
        setScreen("home");
        if (ks.algo === "mldsa") {
          await loadActiveAccount();
        }
      }
      // Always hydrate the chain state — the locked / onboarding
      // screens don't need it, but the cost is a single IPC pair and
      // it primes the home screen render that follows unlock.
      await loadChainState();
    })();
  }, []);

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
  // The Settings panel still expects the legacy `slhdsa | mldsa` taxonomy from
  // the design mockups. Map secp256k1 → "slhdsa" (the closest UI slot for the
  // current pre-PQ key) so the Settings screen renders correctly. Once the PQ
  // keystore lands this becomes a 1:1 mapping.
  const algo = keystore?.algo === "mldsa" ? ("mldsa" as const) : ("slhdsa" as const);

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

  const handleUnlock = async (password: string) => {
    setUnlockError(null);
    const r = await bgKeystoreUnlock(password);
    if (!r.ok) {
      setUnlockError(r.reason ?? "wrong password");
      return;
    }
    const ks = await bgKeystoreStatus();
    setKeystore(ks);
    if (ks.algo === "mldsa") {
      await loadActiveAccount();
    }
    await loadChainState();
    if (activeApproval) {
      // We're in the approval flow — stay on the approval screen so the user
      // can hit Approve.
      return;
    }
    setScreen("home");
  };

  const handleCreateNew = async (password: string) => {
    setCreateError(null);
    const r = await bgKeystoreCreateNew(password);
    if (!r.ok) {
      setCreateError(r.reason ?? "failed to create vault");
      return;
    }
    setGenerated({ seedHex: r.seedHex, address: r.address });
    const ks = await bgKeystoreStatus();
    setKeystore(ks);
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
    screen === "send";

  return (
    <div className="ext" data-denom={acc.denom}>
      {showBannerStrip && <ChainStatusBanner />}

      {screen === "loading" && <div className="ext-body" style={{ padding: 24, color: "var(--fg-300)" }}>Loading…</div>}

      {screen === "onboard-create" && (
        <ReqSheet onBack={() => setScreen("loading")}>
          {generated ? (
            <NewWalletReveal
              seedHex={generated.seedHex}
              address={generated.address}
              onContinue={() => {
                setScreen("home");
                void loadActiveAccount();
                void loadChainState();
              }}
            />
          ) : (
            <CreateWalletForm
              onSubmit={handleCreateNew}
              error={createError}
              legacyNotice={!!keystore?.legacyVault}
            />
          )}
        </ReqSheet>
      )}

      {screen === "locked" && keystore?.address && (
        <ReqSheet onBack={() => window.close()}>
          <UnlockForm
            address={keystore.address}
            error={unlockError}
            onSubmit={handleUnlock}
          />
        </ReqSheet>
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
          onOpenOnboard={() => setScreen("onboard-create")}
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
        <Settings onBack={() => setScreen("home")} custody={custody} algo={algo} />
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
          unlockError={unlockError}
          onUnlock={handleUnlock}
          onApprove={() => finalizeApproval(true)}
          onReject={() => finalizeApproval(false)}
          custody={custody}
        />
      )}
    </div>
  );
}

// ---- Sub-screens ----

interface CreateWalletFormProps {
  onSubmit: (password: string) => void;
  error: string | null;
  /**
   * Show the "vault format upgraded — re-import your seed" banner. Set when
   * the background reports a legacy v1 (PBKDF2+AES-GCM) envelope on disk.
   */
  legacyNotice: boolean;
}

function CreateWalletForm({ onSubmit, error, legacyNotice }: CreateWalletFormProps) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const mismatch = password.length > 0 && confirm.length > 0 && password !== confirm;
  const tooShort = password.length > 0 && password.length < 8;

  return (
    <>
      <ChainStatusBanner />
      <div style={{ padding: "26px 22px 12px", textAlign: "center" }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Create a wallet</h2>
        <div style={{ fontFamily: "var(--f-mono)", fontSize: 10, color: "var(--fg-400)", letterSpacing: "0.16em", textTransform: "uppercase", marginTop: 4 }}>
          one password unlocks the keystore
        </div>
      </div>
      {legacyNotice && (
        <div
          style={{
            margin: "0 18px 10px",
            padding: "10px 12px",
            borderRadius: 10,
            background: "rgba(242,180,65,0.08)",
            border: "1px solid rgba(242,180,65,0.4)",
            color: "var(--fg-100)",
            fontSize: 12,
            lineHeight: 1.4,
          }}
        >
          Vault format upgraded — re-import your seed. Your previous keystore
          used PBKDF2+AES-GCM and cannot be unlocked by this build. Create a
          new vault below, or import your existing recovery phrase.
        </div>
      )}
      <div style={{ padding: "0 18px" }}>
        <PasswordField label="Password (8+ chars)" value={password} onChange={setPassword} />
        <PasswordField label="Confirm" value={confirm} onChange={setConfirm} />
        {tooShort && <div style={fieldError}>password must be at least 8 chars</div>}
        {mismatch && <div style={fieldError}>passwords do not match</div>}
        {error && <div style={fieldError}>{error}</div>}
      </div>
      <ReqOnboard />
      <div className="req-foot">
        <button onClick={() => window.close()}>Cancel</button>
        <button
          className="prim"
          disabled={password.length < 8 || password !== confirm}
          onClick={() => onSubmit(password)}
        >
          Create
        </button>
      </div>
    </>
  );
}

interface NewWalletRevealProps {
  seedHex: string;
  address: string;
  onContinue: () => void;
}

function NewWalletReveal({ seedHex, address, onContinue }: NewWalletRevealProps) {
  const [revealed, setRevealed] = useState(false);
  // 32-byte seed ⇒ 64 hex chars. Break into four 16-char chunks so the
  // user can transcribe one row at a time and visually verify each row
  // matches their backup. Strip the 0x prefix if the keystore returned
  // one — the visual is cleaner without it, and the underlying bytes
  // are identical.
  const raw = seedHex.startsWith("0x") || seedHex.startsWith("0X") ? seedHex.slice(2) : seedHex;
  const chunks = [raw.slice(0, 16), raw.slice(16, 32), raw.slice(32, 48), raw.slice(48, 64)];
  return (
    <>
      <ChainStatusBanner />
      <div style={{ padding: "20px 18px 8px" }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>Your recovery seed</h2>
        <div style={{ fontFamily: "var(--f-mono)", fontSize: 10, color: "var(--fg-400)", letterSpacing: "0.14em", textTransform: "uppercase", marginTop: 4 }}>
          32-byte ML-DSA-65 seed · write it down · we cannot recover it
        </div>
      </div>
      <div style={{ padding: "0 18px" }}>
        <div style={{
          padding: 12,
          borderRadius: 12,
          background: revealed ? "rgba(124,127,255,0.08)" : "rgba(0,0,0,0.4)",
          border: "1px solid var(--fg-700)",
          minHeight: 96,
          fontFamily: "var(--f-mono)",
          fontSize: 12,
          lineHeight: 1.6,
          color: revealed ? "var(--fg-100)" : "var(--fg-500)",
          cursor: "pointer",
          userSelect: revealed ? "text" : "none",
        }} onClick={() => setRevealed(true)}>
          {revealed
            ? chunks.map((c, i) => (
                <div key={i} style={{ letterSpacing: "0.05em" }}>{c}</div>
              ))
            : "tap to reveal"}
        </div>
        <div style={{ marginTop: 14, fontFamily: "var(--f-mono)", fontSize: 10, color: "var(--fg-400)" }}>
          address: {address}
        </div>
      </div>
      <div className="req-foot">
        <button className="prim" onClick={onContinue}>I have backed it up</button>
      </div>
    </>
  );
}

interface UnlockFormProps {
  address: string;
  error: string | null;
  onSubmit: (password: string) => void;
}

function UnlockForm({ address, error, onSubmit }: UnlockFormProps) {
  const [password, setPassword] = useState("");
  return (
    <>
      <ChainStatusBanner />
      <div style={{ padding: "30px 22px 8px", textAlign: "center" }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Unlock wallet</h2>
        <div style={{ fontFamily: "var(--f-mono)", fontSize: 10, color: "var(--fg-400)", marginTop: 6 }}>
          {address.slice(0, 8)}…{address.slice(-4)}
        </div>
      </div>
      <div style={{ padding: "0 18px" }}>
        <PasswordField label="Password" value={password} onChange={setPassword} />
        {error && <div style={fieldError}>{error}</div>}
      </div>
      <div className="req-foot">
        <button onClick={() => window.close()}>Cancel</button>
        <button className="prim" disabled={password.length === 0} onClick={() => onSubmit(password)}>
          Unlock
        </button>
      </div>
    </>
  );
}

interface ApprovalRouteProps {
  approval: UiApproval;
  keystore: KeystoreStatus | null;
  unlockError: string | null;
  onUnlock: (password: string) => void;
  onApprove: () => void;
  onReject: () => void;
  custody: "tpm" | "passkey" | "hw" | "sw";
}

function ApprovalRoute({
  approval,
  keystore,
  unlockError,
  onUnlock,
  onApprove,
  onReject,
  custody,
}: ApprovalRouteProps) {
  const a = approval.approval;

  // Common preflight: if the wallet is locked, show the unlock form. The
  // approval target (Approve button) only renders once unlocked.
  if (keystore && !keystore.unlocked) {
    return (
      <ReqSheet onBack={onReject}>
        <UnlockForm
          address={keystore.address ?? "—"}
          error={unlockError}
          onSubmit={onUnlock}
        />
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

// ---- shared bits ----

const fieldError: React.CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 10,
  color: "var(--err)",
  marginTop: 4,
};

interface PasswordFieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
}

function PasswordField({ label, value, onChange }: PasswordFieldProps) {
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      <div style={{ fontFamily: "var(--f-mono)", fontSize: 10, color: "var(--fg-400)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}>
        {label}
      </div>
      <input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoFocus
        style={{
          width: "100%",
          padding: "10px 12px",
          borderRadius: 10,
          background: "rgba(0,0,0,0.3)",
          border: "1px solid var(--fg-700)",
          color: "var(--fg-100)",
          fontSize: 13,
          fontFamily: "var(--f-mono)",
        }}
      />
    </label>
  );
}
