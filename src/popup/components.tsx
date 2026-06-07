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
import {
  BRIDGE_QUOTE_API_BLOCKED_REASON,
  BRIDGE_SUBMIT_API_BLOCKED_REASON,
  NATIVE_AGENT_MODULE_ADDRESS,
  NATIVE_AGENT_MODULE_ADDRESS_BYTES,
  PRECOMPILE_ADDRESSES,
  addressToTypedBech32,
  bridgeDrainRemaining,
  type AddressKind,
  type BridgeCircuitBreakerFields,
} from "@monolythium/core-sdk";
import { Icon, fmt, shortAddr } from "./Icon";
import type { IconName } from "./Icon";
import { bech32mDisplay } from "../shared/bech32m";
import { clusterLabel, formatWeightBpsPercent } from "../shared/staking";
import { RevealableAddressBlock } from "./components/RevealableAddressBlock";
import { Footer } from "./components/Footer";
import {
  ACCOUNTS,
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
  WalletBridgeRouteReadiness,
  MrcAccountLookupResponse,
  MrcAccountRecord,
  MrcPolicyRecord,
  MrcPolicySpendRecord,
  NativeAgentStateResponse,
  NativeAgentStateRow,
  WalletMrcHolder,
  WalletMrcHoldersResponse,
  WalletTokenBalance,
} from "./bg";
import {
  bgWalletOperatorStatus,
  bgWalletChainBlockNumber,
  bgFocusApproval,
  bgWsSubscribeNewHeads,
  bgReadBridgeDrainStatus,
  bgReadBridgeHealth,
} from "./bg";
import type {
  BridgeDrainStatusOutcome,
  BridgeHealthOutcome,
} from "./bg";
import { useApprovalQueue } from "./hooks/useApprovalQueue";
import { useFeature } from "./hooks/useFeature";
import { ActivityList } from "./components/ActivityList";
import { VaultPicker } from "./components/VaultPicker";
import {
  useBridgeRouteSelection,
  type BridgeRouteChoiceCandidate,
} from "./hooks/useBridgeRouteSelection";
import {
  detectOriginWarnings,
  detectMessageWarnings,
  type OriginWarning,
  type MessageWarning,
} from "../shared/phishing";
import {
  computeNativeFeeFromPrice,
  formatExecutionUnits as formatNativeExecutionUnits,
  formatLythoshiAmountHex as formatNativeLythoshiAmountHex,
  formatLythoshiPerExecutionUnit as formatNativeLythoshiPerExecutionUnit,
  lythoshiToLythString as formatLythoshiAsLythString,
  nativeFeeDisplayFromPrice,
  parseNativeHexQuantity,
  scaleByBps,
} from "../shared/native-fee-display";


// ---- Chain status banner (replaces DemoBanner) ----
//
// Reflects the wallet's actual operational state instead of the legacy
// "MOCK · NO REAL VALUE · DESIGN-ONLY" copy. The wallet now holds real
// ML-DSA-65 keys, reads live testnet state, and submits real
// plaintext mesh_submitTx txs — that's worth surfacing. Other parts of the
// UI (Top status bar, account list, activity log) ARE
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
  /** The settings cog migrated from the .ext-top
   *  row into the status banner so the wallet chip below it can
   *  claim the full popup width for the renamed-from-top-bar wallet
   *  label + full-line bech32m address. Omit in approval contexts. */
  onSettings?: () => void;
  /** Connected-sites shortcut. Renders a globe
   *  button to the right of `onSettings` when provided. Omit in
   *  approval contexts. */
  onConnectedSites?: () => void;
  /** Bell entry to the global notifications
   *  page. Renders between Connected sites and the hamburger, with an
   *  optional small unread dot driven by `unreadCount`. The page itself
   *  was added with the Notifications page; the bell is a top-bar entry so the inbox is
   *  reachable without opening the hamburger menu. */
  onNotifications?: () => void;
  /** When > 0, paints a small blue dot on the bell glyph
   *  (no number; the bell-row pill in MainMenu still shows the count).
   *  Caller is expected to fetch this via `bgGetUnread()` and refresh
   *  it on storage change so the dot stays in sync. */
  unreadCount?: number;
  /** Hamburger menu shortcut (was the prior lock
   *  button before the MainMenu screen took over the lock surface).
   *  Renders a 3-line hamburger icon on the far right when provided;
   *  caller routes to the MainMenu screen. */
  onMenu?: () => void;
}

export function ChainStatusBanner({
  network,
  onOpenNetworks,
  onSettings,
  onConnectedSites,
  onNotifications,
  unreadCount,
  onMenu,
}: ChainStatusBannerProps) {
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

    // Opportunistic WS upgrade. Ask the SW to
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
  // a pure side-info readout (which the testnet operator answered our
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
    // Bump text + button sizing so the contents fit
    // the allocated bar height (the bar became 44 px-ish but
    // buttons/text stayed at the original 9.5 px / 22 px sizes that
    // looked undersized in the taller bar). Text 9.5 → 10.5; button
    // bump happens at BannerActionButton (see below).
    fontSize: 10.5,
    letterSpacing: "0.14em",
    textTransform: "uppercase",
    padding: "8px 12px",
    borderBottom: "1px solid var(--fg-700)",
    display: "flex",
    alignItems: "center",
    gap: 8,
    color: "var(--fg-300)",
  };

  // Pill chip styling shared between the interactive (with caret) and
  // read-only (no caret) variants. Read-only is used inside the approval
  // window, where switching chains mid-approval would be unsafe.
  // Slightly larger padding + subtle bg lift so the
  // network selector reads as a clearly tappable pill.
  // Trim 2 px of horizontal padding + 1 px of caret gap so
  // the new bell + hamburger fit comfortably on the right cluster
  // without crowding the network pill on narrower popup widths.
  const chipStyle: CSSProperties = {
    padding: "4px 8px",
    border: "1px solid var(--fg-700)",
    borderRadius: 999,
    background: "rgba(255,255,255,0.04)",
    font: "inherit",
    letterSpacing: "inherit",
    textTransform: "inherit",
    color: "inherit",
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
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

  // Operator name (live/stalled) and offline reason
  // text dropped from the banner. They were noisy filler that
  // competed with the new action-button cluster on the right.
  // `operator` is still polled (the variable is read elsewhere for
  // a future surface — kept rather than ripped out so we don't
  // churn the visibility-gated effect just to delete a setState).
  void operator;
  let dotColor: string;
  let body: ReactNode;
  switch (health.kind) {
    case "live":
      dotColor = "var(--ok)";
      body = (
        <>
          <span style={{ color: "var(--ok)", fontWeight: 500 }}>LIVE</span>
          {networkChip}
        </>
      );
      break;
    case "stalled":
      dotColor = "var(--warn)";
      body = (
        <>
          <span style={{ color: "var(--warn)", fontWeight: 500 }}>STALLED</span>
          {networkChip}
        </>
      );
      break;
    case "offline":
      dotColor = "var(--err)";
      body = (
        <>
          <span style={{ color: "var(--err)", fontWeight: 500 }}>OFFLINE</span>
          {networkChip}
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
      {(onSettings || onConnectedSites || onNotifications || onMenu) && (
        <>
          <span style={{ flex: 1 }} />
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 2,
              flexShrink: 0,
            }}
          >
            {onSettings && (
              <BannerActionButton
                onClick={onSettings}
                ariaLabel="Settings"
                icon="settings"
              />
            )}
            {onConnectedSites && (
              <BannerActionButton
                onClick={onConnectedSites}
                ariaLabel="Connected sites"
                icon="globe"
              />
            )}
            {onNotifications && (
              <BannerActionButton
                onClick={onNotifications}
                ariaLabel="Notifications"
                icon="bell"
                showDot={typeof unreadCount === "number" && unreadCount > 0}
              />
            )}
            {onMenu && (
              <BannerActionButton
                onClick={onMenu}
                ariaLabel="Menu"
                icon="menu"
                showDot={typeof unreadCount === "number" && unreadCount > 0}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

// Small icon-button used inside ChainStatusBanner's
// right-aligned action cluster. Sized to fit the 5 px / 14 px banner
// padding without growing the banner height. The hover bg lift is
// the only affordance — chips below this row supply explicit borders.
function BannerActionButton({
  onClick,
  ariaLabel,
  icon,
  showDot,
}: {
  onClick: () => void;
  ariaLabel: string;
  icon: import("./Icon").IconName;
  /** When true, paints a small blue dot on the button's
   *  top-right corner (matches the `.ext-unread` hue used on rows in
   *  the Notifications page so the affordance reads consistently). */
  showDot?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      title={ariaLabel}
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        // Bump 24×22 → 32×30 to match the taller
        // banner row. Round corners also grow to 7 to
        // match the new chunk. The glyph inside grows 13 → 16 too.
        width: 32,
        height: 30,
        padding: 0,
        background: "transparent",
        border: "none",
        borderRadius: 7,
        color: "var(--fg-300)",
        cursor: "pointer",
        flexShrink: 0,
        transition: "background 120ms, color 120ms",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "rgba(255,255,255,0.06)";
        e.currentTarget.style.color = "var(--fg-100)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.color = "var(--fg-300)";
      }}
    >
      <Icon name={icon} size={16} />
      {showDot && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            top: 5,
            right: 5,
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "oklch(0.78 0.14 240)",
            pointerEvents: "none",
          }}
        />
      )}
    </button>
  );
}

// ---- Top row: brand + account + settings ----
//
// The active chain selector lives in the status bar (`ChainStatusBanner`)
// directly above this row. Top kept the chain chip until the full bech32m address landed,
// when the full bech32m address landed in the account chip and needed
// the freed horizontal width to render in 1-2 lines instead of 3-4.
interface TopProps {
  account: Account;
  onOpenAccounts: () => void;
  onSettings: () => void;
  /** VaultPicker's "New wallet" dropdown entry
   *  dispatches here instead of opening the legacy single-page modal.
   *  Threaded through Home for App-level routing to NewWalletFlow. */
  onNewWalletFlow?: () => void;
  /** Fires after a VaultAddModal completion so App can re-run
   *  refreshKeystoreStatus and the chip shows the new vault's name
   *  immediately (no need to lock/unlock or reopen). */
  onVaultComplete?: () => void;
}

// Chip replaced with <VaultPicker /> (multi-vault
// dropdown). `onOpenAccounts` is preserved on TopProps for caller
// compatibility but no longer consumed here — the legacy Accounts
// screen navigation is vestigial since BIP-32/44 HD derivation was
// removed. Full deletion of the prop chain (HomeProps + App.tsx)
// is a future cleanup.
//
// `onSettings` is also no longer consumed: the cog
// migrated to ChainStatusBanner above this row so the VaultPicker
// chip can claim the full popup width for the wallet name + full
// bech32m address. Prop kept for caller-compat shim; the routing
// edge that previously fired through this button now fires through
// ChainStatusBanner.onSettings (wired in App.tsx).
//
// The ALGO_PLACEHOLDER strip above the picker is the tiny "ML-DSA-65"
// label the user requested instead of the algo badge that used to
// live inside the chip itself (earlier design).
export function Top({ account, onNewWalletFlow, onVaultComplete }: TopProps) {
  return (
    <div className="ext-top" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
      <div
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 9,
          fontWeight: 600,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          // Reads from the --fg-400 token directly (≈7.0:1 on the body
          // surface). A prior `opacity: 0.75` dragged it to ~4.4:1 (sub-AA);
          // removed so the label sits at its token tier. If a quieter step is
          // ever wanted, drop to --fg-500 via token, not opacity.
          color: "var(--fg-400)",
          paddingLeft: 4,
        }}
      >
        ML-DSA-65
      </div>
      <VaultPicker
        activeAccount={account}
        {...(onNewWalletFlow ? { onNewWalletFlow } : {})}
        {...(onVaultComplete ? { onVaultComplete } : {})}
      />
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

