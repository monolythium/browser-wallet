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
import { useState, useEffect } from "react";
import { Icon, fmt, shortAddr } from "./Icon";
import type { IconName } from "./Icon";
import { bech32mDisplay } from "../shared/bech32m";
import { RevealableAddressBlock } from "./components/RevealableAddressBlock";
import {
  ACCOUNTS, DAPPS, NODE,
} from "./demo-data";
import type {
  Account, Custody,
} from "./demo-data";
import type {
  ConnectRequest,
  PersonalSignRequest,
  TypedSignRequest,
  SendTxRequest,
  AddChainRequest,
  ChainEntry,
  PendingApproval,
  WalletIndexerSnapshot,
  WalletBridgeDisclosureValue,
  WalletBridgeRouteDisclosure,
  WalletTokenBalance,
} from "./bg";
import {
  bgWalletOperatorStatus,
  bgWalletChainBlockNumber,
  bgFocusApproval,
  bgWsSubscribeNewHeads,
} from "./bg";
import { useApprovalQueue } from "./hooks/useApprovalQueue";
import { ActivityList } from "./components/ActivityList";
import { VaultPicker } from "./components/VaultPicker";
import { NftTab } from "./components/NftTab";
import type { SendNftTarget } from "./pages/SendNft";
import {
  detectOriginWarnings,
  detectMessageWarnings,
  type OriginWarning,
  type MessageWarning,
} from "../shared/phishing";


// ---- Chain status banner (replaces DemoBanner) ----
//
// Reflects the wallet's actual operational state instead of the legacy
// "MOCK · NO REAL VALUE · DESIGN-ONLY" copy. The wallet now holds real
// ML-DSA-65 keys, reads live Sprintnet state, and submits real
// encrypted-envelope txs — that's worth surfacing. Other parts of the
// UI (Top status bar, account list, activity log, recent dApps) ARE
// still demo data and live below the AttStrip; we'll address those in
// follow-up cleanups.

// `ChainHealth` reflects the popup's read of chain liveness via an
// `eth_blockNumber` poll on the active operator. LOADING is the initial
// state before the first tick lands; STALLED is gated behind a 30-second
// no-advance threshold so it never fires from a single missed tick or
// on the loading-to-live transition itself.
type ChainHealth =
  | { kind: "loading" }
  | { kind: "live"; blockHex: string }
  | { kind: "stalled"; blockHex: string }
  | { kind: "offline"; reason: string };

const HEALTH_TICK_MS = 8_000;
const STALL_THRESHOLD_MS = 30_000;
const OPERATOR_TICK_MS = 10_000;

interface ChainStatusBannerProps {
  /** Active chain display data. Required — every callsite threads its
   *  resolved chain (`activeChain` in the main popup, or the prop-drilled
   *  `chain` in the approval window). */
  network: ChainEntry;
  /** When provided, the chain-name segment becomes a clickable button
   *  that routes to the chain picker (interactive pill with a caret).
   *  Omit for read-only contexts (e.g. approval window) — the chip then
   *  renders as a non-clickable pill without the caret, matching the
   *  visual weight of the interactive version. */
  onOpenNetworks?: () => void;
}

export function ChainStatusBanner({ network, onOpenNetworks }: ChainStatusBannerProps) {
  const [health, setHealth] = useState<ChainHealth>({ kind: "loading" });
  const [operator, setOperator] = useState<string | null>(null);

  // Chain-health poll. Tracks `lastBlockHex` and `lastBlockObservedAt` so
  // we can distinguish "RPC reachable but chain stalled" from "RPC down".
  // Visibility-gated — when the popup is hidden (Chrome closes popups on
  // focus loss in some builds; the page may also be backgrounded for a
  // brief window before unmount), polling pauses to avoid wasted traffic.
  // The `cancelled` flag in the cleanup short-circuits any in-flight
  // setHealth that would otherwise fire on an unmounted component.
  useEffect(() => {
    let cancelled = false;
    let lastBlockHex: string | null = null;
    let lastBlockObservedAt = Date.now();

    const tick = async () => {
      if (cancelled || document.visibilityState === "hidden") return;
      try {
        const r = await bgWalletChainBlockNumber();
        if (cancelled) return;
        if (!r.ok) {
          setHealth({ kind: "offline", reason: r.reason ?? "unreachable" });
          return;
        }
        const now = Date.now();
        if (lastBlockHex === null || r.blockHex !== lastBlockHex) {
          lastBlockHex = r.blockHex;
          lastBlockObservedAt = now;
          setHealth({ kind: "live", blockHex: r.blockHex });
        } else if (now - lastBlockObservedAt >= STALL_THRESHOLD_MS) {
          setHealth({ kind: "stalled", blockHex: r.blockHex });
        }
        // else: same block but within fresh window — keep current state
      } catch (e) {
        if (cancelled) return;
        setHealth({ kind: "offline", reason: (e as Error).message });
      }
    };

    const visHandler = () => {
      if (document.visibilityState === "visible") void tick();
    };

    void tick();
    const intervalId = setInterval(tick, HEALTH_TICK_MS);
    document.addEventListener("visibilitychange", visHandler);

    // Phase 11 Commit 2 — opportunistic WS upgrade. Ask the SW to
    // subscribe to `newHeads`; when chain pushes a new head, the SW
    // writes the block hex to chrome.storage.session under the key
    // below. We watch that key here and update the banner without
    // waiting for the next 8 s poll. The 8 s poll stays running as
    // a safety net so a WS drop doesn't strand the user on stale
    // data — if WS is healthy, the poll's tick just reaffirms what
    // the WS already wrote.
    void bgWsSubscribeNewHeads().catch(() => {
      // ws-subscribe-new-heads is best-effort; failure means the
      // 8 s poll covers us alone (the existing behaviour).
    });
    const wsKey = "mono.ws.lastBlockHex";
    const wsListener: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (
      changes,
      area,
    ) => {
      if (area !== "session") return;
      if (cancelled) return;
      const change = changes[wsKey];
      if (!change || typeof change.newValue !== "string") return;
      const blockHex = change.newValue;
      const now = Date.now();
      if (lastBlockHex === null || blockHex !== lastBlockHex) {
        lastBlockHex = blockHex;
        lastBlockObservedAt = now;
        setHealth({ kind: "live", blockHex });
      }
    };
    chrome.storage.onChanged.addListener(wsListener);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", visHandler);
      chrome.storage.onChanged.removeListener(wsListener);
    };
  }, []);

  // Operator-name poll, separate from chain-health. The operator label is
  // a pure side-info readout (which Sprintnet operator answered our
  // probe) and stays decoupled from the LIVE/STALLED/OFFLINE state — a
  // chain can be live with an unknown operator, or stalled while the
  // operator is still reachable.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled || document.visibilityState === "hidden") return;
      try {
        const r = await bgWalletOperatorStatus();
        if (cancelled) return;
        if (r.ok) setOperator(r.name);
      } catch {
        // operator name is not load-bearing — silent on transient errors
      }
    };

    void tick();
    const intervalId = setInterval(tick, OPERATOR_TICK_MS);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, []);

  const containerStyle: CSSProperties = {
    fontFamily: "var(--f-mono)",
    fontSize: 9.5,
    letterSpacing: "0.16em",
    textTransform: "uppercase",
    padding: "5px 14px",
    borderBottom: "1px solid var(--fg-700)",
    display: "flex",
    alignItems: "center",
    gap: 8,
    color: "var(--fg-300)",
  };

  // Pill chip styling shared between the interactive (with caret) and
  // read-only (no caret) variants. Read-only is used inside the approval
  // window, where switching chains mid-approval would be unsafe.
  const chipStyle: CSSProperties = {
    padding: "2px 8px",
    border: "1px solid var(--fg-700)",
    borderRadius: 999,
    background: "rgba(255,255,255,0.04)",
    font: "inherit",
    letterSpacing: "inherit",
    textTransform: "inherit",
    color: "inherit",
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    lineHeight: 1,
  };

  const networkChip = onOpenNetworks ? (
    <button
      onClick={onOpenNetworks}
      style={{ ...chipStyle, cursor: "pointer" }}
    >
      {network.name.toUpperCase()}
      <Icon name="chev-d" size={9} />
    </button>
  ) : (
    <span style={chipStyle}>{network.name.toUpperCase()}</span>
  );

  let dotColor: string;
  let body: ReactNode;
  switch (health.kind) {
    case "live":
      dotColor = "var(--ok)";
      body = (
        <>
          <span style={{ color: "var(--ok)", fontWeight: 500 }}>LIVE</span>
          <span style={{ color: "var(--fg-600)" }}>·</span>
          {networkChip}
          {operator !== null && (
            <>
              <span style={{ color: "var(--fg-600)" }}>·</span>
              <span style={{ color: "var(--ok)" }}>{operator.toUpperCase()}</span>
            </>
          )}
        </>
      );
      break;
    case "stalled":
      dotColor = "var(--warn)";
      body = (
        <>
          <span style={{ color: "var(--warn)", fontWeight: 500 }}>STALLED</span>
          <span style={{ color: "var(--fg-600)" }}>·</span>
          {networkChip}
          {operator !== null && (
            <>
              <span style={{ color: "var(--fg-600)" }}>·</span>
              <span>{operator.toUpperCase()}</span>
            </>
          )}
        </>
      );
      break;
    case "offline":
      dotColor = "var(--err)";
      body = (
        <>
          <span style={{ color: "var(--err)", fontWeight: 500 }}>OFFLINE</span>
          <span style={{ color: "var(--fg-600)" }}>·</span>
          {networkChip}
          <span style={{ color: "var(--fg-600)" }}>·</span>
          <span style={{ textTransform: "none", letterSpacing: 0 }}>{health.reason}</span>
        </>
      );
      break;
    case "loading":
    default:
      dotColor = "var(--fg-500)";
      body = <span>CONNECTING…</span>;
      break;
  }

  return (
    <div style={containerStyle}>
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: dotColor,
          boxShadow:
            health.kind === "live" || health.kind === "stalled" || health.kind === "offline"
              ? `0 0 6px ${dotColor}`
              : "none",
          flexShrink: 0,
        }}
      />
      {body}
    </div>
  );
}

