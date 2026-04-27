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
  Home, Accounts, Networks, Settings,
  ReqConnect, ReqOnboard,
  ReqSheet, AttStrip, DemoBanner,
  ReqSendTx, ReqPersonalSignReal, ReqTypedSign, ReqAddChain,
} from "./components";
import { ACCOUNTS, NETWORKS, type Account, type Network } from "./demo-data";
import {
  bgListPending,
  bgKeystoreStatus,
  bgKeystoreCreateNew,
  bgKeystoreUnlock,
  bgResolveApproval,
  type PendingApproval,
  type KeystoreStatus,
  type SendTxRequest,
  type PersonalSignRequest,
  type TypedSignRequest,
  type AddChainRequest,
} from "./bg";

type Screen =
  | "loading"
  | "onboard-create"
  | "locked"
  | "home"
  | "accounts"
  | "networks"
  | "settings"
  | "approval";

interface UiApproval {
  approval: PendingApproval;
}

export default function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [keystore, setKeystore] = useState<KeystoreStatus | null>(null);
  const [activeApproval, setActiveApproval] = useState<UiApproval | null>(null);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [generated, setGenerated] = useState<{ mnemonic: string; address: string } | null>(null);

  const initialAccount: Account = ACCOUNTS[0]!;
  const initialNetwork: Network = NETWORKS[1] ?? NETWORKS[0]!;
  const [acc, setAcc] = useState<Account>(initialAccount);
  const [net, setNet] = useState<Network>(initialNetwork);

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
      }
    })();
  }, []);

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

  const handleUnlock = async (password: string) => {
    setUnlockError(null);
    const r = await bgKeystoreUnlock(password);
    if (!r.ok) {
      setUnlockError(r.reason ?? "wrong password");
      return;
    }
    const ks = await bgKeystoreStatus();
    setKeystore(ks);
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
    setGenerated({ mnemonic: r.mnemonic, address: r.address });
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
    screen === "settings";

  return (
    <div className="ext" data-denom={acc.denom}>
      {showBannerStrip && <DemoBanner />}
      {showBannerStrip && <AttStrip />}

      {screen === "loading" && <div className="ext-body" style={{ padding: 24, color: "var(--fg-300)" }}>Loading…</div>}

      {screen === "onboard-create" && (
        <ReqSheet onBack={() => setScreen("loading")}>
          {generated ? (
            <NewWalletReveal
              mnemonic={generated.mnemonic}
              address={generated.address}
              onContinue={() => setScreen("home")}
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
          network={net}
          onOpenAccounts={() => setScreen("accounts")}
          onOpenNetworks={() => setScreen("networks")}
          onSettings={() => setScreen("settings")}
          onOpenRequest={() => {
            /* clicking demo pending shelf in normal home does nothing real */
          }}
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
          current={net}
          onBack={() => setScreen("home")}
          onPick={(n) => { setNet(n); setScreen("home"); }}
        />
      )}

      {screen === "settings" && (
        <Settings onBack={() => setScreen("home")} custody={custody} algo={algo} />
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
      <DemoBanner />
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
  mnemonic: string;
  address: string;
  onContinue: () => void;
}

function NewWalletReveal({ mnemonic, address, onContinue }: NewWalletRevealProps) {
  const [revealed, setRevealed] = useState(false);
  const words = mnemonic.split(" ");
  return (
    <>
      <DemoBanner />
      <div style={{ padding: "20px 18px 8px" }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>Your recovery phrase</h2>
        <div style={{ fontFamily: "var(--f-mono)", fontSize: 10, color: "var(--fg-400)", letterSpacing: "0.14em", textTransform: "uppercase", marginTop: 4 }}>
          write it down · we cannot recover it
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
            ? words.map((w, i) => (
                <span key={i} style={{ marginRight: 8 }}>
                  <span style={{ color: "var(--fg-500)" }}>{i + 1}.</span> {w}
                </span>
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
      <DemoBanner />
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
      <DemoBanner />
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