export function AssetList({ account, network, indexer }: AssetListProps) {
  const lythAmount = account.balance;
  const liveRows = indexer?.tokenBalances ?? [];
  return (
    <div>
      <MrcAccountSummary mrcAccount={indexer?.mrcAccount ?? null} />
      <NativeAgentStateSummary nativeAgentState={indexer?.nativeAgentState ?? null} />

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
              <MrcHolderSummary mrcHolders={row.mrcHolders} />
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
    </div>
  );
}

function nativeAgentRowString(row: NativeAgentStateRow, keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "boolean") return value ? "true" : "false";
  }
  return null;
}

const NATIVE_AGENT_STATE_ROW_KEYS = [
  "issuers",
  "attestations",
  "consents",
  "services",
  "availability",
  "arbiters",
  "reputationReviews",
  "spendingPolicies",
  "policySpends",
  "escrows",
] as const;

type NativeAgentStateRowKey = (typeof NATIVE_AGENT_STATE_ROW_KEYS)[number];

function nativeAgentRowsForKey(
  nativeAgentState: NativeAgentStateResponse,
  key: NativeAgentStateRowKey,
): NativeAgentStateRow[] {
  const rows = nativeAgentState[key];
  return Array.isArray(rows) ? rows : [];
}

function nativeAgentStateRowCount(nativeAgentState: NativeAgentStateResponse): number {
  return NATIVE_AGENT_STATE_ROW_KEYS.reduce(
    (sum, key) => sum + nativeAgentRowsForKey(nativeAgentState, key).length,
    0,
  );
}

function nativeAgentCountLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function nativeAgentShortRowValue(
  row: NativeAgentStateRow,
  keys: string[],
  fallback = "unknown",
): string {
  return shortAddr(nativeAgentRowString(row, keys) ?? fallback, 10);
}

function nativeAgentFlagLabel(
  row: NativeAgentStateRow,
  keys: string[],
  trueLabel: string,
  falseLabel: string,
): string | null {
  const value = nativeAgentRowString(row, keys);
  if (value === "true") return trueLabel;
  if (value === "false") return falseLabel;
  return null;
}

function nativeAgentNoncePart(row: NativeAgentStateRow): string | null {
  const value = row.nonce;
  if (typeof value === "number" && Number.isFinite(value)) return `nonce ${value}`;
  if (typeof value === "string" && value.trim().length > 0) return `nonce ${value}`;
  return null;
}

function nativeAgentParts(parts: Array<string | null | undefined>): string {
  return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(" · ");
}

interface NativeAgentSummaryFamily {
  key: NativeAgentStateRowKey;
  singular: string;
  plural?: string;
  rows: NativeAgentStateRow[];
  idKeys: string[];
  render: (row: NativeAgentStateRow) => string;
}

function nativeAgentSummaryFamilies(
  nativeAgentState: NativeAgentStateResponse,
): NativeAgentSummaryFamily[] {
  return [
    {
      key: "issuers",
      singular: "issuer",
      rows: nativeAgentRowsForKey(nativeAgentState, "issuers"),
      idKeys: ["issuerId", "issuer_id"],
      render: (row) =>
        nativeAgentParts([
          `issuer ${nativeAgentShortRowValue(row, ["issuerId", "issuer_id"])}`,
          nativeAgentNoncePart(row),
          nativeAgentShortRowValue(row, ["issuer"]),
        ]),
    },
    {
      key: "attestations",
      singular: "attestation",
      rows: nativeAgentRowsForKey(nativeAgentState, "attestations"),
      idKeys: ["attestationId", "attestation_id"],
      render: (row) =>
        nativeAgentParts([
          `attestation ${nativeAgentShortRowValue(row, ["attestationId", "attestation_id"])}`,
          nativeAgentNoncePart(row),
          nativeAgentFlagLabel(row, ["active"], "active", "inactive"),
          `subject ${nativeAgentShortRowValue(row, ["subject"])}`,
        ]),
    },
    {
      key: "consents",
      singular: "consent",
      rows: nativeAgentRowsForKey(nativeAgentState, "consents"),
      idKeys: ["consentId", "consent_id"],
      render: (row) =>
        nativeAgentParts([
          `consent ${nativeAgentShortRowValue(row, ["consentId", "consent_id"])}`,
          nativeAgentNoncePart(row),
          nativeAgentFlagLabel(row, ["active"], "active", "inactive"),
          `grantee ${nativeAgentShortRowValue(row, ["grantee"])}`,
        ]),
    },
    {
      key: "services",
      singular: "service",
      rows: nativeAgentRowsForKey(nativeAgentState, "services"),
      idKeys: ["serviceId", "service_id"],
      render: (row) =>
        nativeAgentParts([
          `service ${nativeAgentShortRowValue(row, ["serviceId", "service_id"])}`,
          nativeAgentNoncePart(row),
          nativeAgentFlagLabel(row, ["active"], "active", "inactive"),
          nativeAgentShortRowValue(row, ["provider"]),
        ]),
    },
    {
      key: "availability",
      singular: "availability",
      plural: "availability",
      rows: nativeAgentRowsForKey(nativeAgentState, "availability"),
      idKeys: ["provider"],
      render: (row) => {
        const openRequests = nativeAgentRowString(row, ["openRequests", "open_requests"]) ?? "0";
        const maxConcurrent = nativeAgentRowString(row, ["maxConcurrent", "max_concurrent"]) ?? "0";
        return nativeAgentParts([
          `availability ${nativeAgentShortRowValue(row, ["provider"])}`,
          `${openRequests} / ${maxConcurrent} open`,
          nativeAgentFlagLabel(row, ["paused"], "paused", "available"),
        ]);
      },
    },
    {
      key: "arbiters",
      singular: "arbiter",
      rows: nativeAgentRowsForKey(nativeAgentState, "arbiters"),
      idKeys: ["arbiterId", "arbiter_id"],
      render: (row) =>
        nativeAgentParts([
          `arbiter ${nativeAgentShortRowValue(row, ["arbiterId", "arbiter_id"])}`,
          nativeAgentNoncePart(row),
          `tier ${nativeAgentRowString(row, ["tier"]) ?? "—"}`,
        ]),
    },
    {
      key: "spendingPolicies",
      singular: "policy",
      plural: "policies",
      rows: nativeAgentRowsForKey(nativeAgentState, "spendingPolicies"),
      idKeys: ["policyId", "policy_id"],
      render: (row) =>
        nativeAgentParts([
          `policy ${nativeAgentShortRowValue(row, ["policyId", "policy_id"])}`,
          nativeAgentNoncePart(row),
          `limit ${nativeAgentRowString(row, ["windowLimit", "window_limit"]) ?? "—"}`,
        ]),
    },
    {
      key: "policySpends",
      singular: "spend",
      rows: nativeAgentRowsForKey(nativeAgentState, "policySpends"),
      idKeys: ["policyId", "policy_id"],
      render: (row) =>
        nativeAgentParts([
          `spend ${nativeAgentRowString(row, ["spent"]) ?? "0"} / ${nativeAgentRowString(row, ["amount"]) ?? "0"}`,
          `window ${nativeAgentRowString(row, ["window"]) ?? "—"}`,
        ]),
    },
    {
      key: "escrows",
      singular: "escrow",
      rows: nativeAgentRowsForKey(nativeAgentState, "escrows"),
      idKeys: ["escrowId", "escrow_id"],
      render: (row) =>
        nativeAgentParts([
          `escrow ${nativeAgentShortRowValue(row, ["escrowId", "escrow_id"])}`,
          nativeAgentNoncePart(row),
          nativeAgentRowString(row, ["status"]) ?? "unknown",
        ]),
    },
    {
      key: "reputationReviews",
      singular: "review",
      rows: nativeAgentRowsForKey(nativeAgentState, "reputationReviews"),
      idKeys: ["reviewId", "review_id"],
      render: (row) =>
        nativeAgentParts([
          `review ${nativeAgentShortRowValue(row, ["reviewId", "review_id"])}`,
          `quality ${nativeAgentRowString(row, ["qualityScore", "quality_score"]) ?? "—"}`,
          `accuracy ${nativeAgentRowString(row, ["accuracyScore", "accuracy_score"]) ?? "—"}`,
        ]),
    },
  ];
}

export function hasNativeAgentStateSummary(
  nativeAgentState: NativeAgentStateResponse | null,
): nativeAgentState is NativeAgentStateResponse {
  return (
    nativeAgentState !== null &&
    nativeAgentStateRowCount(nativeAgentState) > 0
  );
}

export function NativeAgentStateSummary({
  nativeAgentState,
}: {
  nativeAgentState: NativeAgentStateResponse | null;
}) {
  if (!hasNativeAgentStateSummary(nativeAgentState)) return null;
  const families = nativeAgentSummaryFamilies(nativeAgentState);
  const activeFamilies = families.filter((family) => family.rows.length > 0);
  const visibleRows = activeFamilies.flatMap((family) =>
    family.rows.slice(0, 1).map((row, index) => ({
      key: `${family.key}:${nativeAgentRowString(row, family.idKeys) ?? index}`,
      line: family.render(row),
    })),
  );
  const rowCount = nativeAgentStateRowCount(nativeAgentState);
  const countSummary =
    activeFamilies.length <= 4
      ? activeFamilies
          .map((family) =>
            nativeAgentCountLabel(
              family.rows.length,
              family.singular,
              family.plural,
            ),
          )
          .join(" · ")
      : `${nativeAgentCountLabel(rowCount, "indexed row")} · ${nativeAgentCountLabel(activeFamilies.length, "group")}`;
  const registryRows =
    nativeAgentRowsForKey(nativeAgentState, "issuers").length +
    nativeAgentRowsForKey(nativeAgentState, "services").length +
    nativeAgentRowsForKey(nativeAgentState, "availability").length +
    nativeAgentRowsForKey(nativeAgentState, "arbiters").length;
  const trustRows =
    nativeAgentRowsForKey(nativeAgentState, "attestations").length +
    nativeAgentRowsForKey(nativeAgentState, "consents").length +
    nativeAgentRowsForKey(nativeAgentState, "reputationReviews").length;
  const policyRows = nativeAgentRowsForKey(nativeAgentState, "spendingPolicies");
  const escrowRows = nativeAgentRowsForKey(nativeAgentState, "escrows");

  return (
    <div className="ext-asset">
      <div className="ext-asset__ico native">AGT</div>
      <div className="ext-asset__main">
        <div className="sym">
          Native agent state <span className="ext-badge-att">Indexed</span>
          {registryRows > 0 && (
            <> <span className="ext-badge-bridged">Registry</span></>
          )}
          {trustRows > 0 && (
            <> <span className="ext-badge-bridged">Trust</span></>
          )}
          {policyRows.length > 0 && (
            <> <span className="ext-badge-bridged">Policy</span></>
          )}
          {escrowRows.length > 0 && (
            <> <span className="ext-badge-bridged">Escrow</span></>
          )}
        </div>
        <div className="chain">
          {countSummary}
        </div>
        <div
          style={{
            marginTop: 6,
            fontFamily: "var(--f-mono)",
            fontSize: 9.5,
            lineHeight: 1.45,
            color: "var(--fg-400)",
          }}
        >
          {visibleRows.map((row) => (
            <div key={row.key}>{row.line}</div>
          ))}
          {rowCount > visibleRows.length && (
            <div>
              + {rowCount - visibleRows.length} more agent rows
            </div>
          )}
        </div>
      </div>
      <div className="ext-asset__spark" />
      <div className="ext-asset__right">
        <div className="amt">{rowCount} rows</div>
        <div className="chg">{activeFamilies.length} groups</div>
      </div>
    </div>
  );
}