// ---- Top row: brand + account + settings ----
//
// The active chain selector lives in the status bar (`ChainStatusBanner`)
// directly above this row. Top kept the chain chip until Phase 4.1.2,
// when the full bech32m address landed in the account chip and needed
// the freed horizontal width to render in 1-2 lines instead of 3-4.
interface TopProps {
  account: Account;
  onOpenAccounts: () => void;
  onSettings: () => void;
}

// Phase 5 Commit 3: chip replaced with <VaultPicker /> (multi-vault
// dropdown). `onOpenAccounts` is preserved on TopProps for caller
// compatibility but no longer consumed here — the legacy Accounts
// screen navigation is vestigial since BIP-32/44 HD derivation was
// removed (whitepaper §21.2.1). Full deletion of the prop chain
// (HomeProps + App.tsx) is a Phase 8 cleanup.
export function Top({ account, onSettings }: TopProps) {
  return (
    <div className="ext-top">
      <VaultPicker activeAccount={account} />
      <button className="ext-iconbtn" onClick={onSettings}><Icon name="settings" size={16} /></button>
    </div>
  );
}

// ---- Asset list ----
//
// Two rows: LYTH (live, sourced from `account.balance`) and LYTH-p
// (coming soon — the bifurcated-denomination split lives in
// `project_bifurcated_denomination.md` as a future task). No
// bridged / wrapped entries — those were demo-mock pairs and the
// wallet doesn't have authoritative data for them.

interface AssetListProps {
  account: Account;
  network: ChainEntry;
  indexer: WalletIndexerSnapshot | null;
}

function AssetList({ account, network, indexer }: AssetListProps) {
  const lythAmount = account.balance;
  const liveRows = indexer?.tokenBalances ?? [];
  return (
    <div>
      {liveRows.length > 0 && liveRows.map((row) => {
        const display = formatIndexedTokenBalanceRow(row);
        return (
          <div className="ext-asset" key={row.tokenId}>
            <div className="ext-asset__ico native">IDX</div>
            <div className="ext-asset__main">
              <div className="sym">
                {display.title} <span className="ext-badge-att">Indexed</span>
                {tokenHasBridgeRouteDisclosure(row) && (
                  <> <span className="ext-badge-bridged">Disclosure</span></>
                )}
              </div>
              <div className="chain">{display.subtitle}</div>
            </div>
            <div className="ext-asset__spark" />
            <div className="ext-asset__right">
              <div className="amt">{row.balance}</div>
              <div className="chg">{display.unitsLabel}</div>
            </div>
          </div>
        );
      })}

      {/* LYTH — live row */}
      <div className="ext-asset">
        <div className="ext-asset__ico native">LYT</div>
        <div className="ext-asset__main">
          <div className="sym">
            LYTH <span className="ext-badge-att">Att</span>
          </div>
          <div className="chain">Monolythium · {network.name}</div>
        </div>
        <div className="ext-asset__spark" />
        <div className="ext-asset__right">
          <div className="amt">{lythAmount != null ? fmt(lythAmount, 2) : "0.00"}</div>
          <div className="chg">—</div>
        </div>
      </div>

      {/* LYTH-p — disabled (private denomination not active in this build) */}
      <div className="ext-asset" style={{ opacity: 0.6, cursor: "default" }}>
        <div className="ext-asset__ico priv">Ⓜ</div>
        <div className="ext-asset__main">
          <div className="sym" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            LYTH-p
            <span className="ext-badge-att">Att</span>
          </div>
          <div className="chain">Monolythium (private) · private denomination</div>
        </div>
        <div className="ext-asset__spark" />
        <div className="ext-asset__right">
          <div className="amt">—</div>
        </div>
      </div>
    </div>
  );
}

// ---- Activity list ----
//
// Phase 4.4 wired the Activity tab body to live indexer data via three
// hooks (useActivity / useNameResolution / useIndexerStatus). The
// implementation lives in src/popup/components/ActivityList.tsx — see
// there for the kind dispatch + IndexerStaleBanner + empty/error/stale
// state copy. The pre-Phase-4.4 inline list (+ its formatActivityTitle
// / formatActivityAmount / shortHex helpers) was removed in commit
// 13/13 of the Phase 4.4 ship.

function shortHex(value: string): string {
  return value.length > 26 ? `${value.slice(0, 14)}…${value.slice(-8)}` : value;
}

interface IndexedTokenBalanceDisplay {
  title: string;
  subtitle: string;
  unitsLabel: string;
}

function normaliseMrcStandard(standard: string): string {
  return standard.toLowerCase().replace(/[-_]/g, "");
}

function formatMrcStandardLabel(standard: string): string {
  switch (normaliseMrcStandard(standard)) {
    case "mrc20":
      return "MRC-20";
    case "mrc721":
      return "MRC-721";
    case "mrc1155":
      return "MRC-1155";
    default:
      return standard.toUpperCase();
  }
}

export function formatIndexedTokenBalanceRow(
  row: WalletTokenBalance,
): IndexedTokenBalanceDisplay {
  const updated = `updated at block ${row.updatedAtBlock.toLocaleString()}`;
  if (!row.mrc) {
    return {
      title: shortHex(row.tokenId),
      subtitle: updated,
      unitsLabel: "raw units",
    };
  }

  const standard = normaliseMrcStandard(row.mrc.standard);
  const label = formatMrcStandardLabel(row.mrc.standard);
  const isCollectionToken = standard === "mrc721" || standard === "mrc1155";
  const assetKind = isCollectionToken ? "collection" : "asset";
  const assetId = shortHex(row.mrc.assetId);

  if (isCollectionToken && row.mrc.tokenId) {
    const tokenId = shortHex(row.mrc.tokenId);
    return {
      title: `${label} ${tokenId}`,
      subtitle: `${assetKind} ${assetId} · token ${tokenId} · ${updated}`,
      unitsLabel: "raw units",
    };
  }

  return {
    title: `${label} ${assetId}`,
    subtitle: `${assetKind} ${assetId} · ${updated}`,
    unitsLabel: "raw units",
  };
}

