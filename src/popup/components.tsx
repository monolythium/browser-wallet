// Component port from designs/src/ext-popup.jsx + ext-app.jsx + ext-requests.jsx.
// Surface-only. No keystore, no RPC, no signing here.
// TODO(monolythium-vision): swap demo-data imports for @monolythium/core-sdk reads.

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
