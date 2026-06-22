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
// simply omitted. Delegations have no cluster bech32m → the cluster shows the
// real captured *.cluster.mono name when known, else an honest `Cluster #<id>`
// (clusterLabel); never a fabricated name, no link.

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
import { formatFiat } from "../../shared/fiat";
import { formatLythDecimalDisplay } from "../../shared/lyth-units";
import { DISPLAY_CURRENCY_DEFAULT } from "../../shared/constants";
import { resolveClusterLabel, formatWeightBpsPercent } from "../../shared/staking";
import { txTypeLabel } from "../../shared/tx-type-label";
import type { ActivityRow as ActivityRowType, PendingTxRow } from "../../shared/activity";
import type { NameLabel } from "../../shared/name-resolution";
import { bgGetBlockTxValue, bgWalletTxFee } from "../bg";

export interface ActivityDetailProps {
  row: ActivityRowType;
  /** Resolved name for the row's counterparty (registered → contact → none). */
  label: NameLabel | undefined;
  /** The active wallet's own 0x address (the From of sends / Delegator). */
  walletAddr: string;
  /** Cluster directory (id → name) for delegation rows — resolves the numeric
   *  cluster id to its real name, else `Cluster #<id>` (no-mock). */
  clusterNameById?: ReadonlyMap<number, string | null> | undefined;
  onClose: () => void;
}

/** Rows the queried wallet paid the fee for (it originated the tx). Incoming
 *  transfers + system rebalances were paid by someone else → no fee line. */
/** True when the wallet paid this row's fee → the on-demand fee fetch runs and
 *  a Fee row may render. Exported for unit coverage of the #7 claim case. */
export function isSelfPaid(row: ActivityRowType): boolean {
  switch (row.kind) {
    case "tx_send":
    case "delegate":
    case "undelegate":
    case "redelegate":
    case "crossing_to_private":
      return true;
    case "token_transfer":
      return row.direction === "out";
    case "pending_tx":
      // A reward claim self-pays its fee (wallet-initiated) and carries its own
      // txHash, so the on-demand fee fetch can resolve it. Other pending rows
      // resolve their fee via the confirmed counterpart instead (return false).
      return row.source === "local-claim";
    default:
      return false;
  }
}

/** What the Amount row renders for a pending row. A reward claim's tx value is
 *  0x0, so its `amountDecimal` is "0" — the real figure is decoded from the
 *  receipt's `Claimed` log after confirmation. A confirmed claim is NEVER 0, so
 *  a claim with no decoded figure (null/""/"0") must render bare "Rewards
 *  claimed", NOT "0 LYTH" (no-mock). Any other pending row shows amountDecimal.
 *  Pure + exported for unit coverage (the modal portals, so it can't be
 *  render-tested). */
export type PendingAmountDisplay =
  | { kind: "claim-figure"; lyth: string }
  | { kind: "claim-no-figure" }
  | { kind: "plain"; lyth: string };

export function pendingAmountDisplay(row: PendingTxRow): PendingAmountDisplay {
  if (row.source === "local-claim") {
    return row.claimedAmount && row.claimedAmount !== "0"
      ? { kind: "claim-figure", lyth: row.claimedAmount }
      : { kind: "claim-no-figure" };
  }
  return { kind: "plain", lyth: row.amountDecimal };
}

// `truncMiddle`, `relativeMs`, `DRow`, `MonoscanTxButton`, and
// `CopyableAddress` live in `./_detailModalParts.tsx` (extracted in
// so the `NotificationDetail` modal can share the same
// primitives without duplicating them). Behavior is byte-identical to
// the prior inlined versions — the existing activity tests pin this.

export function ActivityDetail({ row, label, walletAddr, clusterNameById, onClose }: ActivityDetailProps) {
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
  // A claim row carries its own txHash directly (broadcast capture); confirmed
  // rows resolve it from the block lookup. Use whichever applies for the fee.
  const feeTxHash = row.kind === "pending_tx" ? row.txHash : resolvedTxHash;
  const [resolvedFeeLythoshi, setResolvedFeeLythoshi] = useState<string | null>(null);
  useEffect(() => {
    if (!selfPaid || feeTxHash === null) return;
    let cancelled = false;
    void (async () => {
      const r = await bgWalletTxFee(feeTxHash);
      if (cancelled || !r.ok) return;
      if (r.feeLythoshi !== null) setResolvedFeeLythoshi(r.feeLythoshi);
    })();
    return () => {
      cancelled = true;
    };
  }, [selfPaid, feeTxHash]);

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
          {/* Confirmed via the receipt but awaiting the indexer's canonical
              row — show it as Confirmed at the receipt's inclusion block. */}
          <DRow
            label="Status"
            value={
              row.confirmedBlockHeight !== undefined
                ? "Confirmed"
                : row.sealed
                  ? "Pending — awaiting reveal"
                  : "Pending"
            }
          />
          <DRow
            label="Amount"
            value={
              // pendingAmountDisplay: a claim shows its decoded figure + fiat
              // sibling, or bare "Rewards claimed" until decoded — NEVER "0 LYTH"
              // (a confirmed claim is never 0; no-mock). Other rows: amountDecimal.
              (() => {
                const d = pendingAmountDisplay(row);
                if (d.kind === "claim-figure") {
                  return (
                    <>
                      {formatLythDecimalDisplay(d.lyth, 4)} LYTH{" "}
                      <span style={{ opacity: 0.75 }}>
                        (
                        {formatFiat(
                          d.lyth,
                          row.currency ?? DISPLAY_CURRENCY_DEFAULT,
                          row.rateAtClaim ?? null,
                        )}
                        )
                      </span>
                    </>
                  );
                }
                return d.kind === "claim-no-figure"
                  ? "Rewards claimed"
                  : `${d.lyth} LYTH`;
              })()
            }
          />
          <DRow label="From" value={<CopyableAddress addr0x={walletAddr} />} />
          <DRow label="To" value={<CopyableAddress addr0x={row.to} name={name} />} />
          <DRow
            label="Tx hash"
            value={
              // A sealed tx is hidden from the indexer/Monoscan until reveal —
              // hold the link (it would 404) until it's confirmed; keep the
              // truncated hash visible meanwhile.
              !row.sealed || row.confirmedBlockHeight !== undefined ? (
                <ExternalLink href={monoscanTxUrl(row.txHash)} title={row.txHash} style={{ fontFamily: "var(--f-mono)" }}>
                  {truncMiddle(row.txHash)}
                </ExternalLink>
              ) : (
                <span style={{ fontFamily: "var(--f-mono)", color: "var(--fg-400)" }} title={row.txHash}>
                  {truncMiddle(row.txHash)} · available after reveal
                </span>
              )
            }
          />
          {row.confirmedBlockHeight !== undefined ? (
            <DRow label="Block" value={row.confirmedBlockHeight.toLocaleString("en-US")} />
          ) : (
            row.broadcastBlockHeight !== null && (
              <DRow label="Block" value={row.broadcastBlockHeight.toLocaleString("en-US")} />
            )
          )}
          <DRow label="Submitted" value={relativeMs(row.broadcastedAtMs)} />
          {/* #7 — a claim self-pays its fee; the on-demand bgWalletTxFee(txHash)
              resolves once the receipt lands. null → no Fee row (no-mock). */}
          {feeText && <DRow label="Fee" value={feeText} />}
          {(!row.sealed || row.confirmedBlockHeight !== undefined) && (
            <MonoscanTxButton hash={row.txHash} />
          )}
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
          <DRow label="Cluster" value={resolveClusterLabel(row.cluster, row.clusterName, clusterNameById)} />
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