export interface BridgeDisclosureRowDisplay {
  keyPath: string;
  value: string;
}

export interface BridgeRouteDisclosureDisplay {
  trustRows: BridgeDisclosureRowDisplay[];
  liquidityRows: BridgeDisclosureRowDisplay[];
  otherRows: BridgeDisclosureRowDisplay[];
}

const TRUST_DISCLOSURE_KEY_RE =
  /trust|guardian|committee|validator|multisig|light[_-]?client|zk|proof|verification|attestation|custody|permission/i;
const LIQUIDITY_DISCLOSURE_KEY_RE =
  /liquidity|floor|cap|limit|insurance|reserve|tvl|depth|slippage|inventory|available/i;

function isBridgeDisclosureObject(
  value: WalletBridgeDisclosureValue,
): value is Record<string, WalletBridgeDisclosureValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatBridgeDisclosureValue(value: string | number | boolean | null): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function appendBridgeDisclosurePath(prefix: string, key: string): string {
  return prefix.length > 0 ? `${prefix}.${key}` : key;
}

function flattenBridgeDisclosureRows(
  value: WalletBridgeDisclosureValue,
  keyPath: string,
  out: BridgeDisclosureRowDisplay[],
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      flattenBridgeDisclosureRows(item, `${keyPath}[${index}]`, out);
    });
    return;
  }

  if (isBridgeDisclosureObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      flattenBridgeDisclosureRows(
        child,
        appendBridgeDisclosurePath(keyPath, key),
        out,
      );
    }
    return;
  }

  out.push({ keyPath, value: formatBridgeDisclosureValue(value) });
}

export function formatBridgeRouteDisclosureDisplay(
  disclosure: WalletBridgeRouteDisclosure,
): BridgeRouteDisclosureDisplay {
  const rows: BridgeDisclosureRowDisplay[] = [];
  for (const [key, value] of Object.entries(disclosure)) {
    flattenBridgeDisclosureRows(value, key, rows);
  }

  const trustRows: BridgeDisclosureRowDisplay[] = [];
  const liquidityRows: BridgeDisclosureRowDisplay[] = [];
  const otherRows: BridgeDisclosureRowDisplay[] = [];

  for (const row of rows) {
    if (LIQUIDITY_DISCLOSURE_KEY_RE.test(row.keyPath)) {
      liquidityRows.push(row);
    } else if (TRUST_DISCLOSURE_KEY_RE.test(row.keyPath)) {
      trustRows.push(row);
    } else {
      otherRows.push(row);
    }
  }

  return { trustRows, liquidityRows, otherRows };
}

export function bridgeRouteDisclosureHasRequiredFloorData(
  display: BridgeRouteDisclosureDisplay,
): boolean {
  return (
    display.trustRows.length > 0 &&
    display.liquidityRows.some((row) => /floor/i.test(row.keyPath))
  );
}

function tokenBridgeRouteDisclosures(
  row: WalletTokenBalance,
): WalletBridgeRouteDisclosure[] {
  const out: WalletBridgeRouteDisclosure[] = [];
  if (row.bridgeRouteDisclosure) out.push(row.bridgeRouteDisclosure);
  if (row.bridgeRouteDisclosures) out.push(...row.bridgeRouteDisclosures);
  return out;
}

function tokenHasBridgeRouteDisclosure(row: WalletTokenBalance): boolean {
  return tokenBridgeRouteDisclosures(row).length > 0;
}

export function collectBridgeRouteDisclosuresFromIndexer(
  indexer: WalletIndexerSnapshot | null,
): WalletBridgeRouteDisclosure[] {
  if (indexer === null) return [];
  const out: WalletBridgeRouteDisclosure[] = [];
  if (indexer.bridgeRouteDisclosure) out.push(indexer.bridgeRouteDisclosure);
  if (indexer.bridgeRouteDisclosures) out.push(...indexer.bridgeRouteDisclosures);
  for (const row of indexer.tokenBalances) {
    out.push(...tokenBridgeRouteDisclosures(row));
  }
  return out;
}

// ---- Pending requests shelf ----
//
// Reactive read of the SW approval queue via useApprovalQueue() — items
// are real EIP-1193 connect / sign / send-tx / chain requests awaiting
// user action in the dedicated approval window. Card is hidden entirely
// when the queue is empty; tapping a row brings the matching approval
// window to the front.

interface ApprovalDisplay {
  title: string;
  subtitle: string;
  letter: string;
}

function hostnameOf(origin: string): string {
  try { return new URL(origin).hostname; } catch { return origin; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phishing-warning panels — rendered above the body of approval screens.
// Pure presentation; the heuristic logic lives in src/shared/phishing.ts.
// Two distinct components so call sites can place them in different slots
// (typed_sign places origin warnings after req-head; ReqConnect places both
// after req-head; ReqPersonalSignReal stacks both in order).
// ─────────────────────────────────────────────────────────────────────────────

function OriginWarningPanel({ warnings }: { warnings: OriginWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="req-section">
      {warnings.map((w) => (
        <WarningRow
          key={w.code}
          level={w.level}
          title={titleForOriginCode(w.code)}
          text={w.text}
        />
      ))}
    </div>
  );
}

function MessageWarningPanel({ warnings }: { warnings: MessageWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="req-section">
      {warnings.map((w) => (
        <WarningRow
          key={w.code}
          level={w.level}
          title={titleForMessageCode(w.code)}
          text={w.text}
        />
      ))}
    </div>
  );
}

function WarningRow({
  level,
  title,
  text,
}: {
  level: "warning" | "danger";
  title: string;
  text: string;
}) {
  const isDanger = level === "danger";
  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        padding: "10px 12px",
        marginBottom: 6,
        borderRadius: 10,
        background: isDanger
          ? "rgba(220,80,80,0.10)"
          : "rgba(244,201,122,0.08)",
        border: isDanger
          ? "1px solid rgba(220,80,80,0.4)"
          : "1px solid rgba(244,201,122,0.4)",
      }}
    >
      <Icon name="warn" size={14} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 11.5,
            fontWeight: 600,
            color: isDanger ? "var(--err)" : "var(--warn)",
            marginBottom: 2,
            letterSpacing: "0.02em",
            textTransform: "uppercase",
            fontFamily: "var(--f-mono)",
          }}
        >
          {title}
        </div>
        <div style={{ fontSize: 11.5, color: "var(--fg-100)", lineHeight: 1.5 }}>
          {text}
        </div>
      </div>
    </div>
  );
}

function titleForOriginCode(code: string): string {
  switch (code) {
    case "missing-origin":
    case "malformed-origin":
      return "Invalid origin";
    case "non-https":
      return "Insecure transport";
    case "punycode":
      return "Punycode hostname";
    case "homograph":
      return "Lookalike characters";
    case "brand-lookalike":
      return "Brand impersonation risk";
    case "risky-tld":
      return "Risky TLD";
    default:
      return "Origin warning";
  }
}

function titleForMessageCode(code: string): string {
  switch (code) {
    case "abi-shaped-hex":
      return "Looks like contract calldata";
    case "binary-hex":
      return "Non-printable payload";
    case "permit-keyword":
      return "Permit / approval clause";
    case "oversized-payload":
      return "Unusually large payload";
    default:
      return "Payload warning";
  }
}

function previewMessage(message: string): string {
  // 0x-hex personal_sign payloads are commonly utf8-encoded text. Decode
  // when the bytes are printable ASCII; fall through to the raw string
  // otherwise (binary blobs, malformed hex) so the user still sees a
  // recognisable preview.
  let decoded = message;
  if (message.startsWith("0x") && message.length > 2 && (message.length - 2) % 2 === 0) {
    try {
      const bytes = new Uint8Array((message.length - 2) / 2);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(message.substr(2 + i * 2, 2), 16);
      }
      const text = new TextDecoder().decode(bytes);
      if (/^[\x20-\x7E\n\r\t]*$/.test(text)) decoded = text;
    } catch { /* fall through */ }
  }
  return decoded.length > 30 ? decoded.slice(0, 30) + "…" : decoded;
}

