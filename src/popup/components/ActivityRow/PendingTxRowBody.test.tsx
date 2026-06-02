import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { PendingTxRow } from "../../../shared/activity.js";
import { PendingTxRowBody } from "./PendingTxRowBody.js";

function pendingRow(partial: Partial<PendingTxRow>): PendingTxRow {
  return {
    kind: "pending_tx",
    txHash: "0x" + "ab".repeat(32),
    to: "0x" + "11".repeat(20),
    amountDecimal: "0",
    broadcastedAtMs: 1_700_000_000_000,
    broadcastBlockHeight: 100,
    via: "operator-1",
    ...partial,
  };
}

// complete-redemption + emergency-key are 0-value OUTGOING precompile calls.
// The row must NOT render a "0 LYTH" amount (per the UI/UX batch's 6b finding:
// a receive-styled "Redemption completed · 0 LYTH" reads as "0 received"; the
// real returned principal arrives as a SEPARATE tx_receive once the chain
// exposes it). Label + icon are kept; only the amount field is suppressed.
describe("PendingTxRowBody — suppress meaningless 0-value amount", () => {
  it("complete-redemption: confirmed row keeps the label, drops the amount", () => {
    const html = renderToStaticMarkup(
      <PendingTxRowBody
        row={pendingRow({
          opKind: "complete-redemption",
          confirmedBlockHeight: 200,
          amountDecimal: "0",
        })}
        counterpartyLabel={undefined}
      />,
    );
    expect(html).toContain("Redemption completed");
    expect(html).not.toContain("LYTH"); // no "0 LYTH" anywhere
    expect(html).not.toContain("Sent");
  });

  it("complete-redemption: pending row reads 'Pending · Redemption', no amount", () => {
    const html = renderToStaticMarkup(
      <PendingTxRowBody
        row={pendingRow({ opKind: "complete-redemption", amountDecimal: "0" })}
        counterpartyLabel={undefined}
      />,
    );
    expect(html).toContain("Pending");
    expect(html).toContain("Redemption");
    expect(html).not.toContain("LYTH");
  });

  it("emergency-key: confirmed row keeps the label, drops the amount", () => {
    const html = renderToStaticMarkup(
      <PendingTxRowBody
        row={pendingRow({
          opKind: "emergency-key",
          confirmedBlockHeight: 200,
          amountDecimal: "0",
        })}
        counterpartyLabel={undefined}
      />,
    );
    expect(html).toContain("Backup key registered");
    expect(html).not.toContain("LYTH");
  });

  it("emergency-key: pending row reads 'Pending · Backup key', no amount", () => {
    const html = renderToStaticMarkup(
      <PendingTxRowBody
        row={pendingRow({ opKind: "emergency-key", amountDecimal: "0" })}
        counterpartyLabel={undefined}
      />,
    );
    expect(html).toContain("Pending");
    expect(html).toContain("Backup key");
    expect(html).not.toContain("LYTH");
  });

  it("ordinary sends still render their amount (regression guard)", () => {
    const confirmed = renderToStaticMarkup(
      <PendingTxRowBody
        row={pendingRow({
          opKind: "send",
          confirmedBlockHeight: 200,
          amountDecimal: "5",
        })}
        counterpartyLabel={undefined}
      />,
    );
    expect(confirmed).toContain("5 LYTH");
    expect(confirmed).toContain("Sent");

    const pending = renderToStaticMarkup(
      <PendingTxRowBody
        row={pendingRow({ opKind: "send", amountDecimal: "5" })}
        counterpartyLabel={undefined}
      />,
    );
    expect(pending).toContain("Pending");
    expect(pending).toContain("5 LYTH");
  });
});
