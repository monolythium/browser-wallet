// Activity-detail modal — a compact summary popup opened by tapping a row in
// the Activity list. Shares the receipt visual language (rows + the shared
// lythoshi formatter) but is intentionally smaller: addresses are truncated,
// fee/total are dropped.
//
// Address rendering is defensive: the indexer hands counterparties as bech32m
// (`mono…`) strings while the wallet's own address is 0x — bech32mDisplay
// handles both and NEVER throws, and the truncation is plain string slicing
// (the strict shortBech32m/addressToBech32m path throws on non-0x input, which
// previously crashed the whole view via the ErrorBoundary).
//
// Honest-absence: a delegate's LYTH principal + every row's canonical tx hash
// are resolved on demand from the block (eth_getBlockByNumber → tx.value/.hash);
// when the lookup fails or returns nothing, the LYTH / Monoscan button are
// simply omitted. Delegations have no cluster bech32m → cluster shows name +
// #id, no link.

import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { Icon } from "../Icon";
import { Modal } from "./Modal";
import { ExternalLink } from "./ExternalLink";
import { CheckIcon, ClipboardIcon } from "./AddressLine";
import { bech32mDisplay } from "../../shared/bech32m";
import { monoscanAddressUrl, monoscanTxUrl } from "../../shared/build-info";
import { formatNativeLythAmount } from "../../shared/native-fee-display";
import { formatWeightBpsPercent } from "../../shared/staking";
import type { ActivityRow as ActivityRowType } from "../../shared/activity";
import type { NameLabel } from "../../shared/name-resolution";
import { bgGetBlockTxValue } from "../bg";

export interface ActivityDetailProps {
  row: ActivityRowType;
  /** Resolved name for the row's counterparty (registered → contact → none). */
  label: NameLabel | undefined;
  /** The active wallet's own 0x address (the From of sends / Delegator). */
  walletAddr: string;
  onClose: () => void;
}

function clusterName(id: number): string {
  return `C-${String(id + 1).padStart(3, "0")}.cluster.mono`;
}

/** Middle-truncate any string (bech32m address or hash) for compact display.
 *  Pure — never throws. */
function truncMiddle(s: string, head = 10, tail = 6): string {
  return s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
}

function relativeMs(ms: number): string {
  const delta = Math.max(0, Date.now() - ms);
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return `${Math.floor(delta / 3_600_000)}h ago`;
}

function DRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        gap: 12,
        padding: "6px 0",
      }}
    >
      <div
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 9.5,
          color: "var(--fg-500)",
          letterSpacing: "0.1em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 11,
          color: "var(--fg-100)",
          textAlign: "right",
          wordBreak: "break-all",
          minWidth: 0,
        }}
      >
        {value}
      </div>
    </div>
  );
}

/** "View on Monoscan" CTA → the tx page. Globe glyph, matching the receipts. */
function MonoscanTxButton({ hash }: { hash: string }) {
  return (
    <a
      href={monoscanTxUrl(hash)}
      target="_blank"
      rel="noopener noreferrer"
      className="ext-act"
      style={{
        width: "100%",
        padding: "10px",
        marginTop: 12,
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        textDecoration: "none",
      }}
    >
      <Icon name="globe" size={13} /> View on Monoscan
    </a>
  );
}

/** Truncated address → Monoscan address page, with a copy button. Accepts a
 *  0x address (own wallet) or an already-bech32m counterparty — both via the
 *  safe bech32mDisplay. Renders the registered/contact name when present. */
function CopyableAddress({
  addr0x,
  name,
}: {
  addr0x: string;
  name?: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const full = bech32mDisplay(addr0x);
  const short = truncMiddle(full);
  const onCopy = () => {
    void navigator.clipboard.writeText(full).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: 2,
      }}
    >
      {name && (
        <span style={{ fontFamily: "var(--f-sans)", fontWeight: 600, color: "var(--fg-100)" }}>
          {name}
        </span>
      )}
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        <ExternalLink href={monoscanAddressUrl(full)} title={full} style={{ fontFamily: "var(--f-mono)" }}>
          {short}
        </ExternalLink>
        <button
          onClick={onCopy}
          aria-label="Copy address"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 18,
            height: 18,
            padding: 0,
            background: "transparent",
            border: "none",
            color: copied ? "var(--ok, #5fc97a)" : "var(--fg-400)",
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          {copied ? <CheckIcon /> : <ClipboardIcon />}
        </button>
      </span>
    </div>
  );
}