function describeApproval(item: PendingApproval): ApprovalDisplay {
  const req = item.request;
  const host = hostnameOf(req.origin);
  const letter = host.charAt(0).toUpperCase() || "?";
  switch (req.kind) {
    case "connect":
      return { title: `Connect · ${host}`, subtitle: "Connection request", letter };
    case "personal_sign":
      return { title: `Sign message · ${host}`, subtitle: previewMessage(req.message), letter };
    case "typed_sign":
      return { title: `Sign typed data · ${host}`, subtitle: req.parsed?.primaryType ?? "EIP-712", letter };
    case "send_tx":
      return { title: `Send · ${host}`, subtitle: req.tx.to ? `to ${shortAddr(req.tx.to)}` : "transaction", letter };
    case "add_chain":
      return { title: `Add network · ${host}`, subtitle: req.chain.chainName, letter };
    case "switch_chain":
      return { title: `Switch network · ${host}`, subtitle: req.chainId, letter };
  }
}

function PendingShelf() {
  const { queue, loading } = useApprovalQueue();
  if (loading || queue.length === 0) return null;

  return (
    <div className="ext-card" style={{ marginTop: 6 }}>
      <div className="ext-card__head">
        <h3>Pending requests</h3>
        <div className="spacer" />
        <span style={{ fontFamily: "var(--f-mono)", fontSize: 10, color: "var(--fg-500)", letterSpacing: "0.08em", textTransform: "uppercase" }}>{queue.length} open</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {queue.map((item) => {
          const display = describeApproval(item);
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => { void bgFocusApproval(item.id); }}
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
              <div style={{ width: 28, height: 28, borderRadius: 7, fontSize: 12, display: "grid", placeItems: "center", fontFamily: "var(--f-mono)", fontWeight: 700, color: "#fff", background: "linear-gradient(135deg, #8a3fa5, #4a1f5a)" }}>
                {display.letter}
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 500, color: "var(--fg-100)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{display.title}</div>
                <div style={{ fontFamily: "var(--f-mono)", fontSize: 10, color: "var(--fg-400)", marginTop: 2, letterSpacing: "0.02em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{display.subtitle}</div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---- Hero chip (Total / Staked) ----
//
// Tappable card pair under the hero balance. `Total` is always live
// and reflects `account.balance`. `Staked` is rendered in disabled
// style (opacity 0.6, no onClick) until the delegation precompile
// (0x100A) activates on Sprintnet; the visual hierarchy keeps the
// "could-be-active" affordance so wiring later is just a prop flip.
interface HeroChipProps {
  label: string;
  value: string;
  active: boolean;
  disabled?: boolean;
  onClick?: () => void;
}

function HeroChip({ label, value, active, disabled, onClick }: HeroChipProps) {
  return (
    <div
      onClick={disabled ? undefined : onClick}
      style={{
        flex: 1,
        minWidth: 120,
        padding: "10px 14px",
        borderRadius: 12,
        border: active
          ? "1px solid var(--gold)"
          : "1px solid var(--fg-700)",
        background: active ? "var(--gold-bg)" : "transparent",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
        transition: "background 160ms var(--e-out), border-color 160ms var(--e-out)",
      }}
    >
      <div
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 9.5,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          color: "var(--fg-400)",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 16,
          fontWeight: 600,
          color: "var(--fg-100)",
          marginTop: 4,
          letterSpacing: "-0.01em",
        }}
      >
        {value}
      </div>
    </div>
  );
}

// ---- Home screen ----
interface HomeProps {
  account: Account;
  network: ChainEntry;
  indexer: WalletIndexerSnapshot | null;
  onOpenAccounts: () => void;
  onSettings: () => void;
  onOpenReceive: () => void;
  /** Optional so a wallet harness without the route wired still compiles cleanly. */
  onOpenSend?: () => void;
  onOpenStake?: () => void;
  onOpenBridge?: () => void;
  /** Phase 5 Commit 7 — fired by NftDetail's Send CTA. App.tsx
   *  stashes the target NFT and routes to the SendNft screen. */
  onOpenSendNft?: (target: SendNftTarget) => void;
  onOpenOnboard: () => void;
  /** Phase 9 Commit 7 — slot rendered at the top of the Home body
   *  for the post-onboarding hint bar (OnboardingHintBar). Optional
   *  so test harnesses + callers without the route wired still
   *  render. */
  topSlot?: ReactNode;
}

export function Home({ account, network, indexer, onOpenAccounts, onSettings, onOpenReceive, onOpenSend, onOpenStake, onOpenBridge, onOpenSendNft, onOpenOnboard, topSlot }: HomeProps) {
  const [tab, setTab] = useState<"assets" | "activity" | "nfts">("assets");
  const [activeChip, setActiveChip] = useState<"total" | "staked">("total");
  const isPriv = account.denom === "private";
  const totalStr = account.balance != null ? fmt(account.balance, 2) : "0.00";
  // Activity rows now flow through useActivity() inside ActivityList —
  // see src/popup/components/ActivityList.tsx. The Home component no
  // longer reads `indexer?.addressActivity` directly. `liveLabel` is
  // still used for the Hero card's account-name display.
  const liveLabel = indexer?.addressLabel;
  const latestDelegation = indexer?.delegationHistory[0] ?? null;
  // Staked is hardcoded zero until the delegation precompile (0x100A)
  // activates on Sprintnet — see ADR-0015. The Staked chip is rendered
  // disabled-style in the meantime; the hero number falls back to
  // "0.00" when staked is the active view, which is accurate, not a
  // placeholder.
  const stakedStr = "0.00";
  const heroStr = activeChip === "total" ? totalStr : stakedStr;
  const [intPart, fracPart] = heroStr.split(".");

  return (
    <>
      <Top
        account={account}
        onOpenAccounts={onOpenAccounts}
        onSettings={onSettings}
      />
      <div className="ext-body">
        {topSlot}
        {/* Hero */}
        <div className="ext-card ext-hero">
          <div className="lbl">{isPriv ? "Private balance · LYTH-p" : liveLabel?.displayName ?? "Available · LYTH"}</div>
          {isPriv ? (
            <div className="num opaque">— amount hidden by design</div>
          ) : (
            <div className="num">
              {intPart}
              <span className="frac">.{fracPart ?? "00"}</span>
              <span className="d">LYTH</span>
            </div>
          )}
          {!isPriv && (
            <div className="chg">
              {activeChip === "total"
                ? "—% · 24h · attested"
                : latestDelegation
                  ? `${latestDelegation.kind} · C-${String(latestDelegation.cluster + 1).padStart(3, "0")} · ${latestDelegation.weightBps} bps`
                  : "delegated · 0 / 10 clusters"}
            </div>
          )}
          {isPriv && (
            <div className="chg" style={{ color: "oklch(0.78 0.14 240)" }}>
              {account.envelopes ?? 0} envelopes · 30d · DAC 100%
            </div>
          )}

          {!isPriv && (
            <div
              style={{
                display: "flex",
                gap: 10,
                marginTop: 14,
              }}
            >
              <HeroChip
                label="Total"
                value={totalStr}
                active={activeChip === "total"}
                disabled={false}
                onClick={() => setActiveChip("total")}
              />
              <HeroChip
                label="Staked"
                value={stakedStr}
                active={activeChip === "staked"}
                disabled
              />
            </div>
          )}

          {/* Whitepaper §13 bifurcation surface — private LYTH ships in a
              later phase (Sprintnet activates the private side after
              mainnet); this row makes the model visible so users learn it
              exists. No fetch, no chain call. */}
          {!isPriv && (
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginTop: 10,
                padding: "8px 12px",
                borderRadius: 10,
                background: "rgba(124,127,255,0.06)",
                border: "1px dashed var(--fg-700)",
              }}
            >
              <div
                style={{
                  fontFamily: "var(--f-mono)",
                  fontSize: 10,
                  letterSpacing: "0.16em",
                  textTransform: "uppercase",
                  color: "var(--fg-400)",
                }}
              >
                Private LYTH
              </div>
              <div
                style={{
                  fontFamily: "var(--f-mono)",
                  fontSize: 11,
                  color: "var(--fg-400)",
                  fontStyle: "italic",
                }}
              >
                — coming soon
              </div>
            </div>
          )}

          <div className="ext-hero-acts">
            <button className="ext-act prim" onClick={onOpenSend ?? (() => {})}>
              <span className="ico"><Icon name="send" size={16} /></span>
              <span>Send</span>
            </button>
            <button className="ext-act" onClick={onOpenReceive}>
              <span className="ico"><Icon name="receive" size={16} /></span>
              <span>Receive</span>
            </button>
            <button className="ext-act" onClick={onOpenStake ?? (() => {})}>
              <span className="ico"><Icon name="stake" size={16} /></span>
              <span>Stake</span>
            </button>
            <button className="ext-act" onClick={onOpenBridge ?? (() => {})}>
              <span className="ico"><Icon name="bridge" size={16} /></span>
              <span>Bridge</span>
            </button>
          </div>
        </div>

        {/* Pending requests shelf */}
        <PendingShelf />

        {/* Recent dApps */}
        <div className="ext-card">
          <div className="ext-card__head">
            <h3>Recent dApps</h3>
            <div className="spacer" />
            <button className="more" onClick={onSettings}>Manage →</button>
          </div>
          <div className="ext-dapp-row">
            {DAPPS.slice(0, 4).map((d) => (
              <div
                key={d.id}
                className="ext-dapp"
                style={{ opacity: 0.6, cursor: "default" }}
              >
                <div className={`glyph ${d.icon}`}>{d.glyph ?? d.icon}</div>
                <div className="nm">{d.name}</div>
                <div className="last">{d.lastUsed}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Tabs */}
        {/* Phase 11 Commit 10 — ARIA tablist + tab + tabpanel pattern.
            Screen readers announce "Tab Assets, 1 of 3, selected" when
            focused; keyboard arrow navigation between tabs comes for
            free from native browser button behaviour + the role hint. */}
        <div className="ext-card">
          <div className="ext-tabs" role="tablist" aria-label="Home content">
            <button
              role="tab"
              aria-selected={tab === "assets"}
              aria-controls="ext-tabpanel-assets"
              id="ext-tab-assets"
              className={tab === "assets" ? "on" : ""}
              onClick={() => setTab("assets")}
            >
              Assets
            </button>
            <button
              role="tab"
              aria-selected={tab === "activity"}
              aria-controls="ext-tabpanel-activity"
              id="ext-tab-activity"
              className={tab === "activity" ? "on" : ""}
              onClick={() => setTab("activity")}
            >
              Activity
            </button>
            <button
              role="tab"
              aria-selected={tab === "nfts"}
              aria-controls="ext-tabpanel-nfts"
              id="ext-tab-nfts"
              className={tab === "nfts" ? "on" : ""}
              onClick={() => setTab("nfts")}
            >
              NFTs
            </button>
          </div>
          {tab === "assets" && (
            <div
              role="tabpanel"
              id="ext-tabpanel-assets"
              aria-labelledby="ext-tab-assets"
            >
              <AssetList account={account} network={network} indexer={indexer} />
            </div>
          )}
          {tab === "activity" && (
            <div
              role="tabpanel"
              id="ext-tabpanel-activity"
              aria-labelledby="ext-tab-activity"
            >
              <ActivityList
                addr={account.addr.startsWith("0x") ? account.addr : null}
                chainIdHex={network.chainId}
              />
            </div>
          )}
          {tab === "nfts" && (
            <div
              role="tabpanel"
              id="ext-tabpanel-nfts"
              aria-labelledby="ext-tab-nfts"
            >
              <NftTab
                ownerAddress={account.addr.startsWith("0x") ? account.addr : null}
                chainId={network.chainIdNum}
                chainIdHex={network.chainId}
                {...(onOpenSendNft ? { onOpenSendNft } : {})}
              />
            </div>
          )}
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
                <div className="chain">{shortAddr(bech32mDisplay(a.addr), 18)} · {a.denom} · {a.algo === "slhdsa" ? "SLH-DSA" : "ML-DSA"}</div>
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

// Stake page moved to src/popup/pages/Stake.tsx (Phase 7 commit 2).
// The placeholder static-strategy mock that used to live here was
// replaced by the cluster picker + amount form orchestrator. Routing
// still goes through App.tsx's "stake" screen → ./pages/Stake.

// ---- Bridge sheet ----
//
// Disclosure-only bridge surface. It renders route trust/liquidity fields
// only when the active API returns bridgeRouteDisclosure(s); absent or
// incomplete disclosure keeps the wallet in a closed, non-submit state.

interface BridgeProps {
  onBack: () => void;
  indexer: WalletIndexerSnapshot | null;
}

export function Bridge({ onBack, indexer }: BridgeProps) {
  const disclosures = collectBridgeRouteDisclosuresFromIndexer(indexer);
  const displays = disclosures.map(formatBridgeRouteDisclosureDisplay);
  const hasSubmitReadyDisclosure = displays.some(
    bridgeRouteDisclosureHasRequiredFloorData,
  );

  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack}>
          <Icon name="back" size={15} />
        </button>
        <div style={{ flex: 1, fontSize: 13, fontWeight: 600, textAlign: "center" }}>
          Cross-chain bridge
        </div>
        <div style={{ width: 28 }} />
      </div>
      <div className="ext-body">
        <div className="ext-card" style={{ padding: 14 }}>
          <p
            style={{
              margin: 0,
              fontSize: 12.5,
              lineHeight: 1.5,
              color: "var(--fg-100)",
            }}
          >
            Bridge routes require published trust disclosure and liquidity or
            floor data. This wallet only displays fields returned by the active
            operator API and does not infer missing route metadata.
          </p>
        </div>

        {displays.length === 0 ? (
          <div className="ext-card" style={{ padding: 14 }}>
            <div
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                color: "var(--fg-100)",
              }}
            >
              Disclosure unavailable
            </div>
            <div
              style={{
                fontSize: 11.5,
                lineHeight: 1.45,
                color: "var(--fg-400)",
                marginTop: 6,
              }}
            >
              No bridgeRouteDisclosure or bridgeRouteDisclosures field was
              returned for the active wallet data.
            </div>
          </div>
        ) : (
          displays.map((display, index) => (
            <div className="ext-card" style={{ padding: 14 }} key={index}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  marginBottom: 10,
                }}
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
                  Route disclosure {index + 1}
                </div>
                <span
                  className={
                    bridgeRouteDisclosureHasRequiredFloorData(display)
                      ? "ext-badge-att"
                      : "ext-badge-bridged"
                  }
                >
                  {bridgeRouteDisclosureHasRequiredFloorData(display)
                    ? "Published"
                    : "Incomplete"}
                </span>
              </div>
              <BridgeDisclosureSection
                title="Trust"
                rows={display.trustRows}
                empty="No trust disclosure fields returned."
              />
              <BridgeDisclosureSection
                title="Liquidity / floors"
                rows={display.liquidityRows}
                empty="No liquidity or floor fields returned."
              />
              {display.otherRows.length > 0 && (
                <BridgeDisclosureSection
                  title="Other published fields"
                  rows={display.otherRows}
                  empty=""
                />
              )}
            </div>
          ))
        )}

        <div className="ext-card" style={{ padding: 14 }}>
          <div
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 10,
              color: "var(--fg-400)",
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              marginBottom: 10,
            }}
          >
            Bridge submission
          </div>
          <div
            style={{
              margin: 0,
              fontSize: 11.5,
              lineHeight: 1.45,
              color: "var(--fg-400)",
            }}
          >
            {hasSubmitReadyDisclosure
              ? "The wallet can display the published disclosure data, but this build has no bridge submit path."
              : "Disabled because no route returned both trust and liquidity/floor disclosure data."}
          </div>
        </div>
      </div>
    </>
  );
}

