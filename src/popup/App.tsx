// Monolythium Wallet popup — screen orchestrator.
// Mirrors the ExtApp pattern from designs/src/ext-app.jsx: one component
// holding screen state, internal navigation, demo data only.

import { useEffect, useState } from "react";
import "./tokens.css";
import "./glass.css";
import "./ext.css";
import {
  Home, Accounts, Networks, Settings,
  ReqConnect, ReqSign, ReqMessage, ReqOnboard,
  ReqSheet, AttStrip, DemoBanner,
} from "./components";
import { ACCOUNTS, NETWORKS, type PendingSign, type Account, type Network } from "./demo-data";

type Screen =
  | "home"
  | "accounts"
  | "networks"
  | "settings"
  | "onboard"
  | "req-connect"
  | "req-sign"
  | "req-message";

export default function App() {
  const [screen, setScreen] = useState<Screen>("home");
  const [signType, setSignType] = useState<PendingSign["type"]>("swap");
  const initialAccount: Account = ACCOUNTS[0]!;
  const initialNetwork: Network = NETWORKS[1] ?? NETWORKS[0]!;
  const [acc, setAcc] = useState<Account>(initialAccount);
  const [net, setNet] = useState<Network>(initialNetwork);

  // Re-skin popup background per active denom (matches designs/src/ext-app.jsx).
  useEffect(() => {
    const root = document.querySelector(".ext");
    if (!root) return;
    root.setAttribute("data-denom", acc.denom);
    return () => {
      root.removeAttribute("data-denom");
    };
  }, [acc.denom]);

  // TODO(monolythium-vision): pull custody + algo from background keystore once it lands.
  const custody = "tpm" as const;
  const algo = "slhdsa" as const;

  const onResolve = () => {
    // TODO(monolythium-vision): post EIP-1193 response back through the bridge.
    setScreen("home");
  };

  const openRequest = (id: "connect" | "sign" | "message", t?: PendingSign["type"]) => {
    if (id === "connect") setScreen("req-connect");
    else if (id === "sign") {
      if (t) setSignType(t);
      setScreen("req-sign");
    } else if (id === "message") setScreen("req-message");
  };

  // Home / accounts / networks / settings get the banner+attest strip up top.
  // Request dialogs render their own (matches designs/src/ext-app.jsx).
  const showBannerStrip =
    screen === "home" ||
    screen === "accounts" ||
    screen === "networks" ||
    screen === "settings";

  return (
    <div className="ext" data-denom={acc.denom}>
      {showBannerStrip && <DemoBanner />}
      {showBannerStrip && <AttStrip />}
      {screen === "home" && (
        <Home
          account={acc}
          network={net}
          onOpenAccounts={() => setScreen("accounts")}
          onOpenNetworks={() => setScreen("networks")}
          onSettings={() => setScreen("settings")}
          onOpenRequest={openRequest}
          onOpenOnboard={() => setScreen("onboard")}
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
      {screen === "onboard" && (
        <ReqSheet onBack={() => setScreen("home")}>
          <ReqOnboard />
        </ReqSheet>
      )}
      {screen === "req-connect" && (
        <ReqSheet onBack={() => setScreen("home")}>
          <ReqConnect custody={custody} onApprove={onResolve} onReject={() => setScreen("home")} />
        </ReqSheet>
      )}
      {screen === "req-sign" && (
        <ReqSheet
          onBack={() => setScreen("home")}
          type={signType}
          showTypeTabs
          onChangeSignType={setSignType}
        >
          <ReqSign type={signType} custody={custody} algo={algo} onApprove={onResolve} onReject={() => setScreen("home")} />
        </ReqSheet>
      )}
      {screen === "req-message" && (
        <ReqSheet onBack={() => setScreen("home")}>
          <ReqMessage custody={custody} onApprove={onResolve} onReject={() => setScreen("home")} />
        </ReqSheet>
      )}
    </div>
  );
}
