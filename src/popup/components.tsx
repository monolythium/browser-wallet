// Component port from designs/src/ext-popup.jsx + ext-app.jsx + ext-requests.jsx.
// Surface-only. No keystore, no RPC, no signing here. The home / accounts /
// networks / settings views still source mock data from `demo-data` because
// the chain-side reads they need (balances, asset prices, activity log) are
// not in the SDK yet — see `TODO(monolythium-vision)` markers below.
//
// Approval views (ReqSendTx, ReqPersonalSignReal, ReqTypedSign, ReqAddChain)
// at the bottom of this file render REAL payloads passed in by the service
// worker. No demo-data is read on the approval path.

import type { ReactNode, CSSProperties } from "react";
import { useState } from "react";
import { Icon, Spark, fmt, shortAddr } from "./Icon";
import type { IconName } from "./Icon";
import {
  ACCOUNTS, ASSETS, NETWORKS, DAPPS, ACTIVITY, PENDING, NODE,
} from "./demo-data";
import type {
  Account, Network, Custody, Algo, PendingSign,
} from "./demo-data";
import type {
  PersonalSignRequest,
  TypedSignRequest,
  SendTxRequest,
  AddChainRequest,
} from "./bg";

// ---- Attestation strip (top-of-popup chromatic halo of node attestation) ----
export function AttStrip() {
  return (
    <div className="ext-att">
      <span className="state"><span className="dot" />ATTESTED</span>
      <span className="sep">·</span>
      <span className="k">node</span> <span className="v">{NODE.handle}</span>
      <span className="sep">·</span>
      <span className="k">DAC</span> <span className="v">{(NODE.dacCoverage * 100).toFixed(0)}%</span>
      <span className="sep">·</span>
      <span className="k">round</span> <span className="v">{NODE.round}</span>
    </div>
  );
}

export function DemoBanner() {
  return (
    <div className="ext-demo-banner">
      <Icon name="warn" size={10} /> Mock · no real value · design-only
    </div>
  );
}

// ---- Top row: brand + account + network + settings ----
interface TopProps {
  account: Account;
  network: Network;
  onOpenAccounts: () => void;
  onOpenNetworks: () => void;
  onSettings: () => void;
}

export function Top({ account, network, onOpenAccounts, onOpenNetworks, onSettings }: TopProps) {
  const isTestnet = network.id === "testnet";
  const netLabel = network.id === "mainnet" ? "Mainnet" : isTestnet ? "Testnet" : "Local";
  return (
    <div className="ext-top">
      <span className="ext-brand" />
      <div className="ext-acc" onClick={onOpenAccounts}>
        <div className={`ext-acc__blob ${account.denom}`} />
        <div className="ext-acc__lbl">
          <div className="n">{account.label}</div>
          <div className="a">{shortAddr(account.addr)}</div>
        </div>
        <span className="ext-acc__chev"><Icon name="chev-d" size={14} /></span>
      </div>
      <button className={`ext-net ${isTestnet ? "test" : ""}`} onClick={onOpenNetworks}>
        <span className="dot" />{netLabel}
        <Icon name="chev-d" size={10} />
      </button>
      <button className="ext-iconbtn" onClick={onSettings}><Icon name="settings" size={16} /></button>
    </div>
  );
}