interface BridgeDisclosureSectionProps {
  title: string;
  rows: BridgeDisclosureRowDisplay[];
  empty: string;
}

function BridgeDisclosureSection({
  title,
  rows,
  empty,
}: BridgeDisclosureSectionProps) {
  return (
    <div style={{ marginTop: 10 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: "var(--fg-200)",
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      {rows.length === 0 ? (
        <div
          style={{
            padding: "8px 10px",
            borderRadius: 8,
            border: "1px dashed var(--fg-700)",
            color: "var(--fg-500)",
            fontSize: 11,
            lineHeight: 1.4,
          }}
        >
          {empty}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {rows.map((row) => (
            <div
              key={`${row.keyPath}:${row.value}`}
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
                gap: 8,
                padding: "8px 10px",
                borderRadius: 8,
                border: "1px solid var(--fg-700)",
                background: "rgba(255,255,255,0.02)",
              }}
            >
              <div
                style={{
                  minWidth: 0,
                  fontFamily: "var(--f-mono)",
                  fontSize: 10,
                  color: "var(--fg-400)",
                  overflowWrap: "anywhere",
                }}
              >
                {row.keyPath}
              </div>
              <div
                style={{
                  minWidth: 0,
                  fontSize: 11,
                  color: "var(--fg-100)",
                  textAlign: "right",
                  overflowWrap: "anywhere",
                }}
              >
                {row.value}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// (Send page lives at ./pages/Send.tsx since Phase 3.)

// ---- Networks picker ----
interface NetworksProps {
  current: ChainEntry;
  chains: ChainEntry[];
  onBack: () => void;
  onOpenDetail: (chainId: string) => void;
  onOpenAddCustom: () => void;
}

export function Networks({ current, chains, onBack, onOpenDetail, onOpenAddCustom }: NetworksProps) {
  const builtin = chains.filter((c) => c.builtin);
  const custom = chains.filter((c) => !c.builtin);
  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack}><Icon name="back" size={15} /></button>
        <div style={{ flex: 1, fontSize: 13, fontWeight: 600, textAlign: "center" }}>Networks</div>
        <div style={{ width: 28 }} />
      </div>
      <div className="ext-body">
        <NetworksSection
          title="Official"
          chains={builtin}
          currentChainId={current.chainId}
          onOpenDetail={onOpenDetail}
          emptyHint={null}
        />
        <NetworksSection
          title="Custom"
          chains={custom}
          currentChainId={current.chainId}
          onOpenDetail={onOpenDetail}
          emptyHint="No custom chains added yet."
        />
        <button
          className="ext-act"
          onClick={onOpenAddCustom}
          style={{ width: "100%", padding: "10px", flexDirection: "row", gap: 8 }}
        >
          <Icon name="plus" size={13} /> Add custom chain
        </button>
      </div>
    </>
  );
}

interface NetworksSectionProps {
  title: string;
  chains: ChainEntry[];
  currentChainId: string;
  onOpenDetail: (chainId: string) => void;
  emptyHint: string | null;
}

function NetworksSection({ title, chains, currentChainId, onOpenDetail, emptyHint }: NetworksSectionProps) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 10,
          color: "var(--fg-400)",
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          margin: "8px 12px 6px",
        }}
      >
        {title}
      </div>
      {chains.length === 0 ? (
        emptyHint && (
          <div
            style={{
              fontSize: 12,
              color: "var(--fg-400)",
              padding: "12px 18px",
              fontStyle: "italic",
            }}
          >
            {emptyHint}
          </div>
        )
      ) : (
        <div className="ext-card" style={{ padding: "6px 10px" }}>
          {chains.map((c) => {
            const active = c.chainId === currentChainId;
            return (
              <div
                key={c.chainId}
                onClick={() => onOpenDetail(c.chainId)}
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
                      {c.name}
                      {c.official && (
                        <span className="ext-badge-att" style={{ fontSize: 8 }}>
                          <Icon name="shield" size={8} /> Official
                        </span>
                      )}
                    </div>
                    <div
                      style={{
                        fontFamily: "var(--f-mono)",
                        fontSize: 10,
                        color: "var(--fg-400)",
                        marginTop: 3,
                        letterSpacing: "0.02em",
                        wordBreak: "break-all",
                      }}
                    >
                      {c.rpc}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", fontFamily: "var(--f-mono)", fontSize: 10 }}>
                    {active && (
                      <div style={{ color: "var(--gold)" }}>
                        <Icon name="check" size={14} />
                      </div>
                    )}
                    <div style={{ color: "var(--fg-400)", marginTop: active ? 4 : 0 }}>{c.chainId}</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---- Sheet wrapper for request dialogs ----
interface ReqSheetProps {
  onBack: () => void;
  children: ReactNode;
}

function ReqSheet({ onBack, children }: ReqSheetProps) {
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

// ---- Connect request ----
//
// Reads the real ConnectRequest from the service worker (origin only —
// the real protocol carries no perms list or phishing score, so the
// previous demo perms / verified-badge / phishing-score sections are
// gone). The account-to-share row uses RevealableAddressBlock so the
// user sees the canonical bech32m form first and can reveal 0x via
// the §22.7 warning gate, consistent with Home / Receive / Settings.
interface ReqConnectProps {
  request: ConnectRequest;
  /** Active account address from the keystore (0x wire format). */
  address: string;
  custody: Custody;
  onApprove: () => void;
  onReject: () => void;
  chain: ChainEntry;
}

export function ReqConnect({
  request,
  address,
  custody,
  onApprove,
  onReject,
  chain,
}: ReqConnectProps) {
  const { origin } = request;
  let hostname = origin;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    // origin may already be a bare hostname or otherwise unparseable;
    // fall back to the raw string.
  }
  const initial = (hostname[0] ?? "?").toUpperCase();

  const originWarnings = detectOriginWarnings(origin);
  const hasDanger = originWarnings.some((w) => w.level === "danger");

  return (
    <>
      <ChainStatusBanner network={chain} />
      <div className="req-head">
        <div className="origin">
          <div className="fav G">{initial}</div>
          <div className="info">
            <div className="n">{hostname}</div>
            <div className="u" title={origin}>{origin}</div>
          </div>
          <div style={{ fontFamily: "var(--f-mono)", fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--fg-200)", padding: "3px 7px", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4 }}>
            connect
          </div>
        </div>
        <h2>Connect this site?</h2>
        <div className="sub">grants read access to your address — no signing</div>
      </div>

      <OriginWarningPanel warnings={originWarnings} />

      <div className="req-section">
        <div className="req-section__h">Origin</div>
        <div
          style={{
            padding: "10px 12px",
            borderRadius: 10,
            background: "rgba(0,0,0,0.3)",
            border: hasDanger
              ? "1px solid rgba(220,80,80,0.4)"
              : "1px solid rgba(255,255,255,0.05)",
            fontFamily: "var(--f-mono)",
            fontSize: 11.5,
            color: "var(--fg-100)",
            wordBreak: "break-all",
          }}
        >
          {origin}
        </div>
      </div>

      <div className="req-section">
        <div className="req-section__h">Account to share</div>
        <div
          style={{
            padding: "10px 12px",
            borderRadius: 10,
            background: "rgba(0,0,0,0.3)",
            border: "1px solid rgba(255,255,255,0.05)",
          }}
        >
          {address ? (
            <RevealableAddressBlock addr0x={address} />
          ) : (
            <div style={{ fontFamily: "var(--f-mono)", fontSize: 11, color: "var(--fg-400)" }}>
              —
            </div>
          )}
        </div>
      </div>

      <CustodyBadge mode={custody} />
      <div className="req-foot">
        <button onClick={onReject}>Reject</button>
        <button className={hasDanger ? "danger" : "prim"} onClick={onApprove}>
          {hasDanger ? "Connect anyway" : "Connect"}
        </button>
      </div>
    </>
  );
}

export { ReqSheet };

// ---------------------------------------------------------------------------
// Real-payload approval views (Stage 4)
//
// These render the actual EIP-1193 request the dapp sent — no demo-data here.
// The service worker pre-populates a `SendTxView` (execution-unit budget,
// fee price, simulation, nonce) and an EIP-712 `digest` so the popup can
// show real numbers without RPC access of its own. The view still carries
// inherited `gas`/`gasPrice` field names at the EIP-1193 boundary.
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

const LYTHOSHI_PER_LYTH = 100_000_000n;

export function parseHexQuantity(hex: string | null | undefined): bigint | null {
  if (!hex) return null;
  try {
    return BigInt(hex.startsWith("0x") || hex.startsWith("0X") ? hex : "0x" + hex);
  } catch {
    return null;
  }
}

export function formatExecutionUnits(hex: string | null | undefined): string {
  const b = parseHexQuantity(hex);
  return b == null ? "—" : b.toString(10);
}

export function formatLythoshiPerExecutionUnit(hex: string | null | undefined): string {
  const b = parseHexQuantity(hex);
  if (b == null) return "—";
  return b.toString(10);
}

export function lythoshiToLythString(lythoshi: bigint, decimals = 8): string {
  if (lythoshi <= 0n) return "0";
  const whole = lythoshi / LYTHOSHI_PER_LYTH;
  const frac = lythoshi % LYTHOSHI_PER_LYTH;
  const clampedDecimals = Math.max(0, Math.min(8, Math.trunc(decimals)));
  if (frac === 0n || clampedDecimals === 0) return whole.toString();
  const fracStr = frac
    .toString()
    .padStart(8, "0")
    .slice(0, clampedDecimals)
    .replace(/0+$/, "");
  return fracStr.length > 0 ? `${whole}.${fracStr}` : whole.toString();
}

export function formatLythoshiAmountHex(hex: string | null | undefined): string {
  const b = parseHexQuantity(hex);
  if (b == null) return "—";
  return lythoshiToLythString(b);
}

type FeeTier = "low" | "medium" | "high";

export function applyFeeTier(
  pricePerExecutionUnitLythoshi: bigint,
  tier: FeeTier,
): bigint {
  if (tier === "low") return (pricePerExecutionUnitLythoshi * 90n) / 100n;
  if (tier === "high") return (pricePerExecutionUnitLythoshi * 130n) / 100n;
  return pricePerExecutionUnitLythoshi;
}

export function computeNativeFeeLythoshi(
  executionUnitsHex: string | null | undefined,
  pricePerExecutionUnitHex: string | null | undefined,
  tier: FeeTier,
): bigint | null {
  const executionUnits = parseHexQuantity(executionUnitsHex);
  const basePrice = parseHexQuantity(pricePerExecutionUnitHex);
  if (executionUnits == null || basePrice == null) return null;
  return executionUnits * applyFeeTier(basePrice, tier);
}

// ---- calldata decoder ----
//
// Best-effort decoder for the small set of selectors that account for ~95% of
// what a user will see on a write-op approval (token transfers + approvals).
// Anything we can't recognise falls back to the raw section already rendered
// below — we never claim to "decode" something we don't actually understand.
//
// Why hand-rolled instead of ethers' `Interface`: the popup does not have
// network access (the SW does), and we want zero false positives. Recognising
// four selectors locally is robust; pulling in a registry that might
// auto-suggest the wrong ABI is exactly the phishing-friendly path we don't
// want to ship.

interface DecodedCall {
  /** Function name pulled from the matched selector. */
  name: string;
  /** Selector hex, e.g. `0xa9059cbb`. */
  selector: string;
  /** Decoded args in display order. */
  args: Array<{ name: string; type: string; value: string }>;
}

function decodeCalldata(data: string): DecodedCall | null {
  if (!data || !data.startsWith("0x") || data.length < 10) return null;
  const selector = data.slice(0, 10).toLowerCase();
  const body = data.slice(10);
  switch (selector) {
    case "0xa9059cbb": {
      // ERC-20 transfer(address,uint256)
      const to = readAddress(body, 0);
      const amount = readUint256(body, 1);
      if (!to || amount == null) return null;
      return {
        name: "transfer",
        selector,
        args: [
          { name: "to", type: "address", value: to },
          { name: "amount", type: "uint256", value: amount.toString(10) },
        ],
      };
    }
    case "0x095ea7b3": {
      // ERC-20 approve(address,uint256)
      const spender = readAddress(body, 0);
      const amount = readUint256(body, 1);
      if (!spender || amount == null) return null;
      const approvalLabel =
        amount === (1n << 256n) - 1n ? "unlimited" : amount.toString(10);
      return {
        name: "approve",
        selector,
        args: [
          { name: "spender", type: "address", value: spender },
          { name: "amount", type: "uint256", value: approvalLabel },
        ],
      };
    }
    case "0x23b872dd": {
      // ERC-20 transferFrom(address,address,uint256)
      const from = readAddress(body, 0);
      const to = readAddress(body, 1);
      const amount = readUint256(body, 2);
      if (!from || !to || amount == null) return null;
      return {
        name: "transferFrom",
        selector,
        args: [
          { name: "from", type: "address", value: from },
          { name: "to", type: "address", value: to },
          { name: "amount", type: "uint256", value: amount.toString(10) },
        ],
      };
    }
    case "0x42842e0e": {
      // ERC-721 safeTransferFrom(address,address,uint256)
      const from = readAddress(body, 0);
      const to = readAddress(body, 1);
      const tokenId = readUint256(body, 2);
      if (!from || !to || tokenId == null) return null;
      return {
        name: "safeTransferFrom",
        selector,
        args: [
          { name: "from", type: "address", value: from },
          { name: "to", type: "address", value: to },
          { name: "tokenId", type: "uint256", value: tokenId.toString(10) },
        ],
      };
    }
    default:
      return null;
  }
}

function readAddress(body: string, slot: number): string | null {
  const word = body.slice(slot * 64, (slot + 1) * 64);
  if (word.length !== 64) return null;
  // Address is the rightmost 20 bytes of a 32-byte word.
  return "0x" + word.slice(24);
}

function readUint256(body: string, slot: number): bigint | null {
  const word = body.slice(slot * 64, (slot + 1) * 64);
  if (word.length !== 64) return null;
  try {
    return BigInt("0x" + word);
  } catch {
    return null;
  }
}

// ---- send_tx approval ----
interface ReqSendTxProps {
  request: SendTxRequest;
  custody: Custody;
  signerAddress: string;
  onApprove: () => void;
  onReject: () => void;
  chain: ChainEntry;
}

export function ReqSendTx({
  request,
  custody,
  signerAddress,
  onApprove,
  onReject,
  chain,
}: ReqSendTxProps) {
  const { tx, view, origin } = request;
  const [tier, setTier] = useState<FeeTier>("medium");
  const [showRaw, setShowRaw] = useState(false);
  const [showSim, setShowSim] = useState(true);

  const originWarnings = detectOriginWarnings(origin);
  const hasOriginDanger = originWarnings.some((w) => w.level === "danger");

  const baseExecutionUnitPrice = parseHexQuantity(view.gasPrice);
  const tieredExecutionUnitPrice =
    baseExecutionUnitPrice == null
      ? null
      : applyFeeTier(baseExecutionUnitPrice, tier);
  const tieredHex =
    tieredExecutionUnitPrice == null ? null : "0x" + tieredExecutionUnitPrice.toString(16);

  const totalFeeLythoshi = computeNativeFeeLythoshi(
    view.estimatedGas,
    view.gasPrice,
    tier,
  );
  const totalFeeHex =
    totalFeeLythoshi == null ? null : "0x" + totalFeeLythoshi.toString(16);

  const value = tx.value;
  const data = tx.data ?? "0x";
  const hasCalldata = data.length > 2;
  const decoded = hasCalldata ? decodeCalldata(data) : null;
  const [showDecoded, setShowDecoded] = useState(true);

  return (
    <>
      <ChainStatusBanner network={chain} />
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

      <OriginWarningPanel warnings={originWarnings} />

      <div className="req-section">
        <div className="req-section__h">From</div>
        <div className="req-kv">
          <span className="k">Signer</span>
          <span className="v" style={{ fontFamily: "var(--f-mono)", fontSize: 11 }}>
            {bech32mDisplay(signerAddress)}
          </span>
        </div>
        <div className="req-kv">
          <span className="k">To</span>
          <span className="v" style={{ fontFamily: "var(--f-mono)", fontSize: 11 }}>
            {tx.to ? bech32mDisplay(tx.to) : "(contract creation)"}
          </span>
        </div>
        <div className="req-kv">
          <span className="k">Value</span>
          <span className="v">{value ? `${formatLythoshiAmountHex(value)} LYTH` : "0 LYTH"}</span>
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
        <div className="req-section__h">Network fee</div>
        <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
          {(["low", "medium", "high"] as FeeTier[]).map((t) => (
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
          <span className="k">Execution-unit limit</span>
          <span className="v">{formatExecutionUnits(view.estimatedGas)}</span>
        </div>
        <div className="req-kv">
          <span className="k">Price / execution unit</span>
          <span className="v">{formatLythoshiPerExecutionUnit(tieredHex)} lythoshi</span>
        </div>
        <div className="req-kv">
          <span className="k">Max fee</span>
          <span className="v">
            {totalFeeHex ? `${formatLythoshiAmountHex(totalFeeHex)} LYTH` : "—"}
          </span>
        </div>
      </div>

      {decoded && (
        <div className="req-section">
          <div className="req-section__h">
            <span>Decoded call</span>
            <button onClick={() => setShowDecoded((v) => !v)}>
              {showDecoded ? "hide" : "show"} ↓
            </button>
          </div>
          {showDecoded && (
            <>
              <div className="req-kv">
                <span className="k">Function</span>
                <span className="v" style={{ fontFamily: "var(--f-mono)", fontSize: 11 }}>
                  {decoded.name} <span style={{ color: "var(--fg-500)" }}>({decoded.selector})</span>
                </span>
              </div>
              {decoded.args.map((a) => (
                <div className="req-kv" key={a.name}>
                  <span className="k">{a.name}</span>
                  <span
                    className="v"
                    style={{ fontFamily: "var(--f-mono)", fontSize: 11, wordBreak: "break-all" }}
                  >
                    {a.value}
                    <span style={{ color: "var(--fg-500)", marginLeft: 6 }}>{a.type}</span>
                  </span>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {hasCalldata && !decoded && (
        <div className="req-section">
          <div className="req-warn warn">
            <Icon name="warn" size={14} />
            <div>
              <b>Unrecognised calldata.</b> Selector {data.slice(0, 10)} is not in the wallet's
              decoder set — review the raw bytes below before approving.
            </div>
          </div>
        </div>
      )}

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
        <button
          className={hasOriginDanger ? "danger" : "prim"}
          onClick={onApprove}
        >
          {custody === "hw"
            ? "Confirm on device"
            : hasOriginDanger
              ? "Sign & send anyway"
              : "Sign & send"}
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
  chain: ChainEntry;
}

export function ReqPersonalSignReal({
  request,
  custody,
  onApprove,
  onReject,
  chain,
}: ReqPersonalSignRealProps) {
  const { message, address, origin } = request;
  const isHex = message.startsWith("0x") || message.startsWith("0X");
  const bytes = isHex ? hexToBytes(message) : new TextEncoder().encode(message);
  const utf8 = isHex ? bytesToUtf8IfPrintable(bytes) : message;
  const [showRaw, setShowRaw] = useState(false);

  const originWarnings = detectOriginWarnings(origin);
  const messageWarnings = detectMessageWarnings(message);
  const hasDanger =
    originWarnings.some((w) => w.level === "danger") ||
    messageWarnings.some((w) => w.level === "danger");

  return (
    <>
      <ChainStatusBanner network={chain} />
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

      <OriginWarningPanel warnings={originWarnings} />
      <MessageWarningPanel warnings={messageWarnings} />

      <div className="req-section">
        <div className="req-section__h">Signing as</div>
        <div className="req-kv">
          <span className="k">Address</span>
          <span className="v" style={{ fontFamily: "var(--f-mono)", fontSize: 11 }}>
            {bech32mDisplay(address)}
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
        <button
          className={hasDanger ? "danger" : "prim"}
          onClick={onApprove}
        >
          {custody === "hw"
            ? "Confirm on device"
            : hasDanger
              ? "Sign anyway"
              : "Sign message"}
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
  chain: ChainEntry;
}

export function ReqTypedSign({
  request,
  custody,
  onApprove,
  onReject,
  chain,
}: ReqTypedSignProps) {
  const { parsed, digest, address, origin, rawTypedData } = request;
  const [showRaw, setShowRaw] = useState(false);

  const originWarnings = detectOriginWarnings(origin);
  const hasOriginDanger = originWarnings.some((w) => w.level === "danger");

  return (
    <>
      <ChainStatusBanner network={chain} />
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

      <OriginWarningPanel warnings={originWarnings} />

      <div className="req-section">
        <div className="req-section__h">Signing as</div>
        <div className="req-kv">
          <span className="k">Address</span>
          <span className="v" style={{ fontFamily: "var(--f-mono)", fontSize: 11 }}>
            {bech32mDisplay(address)}
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
        <button
          className={hasOriginDanger ? "danger" : "prim"}
          onClick={onApprove}
          disabled={!parsed}
        >
          {custody === "hw"
            ? "Confirm on device"
            : hasOriginDanger
              ? "Sign anyway"
              : "Sign typed data"}
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
  chain: ChainEntry;
}

export function ReqAddChain({ request, onApprove, onReject, chain }: ReqAddChainProps) {
  // `proposed` is the chain the dApp wants to add; `chain` (prop) is the
  // wallet's currently active chain shown in the status banner.
  const { chain: proposed, origin } = request;
  const originWarnings = detectOriginWarnings(origin);
  return (
    <>
      <ChainStatusBanner network={chain} />
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
        <h2>{proposed.chainName}</h2>
        <div className="sub">requesting · adds chain to wallet network list</div>
      </div>

      <OriginWarningPanel warnings={originWarnings} />

      <div className="req-warn warn">
        <Icon name="warn" size={14} />
        <div>
          <b>This chain is not in our verified registry.</b> Adding custom
          RPC endpoints can expose your address and transactions to
          untrusted operators. Only approve if you trust the dApp making
          this request.
        </div>
      </div>

      <div className="req-section">
        <div className="req-section__h">Network</div>
        <div className="req-kv">
          <span className="k">Name</span>
          <span className="v">{proposed.chainName}</span>
        </div>
        <div className="req-kv">
          <span className="k">Chain ID</span>
          <span className="v" style={{ fontFamily: "var(--f-mono)", fontSize: 11 }}>
            {proposed.chainId}
          </span>
        </div>
        {proposed.nativeCurrency && (
          <div className="req-kv">
            <span className="k">Native currency</span>
            <span className="v">
              {proposed.nativeCurrency.symbol} ({proposed.nativeCurrency.name}, {proposed.nativeCurrency.decimals} dp)
            </span>
          </div>
        )}
      </div>

      <div className="req-section">
        <div className="req-section__h">RPC endpoints</div>
        {proposed.rpcUrls.map((u, i) => (
          <div key={i} className="req-kv">
            <span className="k">RPC #{i + 1}</span>
            <span className="v" style={{ fontFamily: "var(--f-mono)", fontSize: 11, wordBreak: "break-all" }}>
              {u}
            </span>
          </div>
        ))}
      </div>

      {proposed.blockExplorerUrls && proposed.blockExplorerUrls.length > 0 && (
        <div className="req-section">
          <div className="req-section__h">Block explorer</div>
          {proposed.blockExplorerUrls.map((u, i) => (
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
