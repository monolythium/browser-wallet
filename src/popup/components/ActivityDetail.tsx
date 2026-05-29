// Activity-detail modal — a compact summary popup opened by tapping a row in
// the Activity list. Shares the receipt visual language (rows + ExternalLink +
// the shared lythoshi formatter) but is intentionally smaller: addresses are
// truncated, fee/total are dropped.
//
// Honest-absence throughout:
//  - tx hash links to Monoscan only when the row carries one (pending sends);
//    confirmed/received/indexer rows have no hash and show none (we do NOT
//    block-lookup just to manufacture a link).
//  - delegations have no cluster bech32m → cluster shows name + #id, no link.
//  - delegate LYTH principal is resolved on demand from the tx `value` via a
//    block lookup; undelegate/redelegate carry no msg.value → percentage only.

import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { Modal } from "./Modal";
import { ExternalLink } from "./ExternalLink";
import { CheckIcon, ClipboardIcon } from "./AddressLine";
import { bech32mDisplay, shortBech32m } from "../../shared/bech32m";
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

function shortHash(hash: string): string {
  return hash.length > 20 ? `${hash.slice(0, 10)}…${hash.slice(-8)}` : hash;
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

/** Truncated bech32m address → Monoscan address page, with a copy button.
 *  Renders the registered/contact name above the address when present. */
function CopyableAddress({
  addr0x,
  name,
}: {
  addr0x: string;
  name?: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const full = bech32mDisplay(addr0x);
  const short = shortBech32m(addr0x, 6);
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
  // On-demand LYTH principal for delegate rows (the indexer carries no amount;
  // the delegate tx's msg.value IS the principal). Undelegate/redelegate send
  // value:0 → we don't look up / show LYTH for those.
  const [delegateLyth, setDelegateLyth] = useState<string | null>(null);
  const isDelegate = row.kind === "delegate";
  const lookupHeight = isDelegate ? row.blockHeight : null;
  const lookupTxIndex = isDelegate ? row.txIndex : null;
  useEffect(() => {
    if (lookupHeight === null || lookupTxIndex === null) return;
    let cancelled = false;
    void (async () => {
      const r = await bgGetBlockTxValue(lookupHeight, lookupTxIndex);
      if (cancelled || !r.ok || r.valueHex === null) return;
      let v: bigint;
      try {
        v = BigInt(r.valueHex);
      } catch {
        return;
      }
      if (v > 0n) setDelegateLyth(formatNativeLythAmount(v));
    })();
    return () => {
      cancelled = true;
    };
  }, [lookupHeight, lookupTxIndex]);

  const name = label?.displayName ?? null;

  // ── Pending send ──
  if (row.kind === "pending_tx") {
    return (
      <Modal open onClose={onClose} title="Pending send">
        <div>
          <DRow label="Status" value="Pending" />
          <DRow label="Amount" value={`${row.amountDecimal} LYTH`} />
          <DRow label="From" value={<CopyableAddress addr0x={walletAddr} />} />
          <DRow label="To" value={<CopyableAddress addr0x={row.to} name={name} />} />
          <DRow
            label="Tx hash"
            value={
              <ExternalLink href={monoscanTxUrl(row.txHash)} title={row.txHash} style={{ fontFamily: "var(--f-mono)" }}>
                {shortHash(row.txHash)}
              </ExternalLink>
            }
          />
          {row.broadcastBlockHeight !== null && (
            <DRow label="Block" value={row.broadcastBlockHeight.toLocaleString("en-US")} />
          )}
          <DRow label="Submitted" value={relativeMs(row.broadcastedAtMs)} />
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
      <Modal open onClose={onClose} title={title}>
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
          {/* No tx hash on indexer rows; we do not fetch one to manufacture a
              link. Block + tx index are the on-chain coordinate. */}
          <DRow label="Block" value={row.blockHeight.toLocaleString("en-US")} />
          <DRow label="Tx index" value={String(row.txIndex)} />
        </div>
      </Modal>
    );
  }

  // ── Delegation family ──
  if (row.kind === "delegate" || row.kind === "undelegate" || row.kind === "redelegate") {
    const title =
      row.kind === "undelegate" ? "Undelegation" : row.kind === "redelegate" ? "Redelegation" : "Delegation";
    return (
      <Modal open onClose={onClose} title={title}>
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
        </div>
      </Modal>
    );
  }

  // ── rebalance / crossing_to_private — minimal honest view ──
  return (
    <Modal open onClose={onClose} title="Activity">
      <div>
        <DRow label="Type" value={row.kind} />
        <DRow label="Block" value={row.blockHeight.toLocaleString("en-US")} />
        <DRow label="Tx index" value={String(row.txIndex)} />
      </div>
    </Modal>
  );
}