// ---- Asset list ----
function AssetList() {
  return (
    <div>
      {ASSETS.map((a, i) => {
        const cls = a.sym === "LYTH-p" ? "priv"
          : a.sym === "USDC" ? "usdc"
          : a.bridged ? "w"
          : a.sym === "LYTH" && !a.bridged ? "native"
          : "";
        const gly = a.sym === "LYTH-p" ? "Ⓜ"
          : a.sym === "USDC" ? "$"
          : a.sym === "wLYTH" ? "w"
          : a.sym.slice(0, 3).toUpperCase();
        return (
          <div className="ext-asset" key={i}>
            <div className={`ext-asset__ico ${cls}`}>{gly}</div>
            <div className="ext-asset__main">
              <div className="sym">
                {a.sym}{" "}
                {a.attested && <span className="ext-badge-att">Att</span>}
                {a.bridged && <span className="ext-badge-bridged">Bridge</span>}
              </div>
              <div className="chain">{a.label} · {a.chain}</div>
            </div>
            <div className="ext-asset__spark">
              {a.spark && <Spark data={a.spark} down={(a.change ?? 0) < 0} />}
            </div>
            <div className="ext-asset__right">
              {a.opaque
                ? <div className="opaque">hidden</div>
                : <div className="amt">{fmt(a.amount, 2)}</div>}
              {a.change != null && (
                <div className={`chg ${a.change < 0 ? "down" : ""}`}>
                  {a.change > 0 ? "+" : ""}{a.change}%
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---- Activity list ----
function ActivityList() {
  return (
    <div>
      {ACTIVITY.map((t) => (
        <div className="ext-act-row" key={t.id}>
          <div className={`dir ${t.dir}`}><Icon name={t.dir === "in" ? "receive" : "send"} size={13} /></div>
          <div className="ext-act-row__main">
            <div className="ext-act-row__who">{t.who}</div>
            <div className="ext-act-row__meta">
              <span>{t.when}</span>
              <span>·</span>
              <span>{t.round}</span>
              <span style={{ color: t.attest === "attested" ? "var(--ok)" : "var(--warn)" }}>
                ● {t.attest === "attested" ? "Att" : "Q " + t.attest.split("-")[1]}
              </span>
              {t.dapp && <><span>·</span><span style={{ color: "var(--fg-200)" }}>{DAPPS.find((d) => d.id === t.dapp)?.name}</span></>}
            </div>
          </div>
          <div className="ext-act-row__right">
            {t.opaque
              ? <div className="amt opaque">hidden</div>
              : <div className={`amt ${t.dir === "in" ? "in" : ""}`}>{t.dir === "in" ? "+" : "−"}{fmt(t.amount)}</div>}
            <div className="sym">{t.sym}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---- Pending requests shelf ----
interface PendingShelfProps {
  onOpen: (id: "connect" | "sign" | "message") => void;
}

function PendingShelf({ onOpen }: PendingShelfProps) {
  const items: Array<{ id: "connect" | "sign" | "message"; title: string; hint: string; icon: string }> = [
    { id: "connect", title: "Connect · Coinzen DEX", hint: "3 permissions", icon: "C" },
    { id: "sign", title: "Sign · swap 500 LYTH → USDC", hint: "simulated", icon: "C" },
    { id: "message", title: "Sign-in · gov.monolythium.xyz", hint: "no value", icon: "G" },
  ];
  return (
    <div className="ext-card" style={{ marginTop: 6 }}>
      <div className="ext-card__head">
        <h3>Pending requests</h3>
        <div className="spacer" />
        <span style={{ fontFamily: "var(--f-mono)", fontSize: 10, color: "var(--fg-500)", letterSpacing: "0.08em", textTransform: "uppercase" }}>{items.length} open</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {items.map((it) => (
          <button
            key={it.id}
            onClick={() => onOpen(it.id)}
            style={{
              width: "100%",
              display: "grid",
              gridTemplateColumns: "28px 1fr auto",
              gap: 10,
              alignItems: "center",
              padding: "9px 10px",
              borderRadius: 10,
              background: "rgba(255,255,255,0.03)",
              border: "1px solid var(--fg-700)",
              color: "inherit",
              cursor: "pointer",
              fontFamily: "inherit",
              textAlign: "left",
            }}
          >
            <div style={{ width: 28, height: 28, borderRadius: 7, fontSize: 12, display: "grid", placeItems: "center", fontFamily: "var(--f-mono)", fontWeight: 700, color: "#fff", background: it.icon === "G" ? "linear-gradient(135deg, #3a6fa5, #1c3a5a)" : "linear-gradient(135deg, #8a3fa5, #4a1f5a)" }}>
              {it.icon}
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 500, color: "var(--fg-100)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.title}</div>
              <div style={{ fontFamily: "var(--f-mono)", fontSize: 10, color: "var(--fg-400)", marginTop: 2, letterSpacing: "0.02em" }}>{it.hint}</div>
            </div>
            <Icon name="chev" size={12} />
          </button>
        ))}
      </div>
    </div>
  );
}

// ---- Home screen ----
interface HomeProps {
  account: Account;
  network: Network;
  onOpenAccounts: () => void;
  onOpenNetworks: () => void;
  onSettings: () => void;
  onOpenRequest: (id: "connect" | "sign" | "message", signType?: PendingSign["type"]) => void;
  onOpenOnboard: () => void;
}

export function Home({ account, network, onOpenAccounts, onOpenNetworks, onSettings, onOpenRequest, onOpenOnboard }: HomeProps) {
  const [tab, setTab] = useState<"assets" | "activity">("assets");
  const isPriv = account.denom === "private";
  const balanceStr = account.balance != null ? fmt(account.balance, 2) : "0.00";
  const [intPart, fracPart] = balanceStr.split(".");

  return (
    <>
      <Top
        account={account}
        network={network}
        onOpenAccounts={onOpenAccounts}
        onOpenNetworks={onOpenNetworks}
        onSettings={onSettings}
      />
      <div className="ext-body">
        {/* Hero */}
        <div className="ext-card ext-hero">
          <div className="lbl">{isPriv ? "Private balance · LYTH-p" : "Available · LYTH"}</div>
          {isPriv ? (
            <div className="num opaque">— amount hidden by design</div>
          ) : (
            <div className="num">
              {intPart}
              <span className="frac">.{fracPart ?? "00"}</span>
              <span className="d">LYTH</span>
            </div>
          )}
          {!isPriv && <div className="chg">+0.82% · 24h · attested</div>}
          {isPriv && (
            <div className="chg" style={{ color: "oklch(0.78 0.14 240)" }}>
              {account.envelopes ?? 0} envelopes · 30d · DAC 100%
            </div>
          )}

          <div className="ext-hero-acts">
            <button className="ext-act prim" onClick={() => onOpenRequest("sign", "swap")}>
              <span className="ico"><Icon name="send" size={16} /></span>
              <span>Send</span>
            </button>
            <button className="ext-act" onClick={onOpenAccounts}>
              <span className="ico"><Icon name="receive" size={16} /></span>
              <span>Receive</span>
            </button>
            <button className="ext-act" onClick={() => onOpenRequest("sign", "stake")}>
              <span className="ico"><Icon name="stake" size={16} /></span>
              <span>Stake</span>
            </button>
            <button className="ext-act" onClick={() => onOpenRequest("sign", "bridge")}>
              <span className="ico"><Icon name="bridge" size={16} /></span>
              <span>Bridge</span>
            </button>
          </div>
        </div>

        {/* Pending requests shelf */}
        <PendingShelf onOpen={(id) => onOpenRequest(id)} />

        {/* Recent dApps */}
        <div className="ext-card">
          <div className="ext-card__head">
            <h3>Recent dApps</h3>
            <div className="spacer" />
            <button className="more" onClick={onSettings}>Manage →</button>
          </div>
          <div className="ext-dapp-row">
            {DAPPS.slice(0, 4).map((d) => (
              <div key={d.id} className="ext-dapp" onClick={() => onOpenRequest("connect")}>
                <div className={`glyph ${d.icon}`}>{d.icon}</div>
                <div className="nm">{d.name}</div>
                <div className="last">{d.lastUsed}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Tabs */}
        <div className="ext-card">
          <div className="ext-tabs">
            <button className={tab === "assets" ? "on" : ""} onClick={() => setTab("assets")}>Assets</button>
            <button className={tab === "activity" ? "on" : ""} onClick={() => setTab("activity")}>Activity</button>
          </div>
          {tab === "assets" ? <AssetList /> : <ActivityList />}
        </div>

        {/* First-run onboarding link */}
        <button
          onClick={onOpenOnboard}
          style={{
            width: "100%",
            padding: "10px 12px",
            marginTop: 4,
            background: "transparent",
            border: "1px dashed var(--fg-700)",
            borderRadius: 10,
            fontFamily: "var(--f-mono)",
            fontSize: 10,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--fg-500)",
            cursor: "pointer",
          }}
        >
          view first-run onboarding
        </button>
      </div>
      <div className="ext-hintbar">
        <span>v0.0.1 · {NODE.talos}</span>
        <span><kbd>⌘⇧M</kbd> open</span>
      </div>
    </>
  );
}

// ---- Accounts picker ----
interface AccountsProps {
  current: Account;
  onBack: () => void;
  onPick: (a: Account) => void;
}

export function Accounts({ current, onBack, onPick }: AccountsProps) {
  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack}><Icon name="back" size={15} /></button>
        <div style={{ flex: 1, fontSize: 13, fontWeight: 600, textAlign: "center" }}>Accounts</div>
        <button className="ext-iconbtn"><Icon name="plus" size={15} /></button>
      </div>
      <div className="ext-body">
        <div className="ext-card" style={{ padding: "6px 10px" }}>
          {ACCOUNTS.map((a) => (
            <div
              key={a.id}
              className="ext-asset"
              onClick={() => onPick(a)}
              style={{ position: "relative", cursor: "pointer" }}
            >
              <div className={`ext-asset__ico ${a.denom === "private" ? "priv" : "native"}`}>
                {a.label.slice(0, 1).toUpperCase()}
              </div>
              <div className="ext-asset__main">
                <div className="sym">
                  {a.label}{" "}
                  {a.custody === "hw" && (
                    <span
                      className="ext-badge-att"
                      style={{ background: "rgba(88,160,220,0.14)", color: "#78b0dc", borderColor: "rgba(88,160,220,0.3)" }}
                    >
                      <Icon name="hw" size={8} /> Ledger
                    </span>
                  )}
                </div>
                <div className="chain">{shortAddr(a.addr, 18)} · {a.denom} · {a.algo === "slhdsa" ? "SLH-DSA" : "ML-DSA"}</div>
              </div>
              <div className="ext-asset__right">
                {a.balance == null
                  ? <div className="opaque">hidden</div>
                  : <div className="amt">{fmt(a.balance, 0)}</div>}
                <div className="sym" style={{ color: "var(--fg-400)", fontFamily: "var(--f-mono)", fontSize: 9, marginTop: 2 }}>
                  {a.denom === "private" ? "LYTH-p" : "LYTH"}
                </div>
              </div>
              {a.id === current.id && (
                <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", color: "var(--gold)" }}>
                  <Icon name="check" size={14} />
                </span>
              )}
            </div>
          ))}
        </div>
        <button className="ext-act" style={{ width: "100%", padding: "10px", flexDirection: "row", gap: 8 }}>
          <Icon name="plus" size={13} /> Import or create
        </button>
      </div>
    </>
  );
}

// ---- Networks picker ----
interface NetworksProps {
  current: Network;
  onBack: () => void;
  onPick: (n: Network) => void;
}

export function Networks({ current, onBack, onPick }: NetworksProps) {
  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack}><Icon name="back" size={15} /></button>
        <div style={{ flex: 1, fontSize: 13, fontWeight: 600, textAlign: "center" }}>Networks</div>
        <button className="ext-iconbtn"><Icon name="plus" size={15} /></button>
      </div>
      <div className="ext-body">
        <div className="ext-card" style={{ padding: "6px 10px" }}>
          {NETWORKS.map((n) => {
            const active = n.id === current.id;
            return (
              <div
                key={n.id}
                onClick={() => onPick(n)}
                style={{
                  padding: "12px 6px",
                  borderRadius: 10,
                  marginBottom: 2,
                  background: active ? "var(--gold-bg)" : "transparent",
                  border: active ? "1px solid rgba(124,127,255,0.35)" : "1px solid transparent",
                  cursor: "pointer",
                  boxShadow: active ? "0 0 12px rgba(124,127,255,0.1)" : "none",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500, display: "flex", alignItems: "center", gap: 6 }}>
                      {n.label}
                      {n.official && (
                        <span className="ext-badge-att" style={{ fontSize: 8 }}>
                          <Icon name="shield" size={8} /> Official
                        </span>
                      )}
                    </div>
                    <div style={{ fontFamily: "var(--f-mono)", fontSize: 10, color: "var(--fg-400)", marginTop: 3, letterSpacing: "0.02em" }}>{n.rpc}</div>
                  </div>
                  <div style={{ textAlign: "right", fontFamily: "var(--f-mono)", fontSize: 10 }}>
                    <div style={{ color: n.status === "live" ? "var(--ok)" : "var(--err)" }}>● {n.status}</div>
                    <div style={{ color: "var(--fg-400)", marginTop: 2 }}>chain {n.chainId}</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

// ---- Settings ----
interface SettingsProps {
  onBack: () => void;
  custody: Custody;
  algo: Algo;
}

export function Settings({ onBack, custody, algo }: SettingsProps) {
  const modes: Array<{ k: Custody; ico: IconName; t: string; d: string }> = [
    { k: "tpm", ico: "tpm", t: "TPM · sealed", d: "Hardware-bound on this machine" },
    { k: "passkey", ico: "passkey", t: "Platform passkey", d: "Touch ID / Windows Hello" },
    { k: "hw", ico: "hw", t: "Ledger · external", d: "Confirm on device for every sign" },
    { k: "sw", ico: "lock", t: "Software · at rest", d: "Encrypted keystore (dev only)" },
  ];

  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack}><Icon name="back" size={15} /></button>
        <div style={{ flex: 1, fontSize: 13, fontWeight: 600, textAlign: "center" }}>Settings</div>
        <div style={{ width: 36 }} />
      </div>
      <div className="ext-body">
        <div className="ext-card">
          <div className="ext-card__head"><h3>Key custody</h3></div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {modes.map((m) => {
              const active = m.k === custody;
              return (
                <div
                  key={m.k}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "10px 8px",
                    borderRadius: 8,
                    background: active ? "var(--gold-bg)" : "transparent",
                    border: active ? "1px solid rgba(124,127,255,0.35)" : "1px solid transparent",
                  }}
                >
                  <span
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 8,
                      background: "rgba(255,255,255,0.05)",
                      border: "1px solid var(--fg-700)",
                      display: "grid",
                      placeItems: "center",
                      color: active ? "var(--gold)" : "var(--fg-300)",
                    }}
                  >
                    <Icon name={m.ico} size={13} />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 500, color: "var(--fg-100)" }}>{m.t}</div>
                    <div style={{ fontFamily: "var(--f-mono)", fontSize: 10, color: "var(--fg-400)", marginTop: 2 }}>{m.d}</div>
                  </div>
                  {active && <span style={{ color: "var(--gold)" }}><Icon name="check" size={14} /></span>}
                </div>
              );
            })}
          </div>
        </div>

        <div className="ext-card">
          <div className="ext-card__head"><h3>Signing algorithm</h3></div>
          <div style={{ fontFamily: "var(--f-mono)", fontSize: 11, color: "var(--fg-300)", lineHeight: 1.5, marginBottom: 10 }}>
            Requests are signed using:{" "}
            <span style={{ color: "var(--gold)" }}>
              {algo === "slhdsa" ? "SLH-DSA-128s" : "ML-DSA-65"}
            </span>
            . Override per-request on the signing screen.
          </div>
        </div>

        <div className="ext-card">
          <div className="ext-card__head"><h3>Advanced</h3></div>
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {["Export recovery shares", "Revoke dApp session", "Reset node trust", "View attestation log"].map((t, i) => (
              <button
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  padding: "12px 4px",
                  background: "transparent",
                  border: 0,
                  color: "var(--fg-200)",
                  fontSize: 12.5,
                  cursor: "pointer",
                  borderBottom: i < 3 ? "1px solid rgba(255,255,255,0.04)" : "none",
                  width: "100%",
                  textAlign: "left",
                }}
              >
                <span style={{ flex: 1 }}>{t}</span>
                <Icon name="chev" size={12} />
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

// ---- Sheet wrapper for request dialogs ----
interface ReqSheetProps {
  onBack: () => void;
  children: ReactNode;
  type?: PendingSign["type"];
  showTypeTabs?: boolean;
  onChangeSignType?: (t: PendingSign["type"]) => void;
}

function ReqSheet({ onBack, children, type, showTypeTabs, onChangeSignType }: ReqSheetProps) {
  const types: PendingSign["type"][] = ["swap", "stake", "vote", "bridge", "contract"];
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px 0" }}>
        <button className="ext-iconbtn" onClick={onBack} title="back to popup">
          <Icon name="back" size={14} />
        </button>
        <div style={{ fontFamily: "var(--f-mono)", fontSize: 10, color: "var(--fg-400)", letterSpacing: "0.14em", textTransform: "uppercase" }}>
          Incoming request
        </div>
      </div>
      {showTypeTabs && onChangeSignType && (
        <div style={{ display: "flex", gap: 4, padding: "6px 14px 0", flexWrap: "wrap" }}>
          {types.map((t) => (
            <button
              key={t}
              onClick={() => onChangeSignType(t)}
              style={{
                padding: "4px 10px",
                borderRadius: 999,
                fontSize: 10,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                fontFamily: "var(--f-mono)",
                background: t === type ? "var(--gold-bg)" : "transparent",
                color: t === type ? "var(--gold)" : "var(--fg-400)",
                border: t === type ? "1px solid rgba(124,127,255,0.4)" : "1px solid var(--fg-700)",
                cursor: "pointer",
              }}
            >
              {t}
            </button>
          ))}
        </div>
      )}
      <div style={{ flex: 1, overflowY: "auto" }}>{children}</div>
    </>
  );
}

// ---- Custody badge ----
function CustodyBadge({ mode }: { mode: Custody }) {
  const labels: Record<Custody, { ico: IconName; lbl: string; cls: string }> = {
    tpm: { ico: "tpm", lbl: "TPM · sealed", cls: "" },
    hw: { ico: "hw", lbl: "Ledger Nano X", cls: "hw" },
    passkey: { ico: "passkey", lbl: "Platform passkey", cls: "" },
    sw: { ico: "lock", lbl: "Software · at rest", cls: "" },
  };
  const m = labels[mode];
  return (
    <div className="req-custody">
      <span className={`glyph ${m.cls}`}><Icon name={m.ico} size={12} /></span>
      <span>Signing with</span><b>{m.lbl}</b>
    </div>
  );
}

// ---- Algo picker ----
function AlgoPicker({ value, onChange }: { value: Algo; onChange: (a: Algo) => void }) {
  return (
    <div className="req-algo">
      <button className={value === "slhdsa" ? "on" : ""} onClick={() => onChange("slhdsa")}>
        <div className="n">SLH-DSA-128s</div>
        <div className="d">Hash-based · stateless · no assumptions</div>
      </button>
      <button className={value === "mldsa" ? "on" : ""} onClick={() => onChange("mldsa")}>
        <div className="n">ML-DSA-65</div>
        <div className="d">Lattice · faster · smaller</div>
      </button>
    </div>
  );
}

// ---- Connect request ----
interface ReqConnectProps {
  custody: Custody;
  onApprove: () => void;
  onReject: () => void;
}

export function ReqConnect({ custody, onApprove, onReject }: ReqConnectProps) {
  const r = PENDING.connect;
  const dapp = DAPPS.find((d) => d.id === r.dappId)!;
  const acc = ACCOUNTS.find((a) => a.id === r.accountToShare)!;
  return (
    <>
      <DemoBanner />
      <AttStrip />
      <div className="req-head">
        <div className="origin">
          <div className={`fav ${dapp.icon}`}>{dapp.icon}</div>
          <div className="info">
            <div className="n">
              {dapp.name}{" "}
              {dapp.verified
                ? <span className="ext-badge-att"><Icon name="shield" size={8} /> Verified</span>
                : <span style={{ color: "var(--warn)", fontSize: 9, fontFamily: "var(--f-mono)", letterSpacing: "0.08em", textTransform: "uppercase" }}>Unverified</span>}
            </div>
            <div className="u">{r.origin}</div>
          </div>
        </div>
        <h2>Connect to {dapp.name}?</h2>
        <div className="sub">requesting · {r.perms.length} permissions</div>
      </div>

      {!dapp.verified && (
        <div className="req-warn warn">
          <Icon name="warn" size={14} />
          <div><b>Origin not in LYTH registry.</b> Phishing score {(r.phishingScore * 100).toFixed(0)}/100 · verify the URL.</div>
        </div>
      )}

      <div className="req-section">
        <div className="req-section__h">Account to share</div>
        <div className="ext-acc" style={{ cursor: "default" }}>
          <div className={`ext-acc__blob ${acc.denom}`} />
          <div className="ext-acc__lbl">
            <div className="n">{acc.label}</div>
            <div className="a">{shortAddr(acc.addr, 18)}</div>
          </div>
          <span style={{ color: "var(--gold)", fontSize: 10, fontFamily: "var(--f-mono)", letterSpacing: "0.08em" }}>PUBLIC · LYTH</span>
        </div>
      </div>

      <div className="req-section">
        <div className="req-section__h">This dApp will be able to</div>
        {r.perms.map((p) => (
          <div className="req-perm" key={p.k}>
            <span className={`icobox ${p.k.startsWith("read") ? "read" : ""}`}>
              <Icon name={p.k.startsWith("read") ? "eye" : "lock"} size={11} />
            </span>
            <div className="main">
              <div className="k">{p.desc}</div>
              <div className="d">{p.k}</div>
            </div>
            <span className="req-req">{p.required ? "required" : "optional"}</span>
          </div>
        ))}
      </div>

      <CustodyBadge mode={custody} />
      <div className="req-foot">
        <button onClick={onReject}>Reject</button>
        <button className="prim" onClick={onApprove}>Connect</button>
      </div>
    </>
  );
}

// ---- Sign request ----
interface ReqSignProps {
  type: PendingSign["type"];
  custody: Custody;
  algo: Algo;
  onApprove: () => void;
  onReject: () => void;
}

interface SwapSummary { pay: { amount: number; sym: string }; receive: { amount: number; sym: string }; rate: string; slippage: string; route: string }
interface StakeSummary { action: string; amount: { amount: number; sym: string }; target: string; apr: string; autoCompound: boolean; unlockEst: string }
interface VoteSummary { proposal: string; title: string; choice: string; weight: string }
interface BridgeSummary { action: string; amount: { amount: number; sym: string }; from: string; to: string; receive: { amount: number; sym: string }; rate: string; relays: string; etaMin: number }
interface ContractSummary { action: string; token: string; spender: string; risk: string }

export function ReqSign({ type, custody, algo: initAlgo, onApprove, onReject }: ReqSignProps) {
  const key = type === "swap" ? "signSwap"
    : type === "stake" ? "signStake"
    : type === "vote" ? "signVote"
    : type === "bridge" ? "signBridge"
    : "signContract";
  const r = PENDING[key as "signSwap" | "signStake" | "signVote" | "signBridge" | "signContract"];
  const [algo, setAlgo] = useState<Algo>(initAlgo || r.algo);
  const [showDecoded, setShowDecoded] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const dapp = DAPPS.find((d) => d.id === r.dappId)!;

  return (
    <>
      <DemoBanner />
      <AttStrip />
      <div className="req-head">
        <div className="origin">
          <div className={`fav ${dapp.icon}`}>{dapp.icon}</div>
          <div className="info">
            <div className="n">{dapp.name}</div>
            <div className="u">{r.origin}</div>
          </div>
          <div style={{ fontFamily: "var(--f-mono)", fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--gold)", padding: "3px 7px", border: "1px solid rgba(124,127,255,0.4)", borderRadius: 4 }}>{r.type}</div>
        </div>
      </div>

      {/* Per-type summary */}
      {type === "swap" && (() => {
        const s = r.summary as unknown as SwapSummary;
        return (
          <div className="req-sum">
            <div className="req-sum__action">Swap</div>
            <div className="req-sum__amt">{fmt(s.pay.amount, 0)}<span className="sym">{s.pay.sym}</span></div>
            <div style={{ fontFamily: "var(--f-mono)", fontSize: 14, color: "var(--fg-400)", margin: "4px 0 2px" }}>→</div>
            <div className="req-sum__amt" style={{ fontSize: 26 }}>{fmt(s.receive.amount)}<span className="sym" style={{ color: "var(--ok)" }}>{s.receive.sym}</span></div>
            <div className="req-sum__meta">rate {s.rate} · slippage {s.slippage} · via {s.route}</div>
          </div>
        );
      })()}
      {type === "stake" && (() => {
        const s = r.summary as unknown as StakeSummary;
        return (
          <div className="req-sum">
            <div className="req-sum__action">Delegate</div>
            <div className="req-sum__amt">{fmt(s.amount.amount, 0)}<span className="sym">{s.amount.sym}</span></div>
            <div className="req-sum__meta">→ {s.target} · APR {s.apr}{s.autoCompound ? " · auto" : ""}</div>
            <div style={{ fontFamily: "var(--f-mono)", fontSize: 10, color: "var(--fg-500)", marginTop: 4 }}>unlock est · {s.unlockEst}</div>
          </div>
        );
      })()}
      {type === "vote" && (() => {
        const s = r.summary as unknown as VoteSummary;
        return (
          <div className="req-sum">
            <div className="req-sum__action">Cast vote · {s.proposal}</div>
            <div style={{ fontSize: 14, fontWeight: 500, padding: "8px 14px", lineHeight: 1.4, marginTop: 4 }}>{s.title}</div>
            <div className="req-sum__amt" style={{ fontSize: 28, marginTop: 6 }}>
              <span style={{ color: "var(--ok)", fontFamily: "var(--f-mono)", letterSpacing: "0.08em" }}>{s.choice}</span>
            </div>
            <div className="req-sum__meta">weight · {s.weight}</div>
          </div>
        );
      })()}
      {type === "bridge" && (() => {
        const s = r.summary as unknown as BridgeSummary;
        return (
          <div className="req-sum">
            <div className="req-sum__action">Bridge out · {s.from} → {s.to}</div>
            <div className="req-sum__amt">{fmt(s.amount.amount, 0)}<span className="sym">{s.amount.sym}</span></div>
            <div style={{ fontFamily: "var(--f-mono)", fontSize: 14, color: "var(--fg-400)", margin: "4px 0 2px" }}>→</div>
            <div className="req-sum__amt" style={{ fontSize: 26 }}>{fmt(s.receive.amount, 0)}<span className="sym" style={{ color: "#c08ad6" }}>{s.receive.sym}</span></div>
            <div className="req-sum__meta">rate {s.rate} · {s.relays} · ETA ~{s.etaMin}m</div>
          </div>
        );
      })()}
      {type === "contract" && (() => {
        const s = r.summary as unknown as ContractSummary;
        return (
          <div className="req-sum">
            <div className="req-sum__action" style={{ color: "var(--warn)" }}>⚠ Contract approval</div>
            <div style={{ fontSize: 14, fontWeight: 500, padding: "8px 14px", lineHeight: 1.4, marginTop: 4 }}>{s.action}</div>
            <div className="req-sum__meta">token · {s.token} · spender {s.spender}</div>
          </div>
        );
      })()}

      {r.sim && r.sim.warnings && r.sim.warnings.length > 0 && r.sim.warnings.map((w, i) => (
        <div className="req-warn warn" key={i}><Icon name="warn" size={14} /><div>{w}</div></div>
      ))}

      {r.sim && (
        <div className="req-section">
          <div className="req-sim">
            <div className="req-sim__h"><Icon name="check" size={10} /> Simulation</div>
            {r.sim.willReceive && <div className="req-sim__row"><span className="k">You receive</span><span className="v in">+{fmt(r.sim.willReceive.amount)} {r.sim.willReceive.sym}</span></div>}
            {r.sim.willPay && <div className="req-sim__row"><span className="k">You pay</span><span className="v out">−{fmt(r.sim.willPay.amount)} {r.sim.willPay.sym}</span></div>}
            {r.sim.net && <div className="req-sim__row"><span className="k">Net</span><span className="v">{r.sim.net}</span></div>}
          </div>
        </div>
      )}

      <div className="req-section">
        <div className="req-section__h">
          Fee
          <span style={{ color: "var(--fg-200)", fontFamily: "var(--f-mono)", fontSize: 11, letterSpacing: "0.04em", textTransform: "none" }}>
            {fmt(r.fee.amount, 4)} {r.fee.sym} · public gas
          </span>
        </div>
      </div>

      <div className="req-section">
        <div className="req-section__h">Signing algorithm</div>
        <AlgoPicker value={algo} onChange={setAlgo} />
      </div>

      <div className="req-section">
        <div className="req-section__h">
          <span>Structured decode</span>
          <button onClick={() => setShowDecoded((v) => !v)}>{showDecoded ? "hide" : "show"} ↓</button>
        </div>
        {showDecoded && (
          <div>
            {r.decoded.map((d, i) => (
              <div className="req-kv" key={i}>
                <span className="k">{d.k}</span>
                <span className="v">{d.v}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="req-section" style={{ paddingBottom: 16 }}>
        <div className="req-section__h">
          <span>Raw payload</span>
          <button onClick={() => setShowRaw((v) => !v)}>{showRaw ? "hide" : "show"} ↓</button>
        </div>
        {showRaw && <div className="req-raw">{r.raw}</div>}
      </div>

      <CustodyBadge mode={custody} />
      <div className="req-foot">
        <button onClick={onReject}>Reject</button>
        <button className={type === "contract" ? "danger" : "prim"} onClick={onApprove}>
          {type === "contract" ? "Approve spend" : custody === "hw" ? "Confirm on device" : custody === "passkey" ? "Sign with passkey" : "Sign"}
        </button>
      </div>
    </>
  );
}

// ---- Message sign ----
export function ReqMessage({ custody, onApprove, onReject }: { custody: Custody; onApprove: () => void; onReject: () => void }) {
  const r = PENDING.signMessage;
  const [showRaw, setShowRaw] = useState(false);
  const dapp = DAPPS.find((d) => d.id === r.dappId)!;
  return (
    <>
      <DemoBanner />
      <AttStrip />
      <div className="req-head">
        <div className="origin">
          <div className={`fav ${dapp.icon}`}>{dapp.icon}</div>
          <div className="info">
            <div className="n">{dapp.name}</div>
            <div className="u">{r.origin}</div>
          </div>
          <div style={{ fontFamily: "var(--f-mono)", fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--fg-200)", padding: "3px 7px", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4 }}>message</div>
        </div>
        <h2>{r.summary.purpose}</h2>
        <div className="sub">no value transferred · expires in {r.summary.expires}</div>
      </div>

      <div className="req-section">
        <div className="req-section__h">Payload (human-readable)</div>
        <div style={{ padding: "10px 12px", borderRadius: 10, background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.05)" }}>
          <div className="req-kv"><span className="k">Domain</span><span className="v">{r.humanPayload.domain}</span></div>
          <div className="req-kv"><span className="k">Nonce</span><span className="v">{r.humanPayload.nonce}</span></div>
          <div className="req-kv"><span className="k">Issued at</span><span className="v">{r.humanPayload.issuedAt}</span></div>
          <div className="req-kv"><span className="k">Expires</span><span className="v">{r.humanPayload.expiresAt}</span></div>
          <div className="req-kv" style={{ gridTemplateColumns: "1fr" }}>
            <span className="v" style={{ marginTop: 6, fontStyle: "italic", color: "var(--fg-300)", lineHeight: 1.5 }}>"{r.humanPayload.statement}"</span>
          </div>
        </div>
      </div>

      <div className="req-section" style={{ paddingBottom: 16 }}>
        <div className="req-section__h">
          <span>Raw message</span>
          <button onClick={() => setShowRaw((v) => !v)}>{showRaw ? "hide" : "show"} ↓</button>
        </div>
        {showRaw && <div className="req-raw">{r.raw}</div>}
      </div>

      <CustodyBadge mode={custody} />
      <div className="req-foot">
        <button onClick={onReject}>Reject</button>
        <button className="prim" onClick={onApprove}>Sign message</button>
      </div>
    </>
  );
}

// ---- Onboarding ----
export function ReqOnboard() {
  const onboardCardStyle: CSSProperties = {
    padding: "12px 14px",
    borderRadius: 12,
    background: "rgba(124,127,255,0.06)",
    border: "1px solid rgba(124,127,255,0.3)",
    marginBottom: 8,
    display: "flex",
    alignItems: "center",
    gap: 12,
    cursor: "pointer",
  };
  return (
    <>
      <DemoBanner />
      <div style={{ padding: "40px 24px 20px", textAlign: "center" }}>
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: 16,
            margin: "0 auto 14px",
            background: "linear-gradient(135deg, #1a1c30, #06070f)",
            border: "1px solid rgba(124,127,255,0.4)",
            display: "grid",
            placeItems: "center",
            color: "var(--gold)",
            fontFamily: "var(--f-mono)",
            fontSize: 24,
            fontWeight: 700,
            boxShadow: "inset 0 1px 0 rgba(124,127,255,0.3), 0 0 24px rgba(124,127,255,0.18)",
          }}
        >
          M
        </div>
        <h1 style={{ margin: "0 0 4px", fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em" }}>Monolythium Wallet</h1>
        <div style={{ fontFamily: "var(--f-mono)", fontSize: 10, color: "var(--gold)", letterSpacing: "0.2em", textTransform: "uppercase" }}>Post-quantum wallet</div>
        <p style={{ margin: "18px 16px 0", color: "var(--fg-300)", fontSize: 13, lineHeight: 1.55 }}>
          Your keys are sealed by your machine's TPM or platform passkey.
          Never leave the device. Never seen by Monolythium.
        </p>
      </div>
      <div style={{ padding: "10px 14px" }}>
        <div style={onboardCardStyle}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: "rgba(124,127,255,0.18)", color: "var(--gold)", display: "grid", placeItems: "center" }}>
            <Icon name="plus" size={16} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Create new wallet</div>
            <div style={{ fontFamily: "var(--f-mono)", fontSize: 10, color: "var(--fg-400)", marginTop: 2 }}>TPM-sealed by default · recoverable via Shamir</div>
          </div>
          <Icon name="chev" size={14} />
        </div>
        <div
          style={{
            padding: "12px 14px",
            borderRadius: 12,
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(255,255,255,0.06)",
            display: "flex",
            alignItems: "center",
            gap: 12,
            cursor: "pointer",
          }}
        >
          <div style={{ width: 32, height: 32, borderRadius: 8, background: "rgba(255,255,255,0.06)", color: "var(--fg-200)", display: "grid", placeItems: "center" }}>
            <Icon name="hw" size={16} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Import existing</div>
            <div style={{ fontFamily: "var(--f-mono)", fontSize: 10, color: "var(--fg-400)", marginTop: 2 }}>Mnemonic · SSS shares · hardware</div>
          </div>
          <Icon name="chev" size={14} />
        </div>
      </div>
      <div style={{ padding: "20px 24px", fontFamily: "var(--f-mono)", fontSize: 9.5, color: "var(--fg-500)", letterSpacing: "0.08em", lineHeight: 1.6, textTransform: "uppercase" }}>
        ⟟ SLH-DSA-128s (hash-based) · ML-DSA-65 (lattice) · dual-sig ready
      </div>
    </>
  );
}

export { ReqSheet };

// ---------------------------------------------------------------------------
// Real-payload approval views (Stage 4)
//
// These render the actual EIP-1193 request the dapp sent — no demo-data here.
// The service worker pre-populates an `SendTxView` (gas, simulation, nonce)
// and an EIP-712 `digest` so the popup can show real numbers without RPC
// access of its own.
// ---------------------------------------------------------------------------

// Hex / bytes helpers that don't drag a Buffer dep in.

function hexToBytes(hex: string): Uint8Array {
  const r = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (r.length === 0) return new Uint8Array(0);
  const padded = r.length % 2 === 1 ? "0" + r : r;
  const out = new Uint8Array(padded.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToUtf8IfPrintable(b: Uint8Array): string | null {
  try {
    const s = new TextDecoder("utf-8", { fatal: true }).decode(b);
    // Reject obviously-binary blobs: characters under 0x20 (other than \n\r\t)
    // are a strong signal the dapp meant raw bytes.
    for (const ch of s) {
      const c = ch.codePointAt(0)!;
      if (c < 0x20 && c !== 9 && c !== 10 && c !== 13) return null;
    }
    return s;
  } catch {
    return null;
  }
}

function parseHexQuantity(hex: string | null | undefined): bigint | null {
  if (!hex) return null;
  try {
    return BigInt(hex.startsWith("0x") || hex.startsWith("0X") ? hex : "0x" + hex);
  } catch {
    return null;
  }
}

function formatGasUnits(hex: string | null | undefined): string {
  const b = parseHexQuantity(hex);
  return b == null ? "—" : b.toString(10);
}

function formatGwei(hex: string | null | undefined): string {
  const b = parseHexQuantity(hex);
  if (b == null) return "—";
  // gwei = wei / 1e9 ; show with 2 decimals when < 100, else integer
  const gweiInt = b / 1_000_000_000n;
  const gweiFrac = (b % 1_000_000_000n) / 10_000_000n; // 2-dp
  const fracStr = gweiFrac.toString().padStart(2, "0");
  return `${gweiInt}.${fracStr}`;
}

function formatLyth(hex: string | null | undefined): string {
  const b = parseHexQuantity(hex);
  if (b == null) return "—";
  const wholeWei = 1_000_000_000_000_000_000n;
  const whole = b / wholeWei;
  const frac = b % wholeWei;
  // Show up to 6 decimals, trim trailing zeros.
  const fracStr = frac.toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
  return fracStr.length > 0 ? `${whole}.${fracStr}` : whole.toString();
}

// ---- send_tx approval ----
interface ReqSendTxProps {
  request: SendTxRequest;
  custody: Custody;
  signerAddress: string;
  onApprove: () => void;
  onReject: () => void;
}

type GasTier = "low" | "medium" | "high";

export function ReqSendTx({
  request,
  custody,
  signerAddress,
  onApprove,
  onReject,
}: ReqSendTxProps) {
  const { tx, view, origin } = request;
  const [tier, setTier] = useState<GasTier>("medium");
  const [showRaw, setShowRaw] = useState(false);
  const [showSim, setShowSim] = useState(true);

  const baseGasPrice = parseHexQuantity(view.gasPrice);
  const tieredGasPrice =
    baseGasPrice == null
      ? null
      : tier === "low"
        ? (baseGasPrice * 90n) / 100n
        : tier === "high"
          ? (baseGasPrice * 130n) / 100n
          : baseGasPrice;
  const tieredHex = tieredGasPrice == null ? null : "0x" + tieredGasPrice.toString(16);

  const gasUsed = parseHexQuantity(view.estimatedGas);
  const totalFeeWei =
    gasUsed != null && tieredGasPrice != null ? gasUsed * tieredGasPrice : null;
  const totalFeeHex = totalFeeWei == null ? null : "0x" + totalFeeWei.toString(16);

  const value = tx.value;
  const data = tx.data ?? "0x";
  const hasCalldata = data.length > 2;

  return (
    <>
      <DemoBanner />
      <AttStrip />
      <div className="req-head">
        <div className="origin">
          <div className="fav C">⌘</div>
          <div className="info">
            <div className="n">Sign transaction</div>
            <div className="u">{origin}</div>
          </div>
          <div style={{ fontFamily: "var(--f-mono)", fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--gold)", padding: "3px 7px", border: "1px solid rgba(124,127,255,0.4)", borderRadius: 4 }}>
            tx
          </div>
        </div>
        <h2>{hasCalldata ? "Contract interaction" : "Transfer"}</h2>
        <div className="sub">
          on {view.chainLabel} ({view.chainId})
        </div>
      </div>

      <div className="req-section">
        <div className="req-section__h">From</div>
        <div className="req-kv">
          <span className="k">Signer</span>
          <span className="v" style={{ fontFamily: "var(--f-mono)", fontSize: 11 }}>
            {signerAddress || "—"}
          </span>
        </div>
        <div className="req-kv">
          <span className="k">To</span>
          <span className="v" style={{ fontFamily: "var(--f-mono)", fontSize: 11 }}>
            {tx.to ?? "(contract creation)"}
          </span>
        </div>
        <div className="req-kv">
          <span className="k">Value</span>
          <span className="v">{value ? `${formatLyth(value)} LYTH` : "0 LYTH"}</span>
        </div>
        <div className="req-kv">
          <span className="k">Nonce</span>
          <span className="v">{view.nonce ?? "—"}</span>
        </div>
      </div>

      {hasCalldata && (
        <div className="req-section">
          <div className="req-section__h">
            <span>Simulation</span>
            <button onClick={() => setShowSim((v) => !v)}>{showSim ? "hide" : "show"} ↓</button>
          </div>
          {showSim && view.simulation == null && (
            <div className="req-warn warn">
              <Icon name="warn" size={14} />
              <div>Simulation not available — node did not respond. Approve at your own risk.</div>
            </div>
          )}
          {showSim && view.simulation && view.simulation.success && (
            <div className="req-sim">
              <div className="req-sim__h">
                <Icon name="check" size={10} /> Simulation succeeded
              </div>
              <div className="req-sim__row">
                <span className="k">eth_call return</span>
                <span className="v" style={{ fontFamily: "var(--f-mono)", fontSize: 10, wordBreak: "break-all" }}>
                  {view.simulation.returnData.length > 80
                    ? view.simulation.returnData.slice(0, 80) + "…"
                    : view.simulation.returnData}
                </span>
              </div>
            </div>
          )}
          {showSim && view.simulation && !view.simulation.success && (
            <div className="req-warn warn">
              <Icon name="warn" size={14} />
              <div>
                <b>Simulation reverted.</b> {view.simulation.error}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="req-section">
        <div className="req-section__h">Gas</div>
        <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
          {(["low", "medium", "high"] as GasTier[]).map((t) => (
            <button
              key={t}
              onClick={() => setTier(t)}
              style={{
                flex: 1,
                padding: "7px 6px",
                borderRadius: 8,
                fontSize: 10,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                fontFamily: "var(--f-mono)",
                background: tier === t ? "var(--gold-bg)" : "transparent",
                color: tier === t ? "var(--gold)" : "var(--fg-300)",
                border: tier === t ? "1px solid rgba(124,127,255,0.4)" : "1px solid var(--fg-700)",
                cursor: "pointer",
              }}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="req-kv">
          <span className="k">Gas limit</span>
          <span className="v">{formatGasUnits(view.estimatedGas)}</span>
        </div>
        <div className="req-kv">
          <span className="k">Gas price</span>
          <span className="v">{formatGwei(tieredHex)} gwei</span>
        </div>
        <div className="req-kv">
          <span className="k">Max fee</span>
          <span className="v">
            {totalFeeHex ? `${formatLyth(totalFeeHex)} LYTH` : "—"}
          </span>
        </div>
      </div>

      <div className="req-section" style={{ paddingBottom: 16 }}>
        <div className="req-section__h">
          <span>Raw calldata</span>
          <button onClick={() => setShowRaw((v) => !v)}>{showRaw ? "hide" : "show"} ↓</button>
        </div>
        {showRaw && (
          <div className="req-raw" style={{ wordBreak: "break-all" }}>
            {hasCalldata ? data : "0x (no calldata)"}
          </div>
        )}
      </div>

      <CustodyBadge mode={custody} />
      <div className="req-foot">
        <button onClick={onReject}>Reject</button>
        <button className="prim" onClick={onApprove}>
          {custody === "hw" ? "Confirm on device" : "Sign & send"}
        </button>
      </div>
    </>
  );
}

// ---- personal_sign approval ----
interface ReqPersonalSignRealProps {
  request: PersonalSignRequest;
  custody: Custody;
  onApprove: () => void;
  onReject: () => void;
}

export function ReqPersonalSignReal({
  request,
  custody,
  onApprove,
  onReject,
}: ReqPersonalSignRealProps) {
  const { message, address, origin } = request;
  const isHex = message.startsWith("0x") || message.startsWith("0X");
  const bytes = isHex ? hexToBytes(message) : new TextEncoder().encode(message);
  const utf8 = isHex ? bytesToUtf8IfPrintable(bytes) : message;
  const [showRaw, setShowRaw] = useState(false);

  return (
    <>
      <DemoBanner />
      <AttStrip />
      <div className="req-head">
        <div className="origin">
          <div className="fav G">M</div>
          <div className="info">
            <div className="n">Sign message</div>
            <div className="u">{origin}</div>
          </div>
          <div style={{ fontFamily: "var(--f-mono)", fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--fg-200)", padding: "3px 7px", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4 }}>
            personal_sign
          </div>
        </div>
        <h2>Confirm message signature</h2>
        <div className="sub">no value transferred · EIP-191 prefix applied before sign</div>
      </div>

      <div className="req-section">
        <div className="req-section__h">Signing as</div>
        <div className="req-kv">
          <span className="k">Address</span>
          <span className="v" style={{ fontFamily: "var(--f-mono)", fontSize: 11 }}>
            {address || "—"}
          </span>
        </div>
      </div>

      <div className="req-section">
        <div className="req-section__h">Message</div>
        <div
          style={{
            padding: "10px 12px",
            borderRadius: 10,
            background: "rgba(0,0,0,0.3)",
            border: "1px solid rgba(255,255,255,0.05)",
            fontFamily: utf8 == null ? "var(--f-mono)" : "var(--f-sans)",
            fontSize: 12,
            lineHeight: 1.55,
            color: "var(--fg-100)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 220,
            overflowY: "auto",
          }}
        >
          {utf8 ?? message}
        </div>
        {isHex && utf8 == null && (
          <div style={{ fontFamily: "var(--f-mono)", fontSize: 10, color: "var(--fg-500)", marginTop: 6 }}>
            payload is binary · displayed as hex
          </div>
        )}
      </div>

      {isHex && utf8 != null && (
        <div className="req-section">
          <div className="req-section__h">
            <span>Raw hex</span>
            <button onClick={() => setShowRaw((v) => !v)}>{showRaw ? "hide" : "show"} ↓</button>
          </div>
          {showRaw && (
            <div className="req-raw" style={{ wordBreak: "break-all" }}>
              {message}
            </div>
          )}
        </div>
      )}

      <CustodyBadge mode={custody} />
      <div className="req-foot">
        <button onClick={onReject}>Reject</button>
        <button className="prim" onClick={onApprove}>
          {custody === "hw" ? "Confirm on device" : "Sign message"}
        </button>
      </div>
    </>
  );
}

// ---- typed_sign approval ----
interface ReqTypedSignProps {
  request: TypedSignRequest;
  custody: Custody;
  onApprove: () => void;
  onReject: () => void;
}

export function ReqTypedSign({
  request,
  custody,
  onApprove,
  onReject,
}: ReqTypedSignProps) {
  const { parsed, digest, address, origin, rawTypedData } = request;
  const [showRaw, setShowRaw] = useState(false);

  return (
    <>
      <DemoBanner />
      <AttStrip />
      <div className="req-head">
        <div className="origin">
          <div className="fav G">⛬</div>
          <div className="info">
            <div className="n">Sign typed data (EIP-712)</div>
            <div className="u">{origin}</div>
          </div>
          <div style={{ fontFamily: "var(--f-mono)", fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--fg-200)", padding: "3px 7px", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4 }}>
            v4
          </div>
        </div>
        <h2>{parsed?.primaryType ?? "Typed-data envelope"}</h2>
        <div className="sub">
          {parsed
            ? `domain ${String(parsed.domain.name ?? "—")} · structured`
            : "could not parse — review raw payload below"}
        </div>
      </div>

      <div className="req-section">
        <div className="req-section__h">Signing as</div>
        <div className="req-kv">
          <span className="k">Address</span>
          <span className="v" style={{ fontFamily: "var(--f-mono)", fontSize: 11 }}>
            {address || "—"}
          </span>
        </div>
      </div>

      {parsed && (
        <div className="req-section">
          <div className="req-section__h">Domain</div>
          <div
            style={{
              padding: "8px 10px",
              borderRadius: 10,
              background: "rgba(0,0,0,0.25)",
              border: "1px solid rgba(255,255,255,0.05)",
            }}
          >
            {Object.entries(parsed.domain).map(([k, v]) => (
              <div className="req-kv" key={k}>
                <span className="k">{k}</span>
                <span
                  className="v"
                  style={{ fontFamily: "var(--f-mono)", fontSize: 11, wordBreak: "break-all" }}
                >
                  {String(v)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {parsed && (
        <div className="req-section">
          <div className="req-section__h">Message · {parsed.primaryType}</div>
          <TypedDataTree value={parsed.message} />
        </div>
      )}

      {digest && (
        <div className="req-section">
          <div className="req-section__h">EIP-712 digest</div>
          <div
            className="req-raw"
            style={{ wordBreak: "break-all", fontSize: 10, color: "var(--gold)" }}
          >
            {digest}
          </div>
        </div>
      )}

      <div className="req-section" style={{ paddingBottom: 16 }}>
        <div className="req-section__h">
          <span>Raw payload</span>
          <button onClick={() => setShowRaw((v) => !v)}>{showRaw ? "hide" : "show"} ↓</button>
        </div>
        {showRaw && <div className="req-raw" style={{ wordBreak: "break-all" }}>{rawTypedData}</div>}
      </div>

      <CustodyBadge mode={custody} />
      <div className="req-foot">
        <button onClick={onReject}>Reject</button>
        <button className="prim" onClick={onApprove} disabled={!parsed}>
          {custody === "hw" ? "Confirm on device" : "Sign typed data"}
        </button>
      </div>
    </>
  );
}

// Tiny collapsible tree for the EIP-712 message body.
function TypedDataTree({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value == null) {
    return <span style={{ color: "var(--fg-500)" }}>null</span>;
  }
  if (typeof value !== "object") {
    const s = String(value);
    return (
      <span style={{ fontFamily: "var(--f-mono)", fontSize: 11, color: "var(--fg-100)", wordBreak: "break-all" }}>
        {s}
      </span>
    );
  }
  if (Array.isArray(value)) {
    return <TypedDataNode label={`[${value.length}]`} value={value} depth={depth} />;
  }
  return <TypedDataNode label="" value={value as Record<string, unknown>} depth={depth} />;
}

function TypedDataNode({
  label,
  value,
  depth,
}: {
  label: string;
  value: Record<string, unknown> | unknown[];
  depth: number;
}) {
  const [open, setOpen] = useState(depth < 2);
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as [string, unknown])
    : Object.entries(value);
  return (
    <div style={{ paddingLeft: depth * 10 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          background: "transparent",
          border: 0,
          color: "var(--fg-300)",
          fontFamily: "var(--f-mono)",
          fontSize: 10,
          letterSpacing: "0.06em",
          cursor: "pointer",
          padding: "4px 0",
        }}
      >
        {open ? "▾" : "▸"} {label || (Array.isArray(value) ? "[ ]" : "{ }")}{" "}
        <span style={{ color: "var(--fg-500)" }}>{entries.length} field{entries.length === 1 ? "" : "s"}</span>
      </button>
      {open && (
        <div>
          {entries.map(([k, v]) => (
            <div key={k} style={{ display: "grid", gridTemplateColumns: "100px 1fr", gap: 8, padding: "3px 0" }}>
              <span style={{ fontFamily: "var(--f-mono)", fontSize: 10, color: "var(--fg-400)" }}>{k}</span>
              <div style={{ minWidth: 0 }}>
                <TypedDataTree value={v} depth={depth + 1} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- add_chain approval (EIP-3085) ----
interface ReqAddChainProps {
  request: AddChainRequest;
  onApprove: () => void;
  onReject: () => void;
}

export function ReqAddChain({ request, onApprove, onReject }: ReqAddChainProps) {
  const { chain, origin } = request;
  return (
    <>
      <DemoBanner />
      <AttStrip />
      <div className="req-head">
        <div className="origin">
          <div className="fav S">+</div>
          <div className="info">
            <div className="n">Add network</div>
            <div className="u">{origin}</div>
          </div>
          <div style={{ fontFamily: "var(--f-mono)", fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--warn)", padding: "3px 7px", border: "1px solid rgba(220,160,0,0.4)", borderRadius: 4 }}>
            new chain
          </div>
        </div>
        <h2>{chain.chainName}</h2>
        <div className="sub">requesting · adds chain to wallet network list</div>
      </div>

      <div className="req-warn warn">
        <Icon name="warn" size={14} />
        <div>
          <b>Verify this network.</b> Malicious dapps may request fake chains
          to capture signatures. Only approve if you trust the origin.
        </div>
      </div>

      <div className="req-section">
        <div className="req-section__h">Network</div>
        <div className="req-kv">
          <span className="k">Name</span>
          <span className="v">{chain.chainName}</span>
        </div>
        <div className="req-kv">
          <span className="k">Chain ID</span>
          <span className="v" style={{ fontFamily: "var(--f-mono)", fontSize: 11 }}>
            {chain.chainId}
          </span>
        </div>
        {chain.nativeCurrency && (
          <div className="req-kv">
            <span className="k">Native currency</span>
            <span className="v">
              {chain.nativeCurrency.symbol} ({chain.nativeCurrency.name}, {chain.nativeCurrency.decimals} dp)
            </span>
          </div>
        )}
      </div>

      <div className="req-section">
        <div className="req-section__h">RPC endpoints</div>
        {chain.rpcUrls.map((u, i) => (
          <div key={i} className="req-kv">
            <span className="k">RPC #{i + 1}</span>
            <span className="v" style={{ fontFamily: "var(--f-mono)", fontSize: 11, wordBreak: "break-all" }}>
              {u}
            </span>
          </div>
        ))}
      </div>

      {chain.blockExplorerUrls && chain.blockExplorerUrls.length > 0 && (
        <div className="req-section">
          <div className="req-section__h">Block explorer</div>
          {chain.blockExplorerUrls.map((u, i) => (
            <div key={i} className="req-kv">
              <span className="k">Explorer #{i + 1}</span>
              <span className="v" style={{ fontFamily: "var(--f-mono)", fontSize: 11, wordBreak: "break-all" }}>
                {u}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="req-foot">
        <button onClick={onReject}>Reject</button>
        <button className="prim" onClick={onApprove}>Add network</button>
      </div>
    </>
  );
}
