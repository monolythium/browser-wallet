// Phase 3/4 — per-notification detail modal.
//
// Mirrors `ActivityDetail`'s shape: a `<Modal showClose>` with a stack
// of `DRow`s for the structured fields + a `MonoscanTxButton` CTA at
// the bottom when the record carries a `txHash`. All wording English.
//
// Honest-absence: rows for fields that have nothing to show (`amount`
// on a zero-LYTH claim, `block` on a `lyth_txStatus="found"` fast-path
// where the receipt didn't surface a parseable block) are simply
// omitted — no "—" / "N/A" placeholders.

import { Modal } from "./Modal";
import {
  CopyableAddress,
  DRow,
  MonoscanTxButton,
  relativeMs,
} from "./_detailModalParts";
import {
  notificationTitle,
  type NotificationRecord,
} from "../../shared/notifications";
import { formatNativeLythAmount } from "../../shared/native-fee-display";

export interface NotificationDetailProps {
  record: NotificationRecord;
  onClose: () => void;
}

/** True for amount strings that mean "zero LYTH" — we hide the Amount
 *  row in this case so a 0-LYTH claim / agent-policy reads cleanly.
 *  Mirrors the helpers in `notifications-os.ts` and `Notifications.tsx`. */
function isZeroAmount(amountDecimal: string): boolean {
  if (amountDecimal.length === 0) return true;
  return /^0(\.0+)?$/.test(amountDecimal);
}

function statusLabel(status: "confirmed" | "failed"): string {
  return status === "confirmed" ? "Confirmed" : "Failed";
}

export function NotificationDetail({ record, onClose }: NotificationDetailProps) {
  const title = notificationTitle(record.kind, record.status);
  const showAmount = !isZeroAmount(record.amountDecimal);
  const showBlock = record.blockNumber !== null;
  // Fee is captured (lythoshi) only for confirmed self-paid txs with a non-zero
  // fee, so presence ⇒ show it as a debit. Absent ⇒ no fee line (no-mock).
  const feeText =
    record.feeLythoshi !== undefined &&
    /^[0-9]+$/.test(record.feeLythoshi) &&
    BigInt(record.feeLythoshi) > 0n
      ? `- ${formatNativeLythAmount(BigInt(record.feeLythoshi))}`
      : null;
  // Cluster a delegation tx targeted — the tx `to` is the delegation module,
  // so name the cluster explicitly. Real *.cluster.mono name when known, else
  // the numeric id (there is no monok1 cluster address). Absent ⇒ no row.
  const clusterText =
    record.clusterId !== undefined
      ? record.clusterName
        ? `${record.clusterName} · #${record.clusterId}`
        : `#${record.clusterId}`
      : null;

  return (
    <Modal open onClose={onClose} title={title} showClose>
      <div>
        <DRow label="Status" value={statusLabel(record.status)} />
        {showAmount && (
          <DRow label="Amount" value={`${record.amountDecimal} LYTH`} />
        )}
        {feeText && <DRow label="Fee" value={feeText} />}
        <DRow label="To" value={<CopyableAddress addr0x={record.counterparty} />} />
        {clusterText && <DRow label="Cluster" value={clusterText} />}
        {showBlock && (
          <DRow
            label="Block"
            value={`#${record.blockNumber!.toLocaleString("en-US")}`}
          />
        )}
        <DRow label="Date" value={relativeMs(record.createdAtMs)} />
        {record.txHash && <MonoscanTxButton hash={record.txHash} />}
      </div>
    </Modal>
  );
}