export function ActivityDetail({ row, label, walletAddr, onClose }: ActivityDetailProps) {
  // Confirmed rows carry a (blockHeight, txIndex) coordinate but no hash/amount
  // in the indexer stream. Resolve the tx on demand from the block so we can:
  //  - show the LYTH principal for delegate rows (tx msg.value), and
  //  - link the canonical tx hash on a "View on Monoscan" button.
  const lookupHeight = row.kind !== "pending_tx" ? row.blockHeight : null;
  const lookupTxIndex = row.kind !== "pending_tx" ? row.txIndex : null;
  const [resolvedValueHex, setResolvedValueHex] = useState<string | null>(null);
  const [resolvedTxHash, setResolvedTxHash] = useState<string | null>(null);
  useEffect(() => {
    if (lookupHeight === null || lookupTxIndex === null) return;
    let cancelled = false;
    void (async () => {
      const r = await bgGetBlockTxValue(lookupHeight, lookupTxIndex);
      if (cancelled || !r.ok) return;
      if (r.valueHex !== null) setResolvedValueHex(r.valueHex);
      if (r.txHash !== null) setResolvedTxHash(r.txHash);
    })();
    return () => {
      cancelled = true;
    };
  }, [lookupHeight, lookupTxIndex]);

  // delegate LYTH principal (msg.value). Undelegate/redelegate send value:0 →
  // omit (honest-absence) rather than render "0 LYTH".
  const delegateLyth = (() => {
    if (row.kind !== "delegate" || resolvedValueHex === null) return null;
    try {
      const v = BigInt(resolvedValueHex);
      return v > 0n ? formatNativeLythAmount(v) : null;
    } catch {
      return null;
    }
  })();

  const name = label?.displayName ?? null;

  // ── Pending send ──
  if (row.kind === "pending_tx") {
    return (
      <Modal open onClose={onClose} title="Pending send" showClose>
        <div>
          <DRow label="Status" value="Pending" />
          <DRow label="Amount" value={`${row.amountDecimal} LYTH`} />
          <DRow label="From" value={<CopyableAddress addr0x={walletAddr} />} />
          <DRow label="To" value={<CopyableAddress addr0x={row.to} name={name} />} />
          <DRow
            label="Tx hash"
            value={
              <ExternalLink href={monoscanTxUrl(row.txHash)} title={row.txHash} style={{ fontFamily: "var(--f-mono)" }}>
                {truncMiddle(row.txHash)}
              </ExternalLink>
            }
          />
          {row.broadcastBlockHeight !== null && (
            <DRow label="Block" value={row.broadcastBlockHeight.toLocaleString("en-US")} />
          )}
          <DRow label="Submitted" value={relativeMs(row.broadcastedAtMs)} />
          <MonoscanTxButton hash={row.txHash} />
        </div>
      </Modal>
    );
  }

  // ── Confirmed transfer (native send/receive + token) ──
  if (row.kind === "tx_send" || row.kind === "tx_receive" || row.kind === "token_transfer") {
    const isIn = row.kind === "tx_receive";
    const title =
      row.kind === "token_transfer" ? "Token transfer" : isIn ? "Received" : "Sent";
    const cp = row.counterparty;
    return (
      <Modal open onClose={onClose} title={title} showClose>
        <div>
          <DRow label="Status" value="Confirmed" />
          <DRow label="Amount" value={row.amountDecimal !== null ? `${row.amountDecimal} LYTH` : "—"} />
          {isIn ? (
            <>
              <DRow label="From" value={cp ? <CopyableAddress addr0x={cp} name={name} /> : "unknown"} />
              <DRow label="To" value={<CopyableAddress addr0x={walletAddr} />} />
            </>
          ) : (
            <>
              <DRow label="From" value={<CopyableAddress addr0x={walletAddr} />} />
              <DRow label="To" value={cp ? <CopyableAddress addr0x={cp} name={name} /> : "unknown"} />
            </>
          )}
          <DRow label="Block" value={row.blockHeight.toLocaleString("en-US")} />
          <DRow label="Tx index" value={String(row.txIndex)} />
          {resolvedTxHash !== null && <MonoscanTxButton hash={resolvedTxHash} />}
        </div>
      </Modal>
    );
  }

  // ── Delegation family ──
  if (row.kind === "delegate" || row.kind === "undelegate" || row.kind === "redelegate") {
    const title =
      row.kind === "undelegate" ? "Undelegation" : row.kind === "redelegate" ? "Redelegation" : "Delegation";
    return (
      <Modal open onClose={onClose} title={title} showClose>
        <div>
          <DRow label="Status" value="Confirmed" />
          {row.kind === "delegate" && delegateLyth !== null && (
            <DRow label="Amount" value={delegateLyth} />
          )}
          <DRow label="Weight" value={formatWeightBpsPercent(row.weightBps)} />
          <DRow label="Cluster" value={`${clusterName(row.cluster)} · #${row.cluster}`} />
          <DRow label="Delegator" value={<CopyableAddress addr0x={walletAddr} />} />
          <DRow label="Block" value={row.blockHeight.toLocaleString("en-US")} />
          <DRow label="Tx index" value={String(row.txIndex)} />
          {resolvedTxHash !== null && <MonoscanTxButton hash={resolvedTxHash} />}
        </div>
      </Modal>
    );
  }

  // ── rebalance / crossing_to_private — minimal honest view ──
  return (
    <Modal open onClose={onClose} title="Activity" showClose>
      <div>
        <DRow label="Type" value={row.kind} />
        <DRow label="Block" value={row.blockHeight.toLocaleString("en-US")} />
        <DRow label="Tx index" value={String(row.txIndex)} />
        {resolvedTxHash !== null && <MonoscanTxButton hash={resolvedTxHash} />}
      </div>
    </Modal>
  );
}