export function MrcAccountSummary({
  mrcAccount,
}: {
  mrcAccount: MrcAccountLookupResponse | null;
}) {
  if (!hasMrcAccountSummary(mrcAccount)) return null;
  const records = [
    mrcAccount.smartAccount,
    mrcAccount.policyAccount,
  ].filter((record): record is MrcAccountRecord => record !== null);
  const spendRows = mrcAccount.policySpends.slice(0, 2);
  const policy = mrcAccount.policyAccount?.policy ?? null;
  const roleLabel =
    records.length > 0
      ? records.map((record) => mrcAccountKindLabel(record.kind)).join(" + ")
      : "Policy";
  return (
    <div className="ext-asset">
      <div className="ext-asset__ico native">MRC</div>
      <div className="ext-asset__main">
        <div className="sym">
          MRC account <span className="ext-badge-att">Indexed</span>
          {mrcAccount.smartAccount && (
            <> <span className="ext-badge-bridged">Smart</span></>
          )}
          {mrcAccount.policyAccount && (
            <> <span className="ext-badge-bridged">Policy</span></>
          )}
        </div>
        <div className="chain">
          {shortAddr(mrcAccount.account, 14)} · spend window {mrcAccount.spendLimit}
        </div>
        <div
          style={{
            marginTop: 6,
            fontFamily: "var(--f-mono)",
            fontSize: 9.5,
            lineHeight: 1.45,
            color: "var(--fg-400)",
          }}
        >
          {records.map((record) => (
            <div key={`${record.kind}:${record.account}`}>
              {formatMrcAccountRecordLine(record)}
            </div>
          ))}
          {policy && (
            <div>{formatMrcPolicyLine(policy)}</div>
          )}
          {spendRows.map((spend) => (
            <div key={`${spend.assetId}:${spend.window}`}>
              {formatMrcPolicySpendLine(spend)}
            </div>
          ))}
          {mrcAccount.policySpends.length > spendRows.length && (
            <div>
              + {mrcAccount.policySpends.length - spendRows.length} more spend rows
            </div>
          )}
        </div>
      </div>
      <div className="ext-asset__spark" />
      <div className="ext-asset__right">
        <div className="amt">{roleLabel}</div>
        <div className="chg">{mrcAccount.policySpends.length} spends</div>
      </div>
    </div>
  );
}

export function hasMrcAccountSummary(
  mrcAccount: MrcAccountLookupResponse | null,
): mrcAccount is MrcAccountLookupResponse {
  return (
    mrcAccount !== null &&
    (mrcAccount.smartAccount !== null ||
      mrcAccount.policyAccount !== null ||
      mrcAccount.policySpends.length > 0)
  );
}

function mrcAccountKindLabel(kind: MrcAccountRecord["kind"]): string {
  return kind === "smart_account" ? "Smart" : "Policy";
}

export function formatMrcAccountRecordLine(record: MrcAccountRecord): string {
  const bits = [
    mrcAccountKindLabel(record.kind),
    `controller ${shortAddr(record.controller, 10)}`,
  ];
  if (record.recovery) bits.push(`recovery ${shortAddr(record.recovery, 10)}`);
  if (record.policyHash) bits.push(`policy ${shortHex(record.policyHash)}`);
  if (record.nonce) bits.push(`nonce ${record.nonce}`);
  bits.push(`block ${record.updatedAtBlock.toLocaleString("en-US")}`);
  return bits.join(" · ");
}

export function formatMrcPolicyLine(policy: MrcPolicyRecord): string {
  const previewAssets = policy.allowedAssets.slice(0, 2).map(shortHex);
  const assetSummary =
    policy.allowedAssets.length === 0
      ? "no assets"
      : policy.allowedAssets.length > previewAssets.length
        ? `${previewAssets.join(", ")} + ${policy.allowedAssets.length - previewAssets.length} more`
        : previewAssets.join(", ");
  return `Policy body ${policy.enabled ? "enabled" : "disabled"} · per action ${policy.perActionLimit} · window ${policy.windowLimit} · assets ${assetSummary}`;
}

export function formatMrcPolicySpendLine(spend: MrcPolicySpendRecord): string {
  return `Spend ${shortHex(spend.assetId)} · window ${spend.window} · spent ${spend.spent} · block ${spend.updatedAtBlock.toLocaleString("en-US")}`;
}

function MrcHolderSummary({
  mrcHolders,
}: {
  mrcHolders: WalletMrcHoldersResponse | undefined;
}) {
  if (!mrcHolders || mrcHolders.holders.length === 0) return null;
  const holders = mrcHolders.holders;
  return (
    <div
      style={{
        marginTop: 6,
        fontFamily: "var(--f-mono)",
        fontSize: 9.5,
        lineHeight: 1.45,
        color: "var(--fg-400)",
      }}
    >
      <div style={{ color: "var(--fg-300)", textTransform: "uppercase" }}>
        {formatMrcHolderSummaryTitle(mrcHolders)}
      </div>
      {holders.map((holder) => (
        <div key={`${holder.rank}:${holder.address}`}>
          {formatMrcHolderDisplayLine(holder)}
        </div>
      ))}
    </div>
  );
}

// ---- Activity list ----
//
// The Activity tab body is wired to live indexer data via three
// hooks (useActivity / useNameResolution / useIndexerStatus). The
// implementation lives in src/popup/components/ActivityList.tsx — see
// there for the kind dispatch + IndexerStaleBanner + empty/error/stale
// state copy. The former inline list (+ its formatActivityTitle
// / formatActivityAmount / shortHex helpers) was removed in commit
// removed when the ActivityList component landed.

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
    case "mrc4626":
      return "MRC-4626";
    default:
      return standard.toUpperCase();
  }
}

export function formatMrcHolderSummaryTitle(
  holders: WalletMrcHoldersResponse,
): string {
  return normaliseMrcStandard(holders.standard) === "mrc4626"
    ? "Vault share holders"
    : "Native holders";
}

