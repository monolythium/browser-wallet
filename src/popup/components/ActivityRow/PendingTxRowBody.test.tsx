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

describe("PendingTxRowBody — sealed 'awaiting reveal' label", () => {
  it("labels a sealed, unrevealed pending row 'awaiting reveal'", () => {
    const html = renderToStaticMarkup(
      <PendingTxRowBody
        row={pendingRow({ sealed: true, opKind: "send", amountDecimal: "5" })}
        counterpartyLabel={undefined}
      />,
    );
    expect(html).toContain("awaiting reveal");
  });

  it("a plaintext pending row stays a plain 'Pending' (no 'awaiting reveal')", () => {
    const html = renderToStaticMarkup(
      <PendingTxRowBody
        row={pendingRow({ sealed: false, opKind: "send", amountDecimal: "5" })}
        counterpartyLabel={undefined}
      />,
    );
    expect(html).toContain("Pending");
    expect(html).not.toContain("awaiting reveal");
  });
});

// A reward claim's value is 0x0, so its standard amountDecimal is "0" and is
// suppressed by the regex above; the claimed reward rides on the distinct
// claimedAmount field (C3). The fiat sibling uses the frozen rate (null today →
// honest dash, never $0 — no-mock).
describe("PendingTxRowBody — reward claim claimedAmount + fiat sibling (C3)", () => {
  function claim(partial: Partial<PendingTxRow> = {}): PendingTxRow {
    return pendingRow({
      opKind: "claim",
      source: "local-claim",
      amountDecimal: "0",
      claimedAmount: "6.51",
      rateAtClaim: null,
      currency: "USD",
      ...partial,
    });
  }

  it("confirmed claim shows claimedAmount (not the suppressed 0) + $— sibling", () => {
    const html = renderToStaticMarkup(
      <PendingTxRowBody row={claim({ confirmedBlockHeight: 200 })} counterpartyLabel={undefined} />,
    );
    expect(html).toContain("Rewards claimed");
    expect(html).toContain("6.51 LYTH");
    expect(html).toContain("$—"); // "$—" — honest dash, never $0
    expect(html).not.toContain("$0");
  });

  it("pending (not-yet-bridged) claim reads 'Pending · Rewards claimed 6.51 LYTH'", () => {
    const html = renderToStaticMarkup(
      <PendingTxRowBody row={claim()} counterpartyLabel={undefined} />,
    );
    expect(html).toContain("Pending");
    expect(html).toContain("Rewards claimed");
    expect(html).toContain("6.51 LYTH");
    expect(html).not.toContain("0 LYTH"); // never the suppressed "0 LYTH to <precompile>"
  });

  it("truncates the claimed amount to 4dp + renders green incoming (+, amt in, dir in)", () => {
    const html = renderToStaticMarkup(
      <PendingTxRowBody
        row={claim({ confirmedBlockHeight: 200, claimedAmount: "0.980035894719687092" })}
        counterpartyLabel={undefined}
      />,
    );
    expect(html).toContain("+0.98 LYTH"); // truncated 4dp + incoming "+" sign
    expect(html).not.toContain("0.980035894719687092"); // no full-precision leak
    expect(html).toContain('class="amt in">+0.98'); // green incoming amount cell
    expect(html).toContain('class="dir in"'); // green receive direction circle
  });

  it("no-mock: a claim with null claimedAmount shows the bare title, no figure", () => {
    const html = renderToStaticMarkup(
      <PendingTxRowBody
        row={claim({ confirmedBlockHeight: 200, claimedAmount: null })}
        counterpartyLabel={undefined}
      />,
    );
    expect(html).toContain("Rewards claimed");
    expect(html).not.toContain("LYTH"); // no figure → no fiat, no amount
  });

  it("no-mock: a confirmed claim with claimedAmount '0' shows the bare title, never '0 LYTH'", () => {
    const html = renderToStaticMarkup(
      <PendingTxRowBody
        row={claim({ confirmedBlockHeight: 200, claimedAmount: "0" })}
        counterpartyLabel={undefined}
      />,
    );
    expect(html).toContain("Rewards claimed");
    expect(html).not.toContain("0 LYTH");
    expect(html).not.toContain("LYTH"); // "0" normalized to no-figure
  });
});
