// Activity-detail modal — a compact summary popup opened by tapping a row in
// the Activity list. Shares the receipt visual language (rows + the shared
// lythoshi formatter) but is intentionally smaller: addresses are truncated.
// The LYTH fee is resolved on demand from the native receipt for self-paid
// rows (the indexer stream carries no fee); incoming rows show no fee line.
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

import { Modal } from "./Modal";
import { ExternalLink } from "./ExternalLink";
import {
  CopyableAddress,
  DRow,
  MonoscanTxButton,
  relativeMs,
  truncMiddle,
} from "./_detailModalParts";
import { monoscanTxUrl } from "../../shared/build-info";
import { formatNativeLythAmount } from "../../shared/native-fee-display";
import { formatWeightBpsPercent } from "../../shared/staking";
import { txTypeLabel } from "../../shared/tx-type-label";
import type { ActivityRow as ActivityRowType } from "../../shared/activity";
import type { NameLabel } from "../../shared/name-resolution";
import { bgGetBlockTxValue, bgWalletTxFee } from "../bg";

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

/** Rows the queried wallet paid the fee for (it originated the tx). Incoming
 *  transfers + system rebalances were paid by someone else → no fee line. */
function isSelfPaid(row: ActivityRowType): boolean {
  switch (row.kind) {
    case "tx_send":
    case "delegate":
    case "undelegate":
    case "redelegate":
    case "crossing_to_private":
      return true;
    case "token_transfer":
      return row.direction === "out";
    default:
      return false;
  }
}

// `truncMiddle`, `relativeMs`, `DRow`, `MonoscanTxButton`, and
// `CopyableAddress` live in `./_detailModalParts.tsx` (extracted in
// Phase 3/4 C4 so the `NotificationDetail` modal can share the same
// primitives without duplicating them). Behavior is byte-identical to
// the prior inlined versions — the existing activity tests pin this.

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

  // LYTH fee — resolved on demand from the native receipt once the canonical
  // tx hash is known, but only for rows the wallet paid for (self-paid). The
  // indexer activity stream carries no fee, so this is the only honest source
  // for an indexer-sourced confirmed row. Null on zero-fee / unavailable
  // (failed / reverted / pruned) → no fee line (no-mock).
  const selfPaid = isSelfPaid(row);
  const [resolvedFeeLythoshi, setResolvedFeeLythoshi] = useState<string | null>(null);
  useEffect(() => {
    if (!selfPaid || resolvedTxHash === null) return;
    let cancelled = false;
    void (async () => {
      const r = await bgWalletTxFee(resolvedTxHash);
      if (cancelled || !r.ok) return;
      if (r.feeLythoshi !== null) setResolvedFeeLythoshi(r.feeLythoshi);
    })();
    return () => {
      cancelled = true;
    };
  }, [selfPaid, resolvedTxHash]);

  const feeText = (() => {
    if (resolvedFeeLythoshi === null) return null;
    try {
      const v = BigInt(resolvedFeeLythoshi);
      return v > 0n ? `- ${formatNativeLythAmount(v)}` : null;
    } catch {
      return null;
    }
  })();

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
      <Modal open onClose={onClose} title={txTypeLabel(row)} showClose>
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
    const title = txTypeLabel(row);
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
          {feeText && <DRow label="Fee" value={feeText} />}
          <DRow label="Block" value={row.blockHeight.toLocaleString("en-US")} />
          {resolvedTxHash !== null && <MonoscanTxButton hash={resolvedTxHash} />}
        </div>
      </Modal>
    );
  }

  // ── Delegation family ──
  if (row.kind === "delegate" || row.kind === "undelegate" || row.kind === "redelegate") {
    const title = txTypeLabel(row);
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
          {feeText && <DRow label="Fee" value={feeText} />}
          <DRow label="Block" value={row.blockHeight.toLocaleString("en-US")} />
          {resolvedTxHash !== null && <MonoscanTxButton hash={resolvedTxHash} />}
        </div>
      </Modal>
    );
  }

  // ── rebalance / crossing_to_private — minimal honest view ──
  return (
    <Modal open onClose={onClose} title={txTypeLabel(row)} showClose>
      <div>
        {feeText && <DRow label="Fee" value={feeText} />}
        <DRow label="Block" value={row.blockHeight.toLocaleString("en-US")} />
        {resolvedTxHash !== null && <MonoscanTxButton hash={resolvedTxHash} />}
      </div>
    </Modal>
  );
}