export function formatIndexedTokenBalanceRow(
  row: WalletTokenBalance,
): IndexedTokenBalanceDisplay {
  const updated = `updated at block ${row.updatedAtBlock.toLocaleString("en-US")}`;
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
  const assetId = shortHex(row.mrc.assetId);

  if (standard === "mrc4626") {
    return {
      title: `${label} shares ${assetId}`,
      subtitle: `vault ${assetId} · ${updated}`,
      unitsLabel: "vault shares",
    };
  }

  const assetKind = isCollectionToken ? "collection" : "asset";

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

export function formatMrcHolderDisplayLine(holder: WalletMrcHolder): string {
  return `#${holder.rank} ${shortAddr(holder.address, 10)} · ${holder.balance} · block ${holder.updatedAtBlock.toLocaleString("en-US")}`;
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
  /trust|guardian|committee|validator|verifier|multisig|light[_-]?client|zk|proof|verification|attestation|custody|permission/i;
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
// (0x100A) activates on the testnet; the visual hierarchy keeps the
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
        // The disabled (Staked) chip used to dim its whole body to
        // `opacity: 0.6`, which dragged the label to ~3.2:1 (sub-AA). The
        // "not yet active" affordance is carried instead by the muted
        // --fg-700 border + default cursor + absent onClick (above), so the
        // label/value can sit at their full token tiers (--fg-400 ≈6.5:1,
        // --fg-100 ≈15:1) and stay legible.
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
  /** Slot rendered at the top of the Home body
   *  for the post-onboarding hint bar (OnboardingHintBar). Optional
   *  so test harnesses + callers without the route wired still
   *  render. */
  topSlot?: ReactNode;
  /** Threaded to VaultPicker so the "New wallet"
   *  dropdown entry routes to App's NewWalletFlow screen instead of
   *  opening the legacy single-page VaultAddModal fresh mode. */
  onNewWalletFlow?: () => void;
  /** Threaded through Top → VaultPicker so a successful VaultAddModal
   *  completion (import or multisig) can re-run App's hydration and the
   *  chip shows the new vault's name without lock/unlock or reopen. */
  onVaultComplete?: () => void;
}

export function Home({ account, network, indexer, onOpenAccounts, onSettings, onOpenReceive, onOpenSend, onOpenStake, onOpenBridge, topSlot, onNewWalletFlow, onVaultComplete }: HomeProps) {
  const [tab, setTab] = useState<"assets" | "activity">("assets");
  const [activeChip, setActiveChip] = useState<"total" | "staked">("total");
  const devMode = useFeature("DEVELOPER_MODE");
  const isPriv = account.denom === "private";
  const totalStr = account.balance != null ? fmt(account.balance, 2) : "0.00";
  // Activity rows now flow through useActivity() inside ActivityList —
  // see src/popup/components/ActivityList.tsx. The Home component no
  // longer reads `indexer?.addressActivity` directly. `liveLabel` is
  // still used for the Hero card's account-name display.
  const liveLabel = indexer?.addressLabel;
  const latestDelegation = indexer?.delegationHistory[0] ?? null;
  // Staked is hardcoded zero until the delegation precompile (0x100A)
  // activates on the testnet — see ADR-0015. The Staked chip is rendered
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
        {...(onNewWalletFlow ? { onNewWalletFlow } : {})}
        {...(onVaultComplete ? { onVaultComplete } : {})}
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
                  ? devMode
                    ? `${latestDelegation.kind} · ${clusterLabel(latestDelegation.cluster)} · ${latestDelegation.weightBps} bps`
                    : `${clusterLabel(latestDelegation.cluster)} · ${formatWeightBpsPercent(latestDelegation.weightBps)}`
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

        {/* Tabs */}
        {/* ARIA tablist + tab + tabpanel pattern.
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
        </div>

        {/* "view first-run onboarding" debug button
           removed. The unified onboarding hint bar at the top of Home
           already nudges users into onboarding tasks (passkey, SLH-DSA
           backup, feature discovery) when relevant; a manual re-entry
           button was clutter on a finished wallet. */}

        {/* Footer now flows as the LAST element INSIDE the
           .ext-body scroll container instead of being a frame-pinned
           sibling. A UI review found the always-visible frame-pinned
           strip too persistent; the footer should read as the end of the
           page. It now appears only when the home content is scrolled to
           the bottom. (Footer's baseStyle uses negative horizontal
           margins to span the body's side padding.) */}
        <Footer />
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

// Stake page moved to src/popup/pages/Stake.tsx.
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
  const routeChoice = useBridgeRouteSelection(
    disclosures,
    indexer?.bridgeRouteReadiness ?? null,
  );
  const transferPreview = routeChoice.transferPreview;

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

        <div className="ext-card" style={{ padding: 14 }}>
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
              SDK route choice
            </div>
            <span className={routeChoice.selected ? "ext-badge-att" : "ext-badge-bridged"}>
              {routeChoice.selected ? "Selected" : "Closed"}
            </span>
          </div>
          <div
            style={{
              fontSize: 12,
              lineHeight: 1.45,
              color: "var(--fg-200)",
            }}
          >
            {routeChoice.selected?.route
              ? `${routeChoice.selected.route.routeId} is the top SDK-ranked accepted route.`
              : "No SDK-ranked bridge route is selectable from the active disclosures."}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              gap: 8,
              marginTop: 10,
            }}
          >
            <BridgeRouteMetric label="Disclosures" value={String(disclosures.length)} />
            <BridgeRouteMetric label="SDK routes" value={String(routeChoice.sdkRouteCount)} />
            <BridgeRouteMetric label="Display only" value={String(routeChoice.displayOnlyCount)} />
          </div>
          {routeChoice.catalogueReadiness && (
            <BridgeRouteReadinessPanel
              title="Catalogue readiness"
              readiness={routeChoice.catalogueReadiness}
            />
          )}
          {routeChoice.blockedReasons.length > 0 && (
            <BridgeRouteReasonList
              title="Selection closed"
              reasons={routeChoice.blockedReasons}
              tone="blocked"
            />
          )}
        </div>

        {routeChoice.candidates.length === 0 ? (
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
          routeChoice.candidates.map((candidate) => (
            <BridgeRouteCandidateCard
              candidate={candidate}
              key={`${candidate.originalIndex}:${candidate.route?.routeId ?? "display-only"}`}
            />
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
            Transfer intent / quote preview
          </div>
          <div
            style={{
              margin: 0,
              fontSize: 11.5,
              lineHeight: 1.45,
              color: "var(--fg-400)",
            }}
          >
            {transferPreview.status === "intent-blocked"
              ? "The SDK can evaluate a transfer intent against the selected route, but this build has no live quote or submit primitive."
              : "No transfer intent is constructed until an SDK-shaped route is selected."}
          </div>
          {transferPreview.intent && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                gap: 8,
                marginTop: 10,
              }}
            >
              <BridgeRouteMetric label="Asset" value={transferPreview.intent.asset} />
              <BridgeRouteMetric
                label="Route"
                value={transferPreview.intent.allowedRouteIds?.[0] ?? "unselected"}
              />
              <BridgeRouteMetric
                label="From"
                value={transferPreview.intent.sourceChain}
              />
              <BridgeRouteMetric
                label="To"
                value={transferPreview.intent.destinationChain}
              />
              <BridgeRouteMetric label="Amount" value="required" />
              <BridgeRouteMetric label="Recipient" value="required" />
            </div>
          )}
          {transferPreview.readiness && (
            <BridgeRouteReadinessPanel
              title="Route readiness"
              readiness={transferPreview.readiness}
            />
          )}
          {transferPreview.blockedReasons.length > 0 && (
            <BridgeRouteReasonList
              title="Intent guard"
              reasons={transferPreview.blockedReasons}
              tone="blocked"
            />
          )}
          <BridgeRouteReasonList
            title="Quote unavailable"
            reasons={transferPreview.quoteBlockedReasons}
            tone="muted"
          />
          <BridgeRouteReasonList
            title="Submit unavailable"
            reasons={transferPreview.submitBlockedReasons}
            tone="muted"
          />
          <div className="req-foot" style={{ margin: "12px 0 0" }}>
            <button
              className="prim"
              disabled
              style={{ cursor: "not-allowed", opacity: 0.55 }}
            >
              Request quote
            </button>
            <button
              className="ghost"
              disabled
              style={{ cursor: "not-allowed", opacity: 0.55 }}
            >
              Submit bridge
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

interface BridgeRouteCandidateCardProps {
  candidate: BridgeRouteChoiceCandidate;
}

function BridgeRouteCandidateCard({ candidate }: BridgeRouteCandidateCardProps) {
  const display = formatBridgeRouteDisclosureDisplay(candidate.disclosure);
  const route = candidate.route;
  const assessment = candidate.assessment;
  // v5 pillar surface — the live risk-disclosure panel ships behind the
  // default-off "Agent commerce (experimental)" toggle. When OFF the
  // card renders exactly the pre-v5 disclosure rows (no extra panel).
  const agentCommerceEnabled = useFeature("AGENT_COMMERCE");

  return (
    <div className="ext-card" style={{ padding: 14 }}>
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
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            gap: 3,
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
            {candidate.rank === null
              ? `Route disclosure ${candidate.originalIndex + 1}`
              : `SDK rank ${candidate.rank}`}
          </div>
          <div
            style={{
              minWidth: 0,
              fontSize: 12.5,
              fontWeight: 600,
              color: "var(--fg-100)",
              overflowWrap: "anywhere",
            }}
          >
            {route?.routeId ?? "Display-only disclosure"}
          </div>
        </div>
        <span className={bridgeRouteCandidateBadgeClass(candidate)}>
          {bridgeRouteCandidateBadge(candidate)}
        </span>
      </div>

      {route && assessment ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: 8,
          }}
        >
          <BridgeRouteMetric label="Score" value={`${assessment.score}/100`} />
          <BridgeRouteMetric label="Risk" value={assessment.riskTier} />
          <BridgeRouteMetric label="Cooldown" value={`${route.cooldownSeconds}s`} />
          <BridgeRouteMetric label="Finality" value={`${route.finalityBlocks} blocks`} />
          {candidate.bridgeId && (
            <BridgeRouteMetric label="Bridge ID" value={candidate.bridgeId} />
          )}
          {candidate.wrappedAsset && (
            <BridgeRouteMetric
              label="Wrapped asset"
              value={candidate.wrappedAsset}
            />
          )}
        </div>
      ) : (
        <BridgeRouteReasonList
          title="SDK route parser"
          reasons={[candidate.parseFailure ?? "not an SDK bridge route disclosure"]}
          tone="muted"
        />
      )}

      {assessment && assessment.blockedReasons.length > 0 && (
        <BridgeRouteReasonList
          title="Blocking reasons"
          reasons={assessment.blockedReasons}
          tone="blocked"
        />
      )}
      {assessment && assessment.warnings.length > 0 && (
        <BridgeRouteReasonList
          title="Warnings"
          reasons={assessment.warnings}
          tone="warning"
        />
      )}
      {candidate.readiness && (
        <BridgeRouteReadinessPanel
          title="Catalogue readiness"
          readiness={candidate.readiness}
        />
      )}

      {agentCommerceEnabled && route && assessment && (
        <BridgeRouteRiskPanel
          route={route}
          riskTier={assessment.riskTier}
          bridgeId={candidate.bridgeId}
          wrappedAsset={candidate.wrappedAsset}
        />
      )}

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
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// §20.2 / §25.2 — pre-send bridge RISK DISCLOSURE panel.
//
// Display-only. The SDK exposes NO live bridge quote/submit primitive
// (BRIDGE_QUOTE_API_BLOCKED_REASON / BRIDGE_SUBMIT_API_BLOCKED_REASON),
// so this panel renders the route's risk posture BEFORE any (disabled)
// send CTA — it must NOT imply a live send is possible. It enriches the
// static `BridgeRouteDisclosure` (drainCapAtomic / circuitBreaker /
// insuranceAtomic / lastIncidentDate / adminControl + the SDK riskTier)
// with the LIVE MB-2 reads (`lyth_bridgeDrainStatus` remaining bucket +
// `lyth_bridgeHealth` pause posture) when bridgeId + wrappedAsset are
// known. Falls back to the static disclosure when the live reads aren't
// live (operator offline / method not deployed).

type SdkBridgeRouteDisclosure = NonNullable<BridgeRouteChoiceCandidate["route"]>;

function BridgeRouteRiskPanel({
  route,
  riskTier,
  bridgeId,
  wrappedAsset,
}: {
  route: SdkBridgeRouteDisclosure;
  riskTier: string;
  bridgeId: string | null;
  wrappedAsset: string | null;
}) {
  const [drain, setDrain] = useState<BridgeDrainStatusOutcome | null>(null);
  const [breaker, setBreaker] = useState<BridgeCircuitBreakerFields | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (bridgeId === null || wrappedAsset === null) {
      setDrain(null);
      setBreaker(null);
      return;
    }
    void (async () => {
      const [drainRes, healthRes] = await Promise.all([
        bgReadBridgeDrainStatus(bridgeId, wrappedAsset),
        bgReadBridgeHealth(null, 50),
      ]);
      if (cancelled) return;
      if (drainRes.ok) setDrain(drainRes.outcome);
      if (healthRes.ok && healthRes.outcome.kind === "live") {
        const matched = matchBridgeHealthRecord(healthRes.outcome, bridgeId);
        setBreaker(matched);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bridgeId, wrappedAsset]);

  // Drain-cap REMAINING: prefer the live per-route bucket; fall back to
  // the bridge-default cap when only the breaker is live; fall back to
  // the static disclosure cap as the last resort.
  const liveDrain = drain && drain.kind === "live" ? drain.data : null;
  const remainingDisplay = (() => {
    if (liveDrain) {
      // capPerWindow "0x0" means no per-asset cap — the bridge default
      // applies, so there is no per-route remaining bucket to show.
      if (liveDrain.capPerWindow === "0x0") return "no per-asset cap";
      return `${liveDrain.remaining} / ${liveDrain.capPerWindow}`;
    }
    // No live bucket — show the static disclosed cap. The SDK helper
    // computes remaining from cap+drained; with no drained figure on the
    // static disclosure we surface the cap itself.
    const fallbackRemaining = bridgeDrainRemaining(route.drainCapAtomic, "0");
    return fallbackRemaining === null
      ? "cap disabled"
      : `${fallbackRemaining} (cap, static)`;
  })();

  const breakerDisplay = (() => {
    if (breaker) {
      return breaker.paused
        ? `paused @ block ${breaker.pausedAtBlock ?? "?"}`
        : "armed";
    }
    return `${route.circuitBreaker} (static)`;
  })();

  const insuranceDisplay =
    route.insuranceAtomic === "0" ? "none disclosed" : route.insuranceAtomic;
  const lastIncidentDisplay = route.lastIncidentDate ?? "none disclosed";

  return (
    <div
      style={{
        marginTop: 10,
        padding: 10,
        borderRadius: 8,
        border: "1px solid var(--border-200, rgba(255,255,255,0.08))",
        background: "var(--bg-200, rgba(255,255,255,0.03))",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          marginBottom: 8,
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
          Risk disclosure
        </div>
        <span className={bridgeRiskTierBadgeClass(riskTier)}>{riskTier}</span>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gap: 8,
        }}
      >
        <BridgeRouteMetric
          label="Route"
          value={route.protocol ? `${route.bridge} · ${route.protocol}` : route.bridge}
        />
        <BridgeRouteMetric
          label="Verifier"
          value={`${route.verifier.model} ${route.verifier.threshold}/${route.verifier.participantCount}`}
        />
        <BridgeRouteMetric label="Drain remaining" value={remainingDisplay} />
        <BridgeRouteMetric label="Circuit breaker" value={breakerDisplay} />
        <BridgeRouteMetric label="Insurance" value={insuranceDisplay} />
        <BridgeRouteMetric label="Last incident" value={lastIncidentDisplay} />
        <BridgeRouteMetric label="Admin control" value={route.adminControl} />
        <BridgeRouteMetric
          label="Live reads"
          value={
            liveDrain || breaker
              ? "live (MB-2)"
              : bridgeId === null
                ? "static only"
                : "static (operator offline)"
          }
        />
      </div>
      <BridgeRouteReasonList
        title="Sending disabled"
        reasons={[BRIDGE_QUOTE_API_BLOCKED_REASON, BRIDGE_SUBMIT_API_BLOCKED_REASON]}
        tone="muted"
      />
    </div>
  );
}

/** Find the bridge-health record for a bridgeId in a live health page,
 *  returning its circuit-breaker posture or null when absent. */
function matchBridgeHealthRecord(
  outcome: BridgeHealthOutcome,
  bridgeId: string,
): BridgeCircuitBreakerFields | null {
  if (outcome.kind !== "live") return null;
  const target = bridgeId.toLowerCase();
  for (const record of outcome.data.records) {
    if (record.bridgeId.toLowerCase() === target) {
      return record.circuitBreaker;
    }
  }
  return null;
}

/** Map the SDK §20 risk tier onto an existing badge class. `blocked`
 *  reuses the closed/warning treatment; everything else falls to the
 *  neutral bridged badge so we don't invent a new chromatic taxonomy. */
function bridgeRiskTierBadgeClass(riskTier: string): string {
  return riskTier === "blocked" || riskTier === "high"
    ? "ext-badge-bridged"
    : "ext-badge-att";
}

interface BridgeRouteMetricProps {
  label: string;
  value: string;
}

interface BridgeRouteReadinessPanelProps {
  title: string;
  readiness: WalletBridgeRouteReadiness;
}

function BridgeRouteReadinessPanel({
  title,
  readiness,
}: BridgeRouteReadinessPanelProps) {
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
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          gap: 8,
        }}
      >
        <BridgeRouteMetric
          label="Selection"
          value={readiness.routeSelectionReady ? "ready" : "blocked"}
        />
        <BridgeRouteMetric
          label="Quote"
          value={readiness.quoteReady ? "ready" : "disabled"}
        />
        <BridgeRouteMetric
          label="Submit"
          value={readiness.submitReady ? "ready" : "disabled"}
        />
      </div>
      {readiness.blockedReasons.length > 0 && (
        <BridgeRouteReasonList
          title="Readiness guard"
          reasons={readiness.blockedReasons}
          tone="blocked"
        />
      )}
      {readiness.warnings.length > 0 && (
        <BridgeRouteReasonList
          title="Readiness warnings"
          reasons={readiness.warnings}
          tone="warning"
        />
      )}
    </div>
  );
}

function BridgeRouteMetric({ label, value }: BridgeRouteMetricProps) {
  return (
    <div
      style={{
        minWidth: 0,
        padding: "8px 10px",
        borderRadius: 8,
        border: "1px solid var(--fg-700)",
        background: "rgba(255,255,255,0.02)",
      }}
    >
      <div
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 9.5,
          color: "var(--fg-500)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        {label}
      </div>
      <div
        style={{
          minWidth: 0,
          marginTop: 3,
          fontSize: 11.5,
          color: "var(--fg-100)",
          overflowWrap: "anywhere",
        }}
      >
        {value}
      </div>
    </div>
  );
}

interface BridgeRouteReasonListProps {
  title: string;
  reasons: string[];
  tone: "blocked" | "warning" | "muted";
}

function BridgeRouteReasonList({
  title,
  reasons,
  tone,
}: BridgeRouteReasonListProps) {
  const color =
    tone === "blocked"
      ? "#ffaaaa"
      : tone === "warning"
        ? "var(--warn)"
        : "var(--fg-400)";

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
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {reasons.map((reason) => (
          <div
            key={reason}
            style={{
              padding: "8px 10px",
              borderRadius: 8,
              border: "1px solid var(--fg-700)",
              color,
              fontSize: 11,
              lineHeight: 1.4,
              overflowWrap: "anywhere",
            }}
          >
            {reason}
          </div>
        ))}
      </div>
    </div>
  );
}

function bridgeRouteCandidateBadge(candidate: BridgeRouteChoiceCandidate): string {
  switch (candidate.state) {
    case "selected":
      return "Selected";
    case "candidate":
      return "Candidate";
    case "blocked":
      return "Blocked";
    case "display-only":
      return "Display only";
  }
}

function bridgeRouteCandidateBadgeClass(
  candidate: BridgeRouteChoiceCandidate,
): string {
  return candidate.state === "selected" ? "ext-badge-att" : "ext-badge-bridged";
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

// (Send page lives at ./pages/Send.tsx.)

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
// show real numbers without RPC access of its own. The request `tx` still
// carries inherited EIP-1193 field names at the dapp boundary.
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

export const parseHexQuantity = parseNativeHexQuantity;
export const formatExecutionUnits = formatNativeExecutionUnits;
export const formatLythoshiPerExecutionUnit = formatNativeLythoshiPerExecutionUnit;
export const lythoshiToLythString = formatLythoshiAsLythString;
export const formatLythoshiAmountHex = formatNativeLythoshiAmountHex;

type FeeTier = "low" | "medium" | "high";

const APPROVAL_FEE_TIER_BPS: Record<FeeTier, bigint> = {
  low: 9_000n,
  medium: 10_000n,
  high: 13_000n,
};

export function applyFeeTier(
  pricePerExecutionUnitLythoshi: bigint,
  tier: FeeTier,
): bigint {
  return scaleByBps(pricePerExecutionUnitLythoshi, APPROVAL_FEE_TIER_BPS[tier]);
}

export function computeNativeFeeLythoshi(
  executionUnitLimitHex: string | null | undefined,
  pricePerExecutionUnitLythoshiHex: string | null | undefined,
  tier: FeeTier,
): bigint | null {
  return computeNativeFeeFromPrice({
    executionUnitLimitHex,
    pricePerExecutionUnitLythoshiHex,
    priceMultiplierBps: APPROVAL_FEE_TIER_BPS[tier],
  });
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
  /** Selector hex, e.g. `0xa9059cbb`, or native payload encoding marker. */
  selector: string;
  /** Optional protocol surface for first-party native precompile actions. */
  surface?: "native-market" | "native-agent";
  /** Decoded args in display order. */
  args: Array<{ name: string; type: string; value: string }>;
}

const CLOB_PLACE_LIMIT_ORDER_SELECTOR = "0x2468786f";
const CLOB_PLACE_MARKET_ORDER_SELECTOR = "0xb9b1fa86";
const CLOB_PLACE_MARKET_ORDER_EX_SELECTOR = "0xa6f092f0";
const CLOB_CANCEL_ORDER_SELECTOR = "0x7489ec23";
// ASCII-bytes sentinel — `0x` + hex("MARKET_NATIVE_MOD_V1"). Compared
// against `tx.to.toLowerCase()` during calldata decoding to route the
// tx into the native-market renderer. NOT a real chain address; per
// ADR-0038 typed addresses live in the bech32m space.
const NATIVE_MARKET_MODULE_ADDRESS_HEX = "0x4d41524b45545f4e41544956455f4d4f445f5631";
const NATIVE_MARKET_MODULE_ADDRESS_TYPED = addressToTypedBech32(
  "systemModule",
  NATIVE_MARKET_MODULE_ADDRESS_HEX,
);

export function decodeCalldata(data: string, to?: string): DecodedCall | null {
  if (!data || !data.startsWith("0x")) return null;
  if (isNativeMarketModuleTarget(to)) {
    const nativePayload = decodeNativeMarketBincodePayload(data);
    if (nativePayload) return nativePayload;
  }
  if (isNativeAgentModuleTarget(to)) {
    const nativePayload = decodeNativeAgentBincodePayload(data);
    if (nativePayload) return nativePayload;
  }
  if (data.length < 10) return null;
  const selector = data.slice(0, 10).toLowerCase();
  const body = data.slice(10);
  if (to?.toLowerCase() === PRECOMPILE_ADDRESSES.CLOB.toLowerCase()) {
    const nativeMarket = decodeNativeMarketCalldata(selector, body);
    if (nativeMarket) return nativeMarket;
  }
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

function decodeNativeMarketCalldata(selector: string, body: string): DecodedCall | null {
  switch (selector) {
    case CLOB_PLACE_LIMIT_ORDER_SELECTOR: {
      // placeLimitOrder(bytes32,bytes32,uint8,uint256,uint256,uint64)
      const base = readBytes32(body, 0);
      const quote = readBytes32(body, 1);
      const side = readUint256(body, 2);
      const price = readUint256(body, 3);
      const quantity = readUint256(body, 4);
      const expiresAtBlock = readUint256(body, 5);
      if (!base || !quote || side == null || price == null || quantity == null || expiresAtBlock == null) {
        return null;
      }
      const sideLabel = side === 0n ? "buy" : side === 1n ? "sell" : `unknown (${side.toString(10)})`;
      return {
        name: "placeLimitOrder",
        selector,
        surface: "native-market",
        args: [
          { name: "base asset", type: "bytes32", value: base },
          { name: "quote asset", type: "bytes32", value: quote },
          { name: "side", type: "uint8", value: sideLabel },
          { name: "price", type: "uint256", value: price.toString(10) },
          { name: "quantity", type: "uint256", value: quantity.toString(10) },
          { name: "expires at block", type: "uint64", value: expiresAtBlock.toString(10) },
        ],
      };
    }
    case CLOB_PLACE_MARKET_ORDER_SELECTOR: {
      // placeMarketOrder(bytes32,bytes32,uint8,uint256,uint16)
      const base = readBytes32(body, 0);
      const quote = readBytes32(body, 1);
      const side = readUint256(body, 2);
      const amount = readUint256(body, 3);
      const maxSlippageBps = readUint256(body, 4);
      if (!base || !quote || side == null || amount == null || maxSlippageBps == null) {
        return null;
      }
      const sideLabel = side === 0n ? "buy" : side === 1n ? "sell" : `unknown (${side.toString(10)})`;
      return {
        name: "placeMarketOrder",
        selector,
        surface: "native-market",
        args: [
          { name: "base asset", type: "bytes32", value: base },
          { name: "quote asset", type: "bytes32", value: quote },
          { name: "side", type: "uint8", value: sideLabel },
          { name: "amount", type: "uint256", value: amount.toString(10) },
          { name: "max slippage bps", type: "uint16", value: maxSlippageBps.toString(10) },
        ],
      };
    }
    case CLOB_PLACE_MARKET_ORDER_EX_SELECTOR: {
      // placeMarketOrderEx(bytes32,bytes32,uint8,uint256,uint16,uint8)
      const base = readBytes32(body, 0);
      const quote = readBytes32(body, 1);
      const side = readUint256(body, 2);
      const amount = readUint256(body, 3);
      const maxSlippageBps = readUint256(body, 4);
      const mode = readUint256(body, 5);
      if (!base || !quote || side == null || amount == null || maxSlippageBps == null || mode == null) {
        return null;
      }
      const sideLabel = side === 0n ? "buy" : side === 1n ? "sell" : `unknown (${side.toString(10)})`;
      const modeLabel =
        mode === 0n ? "fill or refund" : mode === 1n ? "fill or rest at cap" : `unknown (${mode.toString(10)})`;
      return {
        name: "placeMarketOrderEx",
        selector,
        surface: "native-market",
        args: [
          { name: "base asset", type: "bytes32", value: base },
          { name: "quote asset", type: "bytes32", value: quote },
          { name: "side", type: "uint8", value: sideLabel },
          { name: "amount", type: "uint256", value: amount.toString(10) },
          { name: "max slippage bps", type: "uint16", value: maxSlippageBps.toString(10) },
          { name: "mode", type: "uint8", value: modeLabel },
        ],
      };
    }
    case CLOB_CANCEL_ORDER_SELECTOR: {
      // cancelOrder(bytes32)
      const orderId = readBytes32(body, 0);
      if (!orderId) return null;
      return {
        name: "cancelOrder",
        selector,
        surface: "native-market",
        args: [{ name: "order id", type: "bytes32", value: orderId }],
      };
    }
    default:
      return null;
  }
}

function isNativeMarketModuleTarget(to: string | undefined): boolean {
  if (typeof to !== "string") return false;
  const normalized = to.toLowerCase();
  return (
    normalized === NATIVE_MARKET_MODULE_ADDRESS_HEX ||
    normalized === NATIVE_MARKET_MODULE_ADDRESS_TYPED
  );
}

function isNativeAgentModuleTarget(to: string | undefined): boolean {
  if (typeof to !== "string") return false;
  const normalized = to.toLowerCase();
  return (
    normalized === NATIVE_AGENT_MODULE_ADDRESS_BYTES ||
    normalized === NATIVE_AGENT_MODULE_ADDRESS
  );
}

const NATIVE_MARKET_KIND_LABELS: Record<number, AddressKind> = {
  0: "user",
  1: "smartAccount",
  2: "contract",
  3: "cluster",
  4: "multisig",
  5: "systemModule",
};

function decodeNativeMarketBincodePayload(data: string): DecodedCall | null {
  const r = NativeMarketPayloadReader.fromHex(data);
  if (!r) return null;
  const nativeCall = r.u32();
  if (nativeCall == null) return null;

  if (nativeCall === 0) {
    const spotCall = r.u32();
    if (spotCall === 1) return decodeNativeSpotLimitOrderPayload(r);
    if (spotCall === 4) return decodeNativeSpotCancelOrderPayload(r);
    return null;
  }

  if (nativeCall === 1) {
    const nftCall = r.u32();
    if (nftCall === 0) return decodeNativeNftCreateListingPayload(r);
    if (nftCall === 1) return decodeNativeNftBuyListingPayload(r);
    if (nftCall === 2) return decodeNativeNftCancelListingPayload(r);
    if (nftCall === 3) return decodeNativeNftSweepExpiredListingsPayload(r);
    if (nftCall === 5) return decodeNativeNftPlaceAuctionBidPayload(r);
    if (nftCall === 6) return decodeNativeNftSettleAuctionPayload(r);
    return null;
  }

  return null;
}

function decodeNativeAgentBincodePayload(data: string): DecodedCall | null {
  const r = NativeMarketPayloadReader.fromHex(data);
  if (!r) return null;
  const nativeCall = r.u32();
  if (nativeCall == null) return null;

  const agentCall = r.u32();
  if (agentCall == null) return null;

  if (nativeCall === 0) return decodeNativeAgentIssuerPayload(r, agentCall);
  if (nativeCall === 1) return decodeNativeAgentAttestationPayload(r, agentCall);
  if (nativeCall === 2) return decodeNativeAgentConsentPayload(r, agentCall);
  if (nativeCall === 3) return decodeNativeAgentDiscoveryPayload(r, agentCall);
  if (nativeCall === 4) return decodeNativeAgentAvailabilityPayload(r, agentCall);
  if (nativeCall === 5) return decodeNativeAgentArbiterPayload(r, agentCall);
  if (nativeCall === 6) return decodeNativeAgentSpendingPolicyPayload(r, agentCall);
  if (nativeCall === 7) return decodeNativeAgentEscrowPayload(r, agentCall);
  if (nativeCall === 8) return decodeNativeAgentReputationPayload(r, agentCall);
  return null;
}

function decodeNativeAgentIssuerPayload(r: NativeMarketPayloadReader, call: number): DecodedCall | null {
  if (call === 0) {
    const issuer = r.monoAddress();
    const nonce = r.u64();
    const metadataHash = r.bytesHex(32);
    if (!issuer || nonce == null || !metadataHash || !r.done()) return null;
    return nativeAgentCall("nativeAgentRegisterIssuer", [
      monoArg("issuer", issuer),
      uintArg("nonce", "uint64", nonce),
      bytesArg("metadata hash", metadataHash),
    ]);
  }
  if (call === 1) {
    const issuerId = r.bytesHex(32);
    if (!issuerId || !r.done()) return null;
    return nativeAgentCall("nativeAgentGetIssuer", [bytesArg("issuer id", issuerId)]);
  }
  return null;
}

function decodeNativeAgentAttestationPayload(r: NativeMarketPayloadReader, call: number): DecodedCall | null {
  if (call === 0) {
    const issuerId = r.bytesHex(32);
    const issuer = r.monoAddress();
    const subject = r.monoAddress();
    const nonce = r.u64();
    const schemaHash = r.bytesHex(32);
    const payloadHash = r.bytesHex(32);
    if (!issuerId || !issuer || !subject || nonce == null || !schemaHash || !payloadHash || !r.done()) return null;
    return nativeAgentCall("nativeAgentIssueAttestation", [
      bytesArg("issuer id", issuerId),
      monoArg("issuer", issuer),
      monoArg("subject", subject),
      uintArg("nonce", "uint64", nonce),
      bytesArg("schema hash", schemaHash),
      bytesArg("payload hash", payloadHash),
    ]);
  }
  if (call === 1) {
    const attestationId = r.bytesHex(32);
    const issuer = r.monoAddress();
    if (!attestationId || !issuer || !r.done()) return null;
    return nativeAgentCall("nativeAgentRevokeAttestation", [
      bytesArg("attestation id", attestationId),
      monoArg("issuer", issuer),
    ]);
  }
  if (call === 2) {
    const attestationId = r.bytesHex(32);
    if (!attestationId || !r.done()) return null;
    return nativeAgentCall("nativeAgentGetAttestation", [bytesArg("attestation id", attestationId)]);
  }
  return null;
}

function decodeNativeAgentConsentPayload(r: NativeMarketPayloadReader, call: number): DecodedCall | null {
  if (call === 0) {
    const subject = r.monoAddress();
    const grantee = r.monoAddress();
    const nonce = r.u64();
    const scopeHash = r.bytesHex(32);
    const expiresAt = r.u64();
    if (!subject || !grantee || nonce == null || !scopeHash || expiresAt == null || !r.done()) return null;
    return nativeAgentCall("nativeAgentGrantConsent", [
      monoArg("subject", subject),
      monoArg("grantee", grantee),
      uintArg("nonce", "uint64", nonce),
      bytesArg("scope hash", scopeHash),
      uintArg("expires at", "uint64", expiresAt),
    ]);
  }
  if (call === 1) {
    const consentId = r.bytesHex(32);
    const subject = r.monoAddress();
    if (!consentId || !subject || !r.done()) return null;
    return nativeAgentCall("nativeAgentRevokeConsent", [
      bytesArg("consent id", consentId),
      monoArg("subject", subject),
    ]);
  }
  if (call === 2) {
    const consentId = r.bytesHex(32);
    if (!consentId || !r.done()) return null;
    return nativeAgentCall("nativeAgentGetConsent", [bytesArg("consent id", consentId)]);
  }
  return null;
}

function decodeNativeAgentDiscoveryPayload(r: NativeMarketPayloadReader, call: number): DecodedCall | null {
  if (call === 0) {
    const provider = r.monoAddress();
    const nonce = r.u64();
    const categoryHash = r.bytesHex(32);
    const metadataHash = r.bytesHex(32);
    if (!provider || nonce == null || !categoryHash || !metadataHash || !r.done()) return null;
    return nativeAgentCall("nativeAgentListService", [
      monoArg("provider", provider),
      uintArg("nonce", "uint64", nonce),
      bytesArg("category hash", categoryHash),
      bytesArg("metadata hash", metadataHash),
    ]);
  }
  if (call === 1) {
    const serviceId = r.bytesHex(32);
    const provider = r.monoAddress();
    if (!serviceId || !provider || !r.done()) return null;
    return nativeAgentCall("nativeAgentDeactivateService", [
      bytesArg("service id", serviceId),
      monoArg("provider", provider),
    ]);
  }
  if (call === 2) {
    const serviceId = r.bytesHex(32);
    if (!serviceId || !r.done()) return null;
    return nativeAgentCall("nativeAgentGetService", [bytesArg("service id", serviceId)]);
  }
  return null;
}

function decodeNativeAgentAvailabilityPayload(r: NativeMarketPayloadReader, call: number): DecodedCall | null {
  if (call === 0) {
    const provider = r.monoAddress();
    const maxConcurrent = r.u32();
    const paused = r.u8();
    if (!provider || maxConcurrent == null || paused == null || !r.done()) return null;
    return nativeAgentCall("nativeAgentSetAvailability", [
      monoArg("provider", provider),
      numberArg("max concurrent", "uint32", maxConcurrent),
      numberArg("paused", "bool", paused === 0 ? "false" : paused === 1 ? "true" : `unknown (${paused})`),
    ]);
  }
  if (call === 1 || call === 2) {
    const provider = r.monoAddress();
    const consumer = r.monoAddress();
    if (!provider || !consumer || !r.done()) return null;
    return nativeAgentCall(call === 1 ? "nativeAgentOpenAvailability" : "nativeAgentCloseAvailability", [
      monoArg("provider", provider),
      monoArg("consumer", consumer),
    ]);
  }
  if (call === 3) {
    const provider = r.monoAddress();
    if (!provider || !r.done()) return null;
    return nativeAgentCall("nativeAgentGetAvailability", [monoArg("provider", provider)]);
  }
  return null;
}

function decodeNativeAgentArbiterPayload(r: NativeMarketPayloadReader, call: number): DecodedCall | null {
  if (call === 0) {
    const arbiter = r.monoAddress();
    const nonce = r.u64();
    const tier = r.u16();
    const metadataHash = r.bytesHex(32);
    if (!arbiter || nonce == null || tier == null || !metadataHash || !r.done()) return null;
    return nativeAgentCall("nativeAgentRegisterArbiter", [
      monoArg("arbiter", arbiter),
      uintArg("nonce", "uint64", nonce),
      numberArg("tier", "uint16", tier),
      bytesArg("metadata hash", metadataHash),
    ]);
  }
  if (call === 1) {
    const arbiterId = r.bytesHex(32);
    if (!arbiterId || !r.done()) return null;
    return nativeAgentCall("nativeAgentGetArbiter", [bytesArg("arbiter id", arbiterId)]);
  }
  return null;
}

function decodeNativeAgentSpendingPolicyPayload(r: NativeMarketPayloadReader, call: number): DecodedCall | null {
  if (call === 0) {
    const owner = r.monoAddress();
    const controller = r.monoAddress();
    const nonce = r.u64();
    const assetId = r.bytesHex(32);
    const perActionLimit = r.u128();
    const windowLimit = r.u128();
    const windowSecs = r.u64();
    if (
      !owner ||
      !controller ||
      nonce == null ||
      !assetId ||
      perActionLimit == null ||
      windowLimit == null ||
      windowSecs == null ||
      !r.done()
    ) {
      return null;
    }
    return nativeAgentCall("nativeAgentSetSpendingPolicy", [
      monoArg("owner", owner),
      monoArg("controller", controller),
      uintArg("nonce", "uint64", nonce),
      bytesArg("asset id", assetId),
      uintArg("per-action limit", "uint128", perActionLimit),
      uintArg("window limit", "uint128", windowLimit),
      uintArg("window seconds", "uint64", windowSecs),
    ]);
  }
  if (call === 1) {
    const policyId = r.bytesHex(32);
    const controller = r.monoAddress();
    const window = r.u64();
    const amount = r.u128();
    if (!policyId || !controller || window == null || amount == null || !r.done()) return null;
    return nativeAgentCall("nativeAgentRecordPolicySpend", [
      bytesArg("policy id", policyId),
      monoArg("controller", controller),
      uintArg("window", "uint64", window),
      uintArg("amount", "uint128", amount),
    ]);
  }
  if (call === 2) {
    const policyId = r.bytesHex(32);
    if (!policyId || !r.done()) return null;
    return nativeAgentCall("nativeAgentGetSpendingPolicy", [bytesArg("policy id", policyId)]);
  }
  return null;
}

function decodeNativeAgentEscrowPayload(r: NativeMarketPayloadReader, call: number): DecodedCall | null {
  if (call === 0) {
    const buyer = r.monoAddress();
    const provider = r.monoAddress();
    const arbiter = r.monoAddress();
    const nonce = r.u64();
    const assetId = r.bytesHex(32);
    const amount = r.u128();
    const termsHash = r.bytesHex(32);
    if (!buyer || !provider || !arbiter || nonce == null || !assetId || amount == null || !termsHash || !r.done()) {
      return null;
    }
    return nativeAgentCall("nativeAgentCreateEscrow", [
      monoArg("buyer", buyer),
      monoArg("provider", provider),
      monoArg("arbiter", arbiter),
      uintArg("nonce", "uint64", nonce),
      bytesArg("asset id", assetId),
      uintArg("amount", "uint128", amount),
      bytesArg("terms hash", termsHash),
    ]);
  }
  if (call === 1) {
    const escrowId = r.bytesHex(32);
    const actor = r.monoAddress();
    const termsHash = r.bytesHex(32);
    if (!escrowId || !actor || !termsHash || !r.done()) return null;
    return nativeAgentCall("nativeAgentCounterEscrow", [
      bytesArg("escrow id", escrowId),
      monoArg("actor", actor),
      bytesArg("terms hash", termsHash),
    ]);
  }
  if (call === 2 || call === 3 || (call >= 5 && call <= 7)) {
    const escrowId = r.bytesHex(32);
    const actor = r.monoAddress();
    if (!escrowId || !actor || !r.done()) return null;
    const names = [
      "nativeAgentAcceptEscrow",
      "nativeAgentStartEscrow",
      "nativeAgentSubmitEscrow",
      "nativeAgentApproveEscrow",
      "nativeAgentDisputeEscrow",
      "nativeAgentCancelEscrow",
    ];
    const name = names[call - 2];
    if (!name) return null;
    const actorName = call === 3 || call === 4 ? "provider" : "actor";
    return nativeAgentCall(name, [bytesArg("escrow id", escrowId), monoArg(actorName, actor)]);
  }
  if (call === 4) {
    const escrowId = r.bytesHex(32);
    const provider = r.monoAddress();
    const payloadHash = r.bytesHex(32);
    if (!escrowId || !provider || !payloadHash || !r.done()) return null;
    return nativeAgentCall("nativeAgentSubmitEscrow", [
      bytesArg("escrow id", escrowId),
      monoArg("provider", provider),
      bytesArg("payload hash", payloadHash),
    ]);
  }
  if (call === 8) {
    const escrowId = r.bytesHex(32);
    const actor = r.monoAddress();
    const resolution = r.u32();
    if (!escrowId || !actor || resolution == null || !r.done()) return null;
    return nativeAgentCall("nativeAgentResolveEscrow", [
      bytesArg("escrow id", escrowId),
      monoArg("actor", actor),
      numberArg(
        "resolution",
        "enum",
        resolution === 0 ? "release-provider" : resolution === 1 ? "refund-buyer" : `unknown (${resolution})`,
      ),
    ]);
  }
  if (call === 9) {
    const escrowId = r.bytesHex(32);
    if (!escrowId || !r.done()) return null;
    return nativeAgentCall("nativeAgentGetEscrow", [bytesArg("escrow id", escrowId)]);
  }
  return null;
}

function decodeNativeAgentReputationPayload(r: NativeMarketPayloadReader, call: number): DecodedCall | null {
  if (call === 0) {
    const reviewer = r.monoAddress();
    const subject = r.monoAddress();
    const categoryId = r.u32();
    const speed = r.u8();
    const quality = r.u8();
    const communication = r.u8();
    const accuracy = r.u8();
    const payloadHash = r.bytesHex(32);
    if (
      !reviewer ||
      !subject ||
      categoryId == null ||
      speed == null ||
      quality == null ||
      communication == null ||
      accuracy == null ||
      !payloadHash ||
      !r.done()
    ) {
      return null;
    }
    return nativeAgentCall("nativeAgentRecordReputation", [
      monoArg("reviewer", reviewer),
      monoArg("subject", subject),
      numberArg("category id", "uint32", categoryId),
      numberArg("speed", "uint8", speed),
      numberArg("quality", "uint8", quality),
      numberArg("communication", "uint8", communication),
      numberArg("accuracy", "uint8", accuracy),
      bytesArg("payload hash", payloadHash),
    ]);
  }
  if (call === 1) {
    const subject = r.monoAddress();
    const categoryId = r.u32();
    if (!subject || categoryId == null || !r.done()) return null;
    return nativeAgentCall("nativeAgentGetReputation", [
      monoArg("subject", subject),
      numberArg("category id", "uint32", categoryId),
    ]);
  }
  return null;
}

function nativeAgentCall(name: string, args: DecodedCall["args"]): DecodedCall {
  return {
    name,
    selector: "native-bincode",
    surface: "native-agent",
    args,
  };
}

function monoArg(name: string, value: { kind: AddressKind; display: string }): DecodedCall["args"][number] {
  return { name, type: value.kind, value: value.display };
}

function bytesArg(name: string, value: string): DecodedCall["args"][number] {
  return { name, type: "bytes32", value };
}

function uintArg(name: string, type: string, value: bigint): DecodedCall["args"][number] {
  return { name, type, value: value.toString(10) };
}

function numberArg(name: string, type: string, value: number | string): DecodedCall["args"][number] {
  return { name, type, value: typeof value === "number" ? value.toString(10) : value };
}

function decodeNativeSpotLimitOrderPayload(r: NativeMarketPayloadReader): DecodedCall | null {
  const marketId = r.bytesHex(32);
  const owner = r.monoAddress();
  const nonce = r.u64();
  const side = r.u32();
  const price = r.u128();
  const quantity = r.u128();
  const expiresAtBlock = r.u64();
  if (
    !marketId ||
    !owner ||
    nonce == null ||
    side == null ||
    price == null ||
    quantity == null ||
    expiresAtBlock == null ||
    !r.done()
  ) {
    return null;
  }
  const sideLabel = side === 0 ? "bid" : side === 1 ? "ask" : `unknown (${side})`;
  return {
    name: "nativeSpotPlaceLimitOrder",
    selector: "native-bincode",
    surface: "native-market",
    args: [
      { name: "market id", type: "bytes32", value: marketId },
      { name: "owner", type: owner.kind, value: owner.display },
      { name: "nonce", type: "uint64", value: nonce.toString(10) },
      { name: "side", type: "enum", value: sideLabel },
      { name: "price", type: "uint128", value: price.toString(10) },
      { name: "quantity", type: "uint128", value: quantity.toString(10) },
      { name: "expires at block", type: "uint64", value: expiresAtBlock.toString(10) },
    ],
  };
}

function decodeNativeSpotCancelOrderPayload(r: NativeMarketPayloadReader): DecodedCall | null {
  const orderId = r.bytesHex(32);
  const caller = r.monoAddress();
  if (!orderId || !caller || !r.done()) return null;
  return {
    name: "nativeSpotCancelOrder",
    selector: "native-bincode",
    surface: "native-market",
    args: [
      { name: "order id", type: "bytes32", value: orderId },
      { name: "caller", type: caller.kind, value: caller.display },
    ],
  };
}

function decodeNativeNftCreateListingPayload(r: NativeMarketPayloadReader): DecodedCall | null {
  const seller = r.monoAddress();
  const nonce = r.u64();
  const standard = r.u32();
  const collectionId = r.bytesHex(32);
  const tokenId = r.bytesHex(32);
  const quantity = r.u128();
  const paymentAsset = r.bytesHex(32);
  const price = r.u128();
  const listingKind = decodeNativeNftListingKind(r);
  const expiresAtBlock = r.u64();
  if (
    !seller ||
    nonce == null ||
    standard == null ||
    !collectionId ||
    !tokenId ||
    quantity == null ||
    !paymentAsset ||
    price == null ||
    !listingKind ||
    expiresAtBlock == null ||
    !r.done()
  ) {
    return null;
  }
  const standardLabel =
    standard === 0 ? "mrc721" : standard === 1 ? "mrc1155" : `unknown (${standard})`;
  return {
    name: "nativeNftCreateListing",
    selector: "native-bincode",
    surface: "native-market",
    args: [
      { name: "seller", type: seller.kind, value: seller.display },
      { name: "nonce", type: "uint64", value: nonce.toString(10) },
      { name: "standard", type: "enum", value: standardLabel },
      { name: "collection id", type: "bytes32", value: collectionId },
      { name: "token id", type: "bytes32", value: tokenId },
      { name: "quantity", type: "uint128", value: quantity.toString(10) },
      { name: "payment asset", type: "bytes32", value: paymentAsset },
      { name: "price", type: "uint128", value: price.toString(10) },
      { name: "listing kind", type: "enum", value: listingKind },
      { name: "expires at block", type: "uint64", value: expiresAtBlock.toString(10) },
    ],
  };
}

function decodeNativeNftBuyListingPayload(r: NativeMarketPayloadReader): DecodedCall | null {
  const listingId = r.bytesHex(32);
  const buyer = r.monoAddress();
  const currentBlock = r.u64();
  if (!listingId || !buyer || currentBlock == null || !r.done()) return null;
  return {
    name: "nativeNftBuyListing",
    selector: "native-bincode",
    surface: "native-market",
    args: [
      { name: "listing id", type: "bytes32", value: listingId },
      { name: "buyer", type: buyer.kind, value: buyer.display },
      { name: "current block", type: "uint64", value: currentBlock.toString(10) },
    ],
  };
}

function decodeNativeNftCancelListingPayload(r: NativeMarketPayloadReader): DecodedCall | null {
  const listingId = r.bytesHex(32);
  const caller = r.monoAddress();
  if (!listingId || !caller || !r.done()) return null;
  return {
    name: "nativeNftCancelListing",
    selector: "native-bincode",
    surface: "native-market",
    args: [
      { name: "listing id", type: "bytes32", value: listingId },
      { name: "caller", type: caller.kind, value: caller.display },
    ],
  };
}

function decodeNativeNftSweepExpiredListingsPayload(r: NativeMarketPayloadReader): DecodedCall | null {
  const listingIds = r.bytes32Vec(64);
  const currentBlock = r.u64();
  if (!listingIds || currentBlock == null || !r.done()) return null;
  return {
    name: "nativeNftSweepExpiredListings",
    selector: "native-bincode",
    surface: "native-market",
    args: [
      { name: "listing ids", type: "bytes32[]", value: listingIds.join(", ") },
      { name: "current block", type: "uint64", value: currentBlock.toString(10) },
    ],
  };
}

function decodeNativeNftPlaceAuctionBidPayload(r: NativeMarketPayloadReader): DecodedCall | null {
  const listingId = r.bytesHex(32);
  const bidder = r.monoAddress();
  const amount = r.u128();
  const currentBlock = r.u64();
  if (!listingId || !bidder || amount == null || currentBlock == null || !r.done()) return null;
  return {
    name: "nativeNftPlaceAuctionBid",
    selector: "native-bincode",
    surface: "native-market",
    args: [
      { name: "listing id", type: "bytes32", value: listingId },
      { name: "bidder", type: bidder.kind, value: bidder.display },
      { name: "amount", type: "uint128", value: amount.toString(10) },
      { name: "current block", type: "uint64", value: currentBlock.toString(10) },
    ],
  };
}

function decodeNativeNftSettleAuctionPayload(r: NativeMarketPayloadReader): DecodedCall | null {
  const listingId = r.bytesHex(32);
  const currentBlock = r.u64();
  if (!listingId || currentBlock == null || !r.done()) return null;
  return {
    name: "nativeNftSettleAuction",
    selector: "native-bincode",
    surface: "native-market",
    args: [
      { name: "listing id", type: "bytes32", value: listingId },
      { name: "current block", type: "uint64", value: currentBlock.toString(10) },
    ],
  };
}

function decodeNativeNftListingKind(r: NativeMarketPayloadReader): string | null {
  const kind = r.u32();
  if (kind == null) return null;
  if (kind === 0) return "fixed-price";
  if (kind === 1) {
    const reserve = r.u128();
    const endBlock = r.u64();
    const minBidIncrementBps = r.u16();
    if (reserve == null || endBlock == null || minBidIncrementBps == null) return null;
    return `english reserve=${reserve.toString(10)} end=${endBlock.toString(10)} min-bump=${minBidIncrementBps}bps`;
  }
  return `unknown (${kind})`;
}

class NativeMarketPayloadReader {
  private constructor(
    private readonly bytes: Uint8Array,
    private offset: number,
  ) {}

  static fromHex(hex: string): NativeMarketPayloadReader | null {
    const raw = hex.slice(2);
    if (raw.length === 0 || raw.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(raw)) {
      return null;
    }
    const bytes = new Uint8Array(raw.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Number.parseInt(raw.slice(i * 2, i * 2 + 2), 16);
    }
    return new NativeMarketPayloadReader(bytes, 0);
  }

  done(): boolean {
    return this.offset === this.bytes.length;
  }

  bytesHex(length: number): string | null {
    if (this.offset + length > this.bytes.length) return null;
    const slice = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return `0x${[...slice].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  }

  bytes32Vec(maxItems: number): string[] | null {
    const length = this.u64();
    if (length == null || length > BigInt(maxItems)) return null;
    const out: string[] = [];
    for (let i = 0n; i < length; i++) {
      const value = this.bytesHex(32);
      if (!value) return null;
      out.push(value);
    }
    return out;
  }

  u32(): number | null {
    if (this.offset + 4 > this.bytes.length) return null;
    const value =
      this.bytes[this.offset]! |
      (this.bytes[this.offset + 1]! << 8) |
      (this.bytes[this.offset + 2]! << 16) |
      (this.bytes[this.offset + 3]! << 24);
    this.offset += 4;
    return value >>> 0;
  }

  u64(): bigint | null {
    return this.uintLe(8);
  }

  u16(): number | null {
    if (this.offset + 2 > this.bytes.length) return null;
    const value = this.bytes[this.offset]! | (this.bytes[this.offset + 1]! << 8);
    this.offset += 2;
    return value;
  }

  u8(): number | null {
    if (this.offset + 1 > this.bytes.length) return null;
    const value = this.bytes[this.offset]!;
    this.offset += 1;
    return value;
  }

  u128(): bigint | null {
    return this.uintLe(16);
  }

  monoAddress(): { kind: AddressKind; display: string } | null {
    const kindVariant = this.u32();
    const addressHex = this.bytesHex(20);
    if (kindVariant == null || !addressHex) return null;
    const kind = NATIVE_MARKET_KIND_LABELS[kindVariant];
    if (!kind) return null;
    return { kind, display: addressToTypedBech32(kind, addressHex) };
  }

  private uintLe(length: number): bigint | null {
    if (this.offset + length > this.bytes.length) return null;
    let value = 0n;
    for (let i = 0; i < length; i++) {
      value |= BigInt(this.bytes[this.offset + i]!) << BigInt(8 * i);
    }
    this.offset += length;
    return value;
  }
}

function readBytes32(body: string, slot: number): string | null {
  const word = body.slice(slot * 64, (slot + 1) * 64);
  return word.length === 64 ? "0x" + word : null;
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
  const [showFeeDetails, setShowFeeDetails] = useState(false);
  const devMode = useFeature("DEVELOPER_MODE");

  const originWarnings = detectOriginWarnings(origin);
  const hasOriginDanger = originWarnings.some((w) => w.level === "danger");

  const hasStructuredFee = view.structuredFee !== undefined;
  const baseExecutionUnitPrice = hasStructuredFee
    ? null
    : parseHexQuantity(view.pricePerExecutionUnitLythoshiHex);
  const tieredExecutionUnitPrice =
    baseExecutionUnitPrice == null
      ? null
      : applyFeeTier(baseExecutionUnitPrice, tier);
  const tieredHex =
    tieredExecutionUnitPrice == null ? null : "0x" + tieredExecutionUnitPrice.toString(16);

  const feeDisplayResult = nativeFeeDisplayFromPrice({
    executionUnitLimitHex: view.executionUnitLimitHex,
    pricePerExecutionUnitLythoshiHex: view.pricePerExecutionUnitLythoshiHex,
    priceMultiplierBps: APPROVAL_FEE_TIER_BPS[tier],
    ...(view.structuredFee !== undefined ? { structuredFee: view.structuredFee } : {}),
  });
  const feeDisplay = feeDisplayResult.ok ? feeDisplayResult.display : null;
  const feeDisplayError = feeDisplayResult.ok
    ? null
    : feeDisplayResult.failures.join("; ");

  const value = tx.value;
  const data = tx.data ?? "0x";
  const hasCalldata = data.length > 2;
  const decoded = hasCalldata ? decodeCalldata(data, tx.to) : null;
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

      {devMode && hasCalldata && (
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
        <div className="req-section__h">
          <span>Network fee</span>
          {devMode && (
            <button onClick={() => setShowFeeDetails((v) => !v)}>
              {showFeeDetails ? "hide" : "details"} ↓
            </button>
          )}
        </div>
        {!hasStructuredFee && (
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
        )}
        {feeDisplay?.source === "structured" ? (
          <>
            <div className="req-kv">
              <span className="k">Max fee</span>
              <span className="v">{feeDisplay.defaultText}</span>
            </div>
            {showFeeDetails &&
              feeDisplay.detailTexts.map((detail, index) => (
                <div className="req-kv" key={`${index}-${detail}`}>
                  <span className="k">Detail {index + 1}</span>
                  <span className="v" style={{ fontFamily: "var(--f-mono)", fontSize: 10 }}>
                    {detail}
                  </span>
                </div>
              ))}
          </>
        ) : hasStructuredFee ? (
          <div className="req-kv">
            <span className="k">Max fee</span>
            <span className="v">—</span>
          </div>
        ) : (
          <>
            <div className="req-kv">
              <span className="k">Max fee</span>
              <span className="v">{feeDisplay?.defaultText ?? "—"}</span>
            </div>
            {devMode && showFeeDetails && (
              <>
                <div className="req-kv">
                  <span className="k">Execution-unit limit</span>
                  <span className="v">{formatExecutionUnits(view.executionUnitLimitHex)}</span>
                </div>
                <div className="req-kv">
                  <span className="k">Price / execution unit</span>
                  <span className="v">{formatLythoshiPerExecutionUnit(tieredHex)} lythoshi</span>
                </div>
              </>
            )}
          </>
        )}
        {feeDisplayError !== null && (
          <div className="req-warn warn" style={{ marginTop: 8 }}>
            <Icon name="warn" size={14} />
            <div>Malformed fee data: {feeDisplayError}</div>
          </div>
        )}
      </div>

      {devMode && decoded && (
        <div className="req-section">
          <div className="req-section__h">
            <span>{decodedSurfaceTitle(decoded)}</span>
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

      {devMode && hasCalldata && !decoded && (
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

      {devMode && (
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
      )}

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

function decodedSurfaceTitle(decoded: DecodedCall): string {
  if (decoded.surface === "native-market") return "Native market action";
  if (decoded.surface === "native-agent") return "Native agent action";
  return "Decoded call";
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

      {parsed && !digest && (
        <div
          className="req-section"
          style={{
            padding: "8px 10px",
            borderRadius: 10,
            background: "rgba(220, 70, 70, 0.12)",
            border: "1px solid rgba(220, 70, 70, 0.45)",
            color: "#ff9b9b",
            fontSize: 11,
            lineHeight: 1.4,
          }}
        >
          Cannot encode this typed data — a field does not match its declared
          type. Signing is disabled so the wallet never signs a digest that
          differs from what is shown.
        </div>
      )}

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
          disabled={!parsed || !digest}
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
