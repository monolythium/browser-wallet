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
    expect(pending).toContain("Sending"); // present-continuous (was "Pending ·")
    expect(pending).toContain("5 LYTH");
  });
});

describe("PendingTxRowBody — pending label", () => {
  it("labels an unconfirmed send 'Sending · …'", () => {
    const html = renderToStaticMarkup(
      <PendingTxRowBody
        row={pendingRow({ opKind: "send", amountDecimal: "5" })}
        counterpartyLabel={undefined}
      />,
    );
    expect(html).toContain("Sending");
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

  it("pending (not-yet-bridged) claim reads 'Claiming rewards +6.51 LYTH'", () => {
    const html = renderToStaticMarkup(
      <PendingTxRowBody row={claim()} counterpartyLabel={undefined} />,
    );
    expect(html).toContain("Claiming rewards"); // present-continuous while pending
    expect(html).toContain("6.51 LYTH");
    expect(html).not.toContain("Rewards claimed"); // past tense is the confirmed row
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

describe("PendingTxRowBody — present-continuous pending labels (B)", () => {
  it("send: 'Sending · 1 LYTH …' (only the leading word changes)", () => {
    const html = renderToStaticMarkup(
      <PendingTxRowBody
        row={pendingRow({ opKind: "send", amountDecimal: "1" })}
        counterpartyLabel={undefined}
      />,
    );
    expect(html).toContain("Sending · 1 LYTH to");
    expect(html).not.toContain("Pending · 1 LYTH");
  });

  it("delegate: 'Delegating 12.50% to halcyon' (no '0 LYTH to <module>')", () => {
    const html = renderToStaticMarkup(
      <PendingTxRowBody
        row={pendingRow({
          opKind: "delegate",
          delegationWeightBps: 1250,
          clusterId: 1,
          clusterName: "halcyon",
        })}
        counterpartyLabel={undefined}
      />,
    );
    expect(html).toContain("Delegating 12.50% to halcyon");
    expect(html).not.toContain("0 LYTH to");
    // Full label on hover (C).
    expect(html).toContain('title="Delegating 12.50% to halcyon"');
  });

  it("undelegate: 'Undelegating 50.00% from halcyon'", () => {
    const html = renderToStaticMarkup(
      <PendingTxRowBody
        row={pendingRow({
          opKind: "undelegate",
          delegationWeightBps: 5000,
          clusterId: 1,
          clusterName: "halcyon",
        })}
        counterpartyLabel={undefined}
      />,
    );
    expect(html).toContain("Undelegating 50.00% from halcyon");
  });

  it("redelegate: 'Redelegating 12.50% from halcyon to polar'", () => {
    const html = renderToStaticMarkup(
      <PendingTxRowBody
        row={pendingRow({
          opKind: "redelegate",
          delegationWeightBps: 1250,
          clusterId: 1,
          clusterName: "halcyon",
          toClusterId: 2,
          toClusterName: "polar",
        })}
        counterpartyLabel={undefined}
      />,
    );
    expect(html).toContain("Redelegating 12.50% from halcyon to polar");
  });

  it("legacy delegate without a captured % omits the figure", () => {
    const html = renderToStaticMarkup(
      <PendingTxRowBody
        row={pendingRow({ opKind: "delegate", clusterId: 1, clusterName: "halcyon" })}
        counterpartyLabel={undefined}
      />,
    );
    expect(html).toContain("Delegating to halcyon");
    expect(html).not.toContain("%");
  });

  it("unnamed cluster falls back to 'Cluster #<id>'", () => {
    const html = renderToStaticMarkup(
      <PendingTxRowBody
        row={pendingRow({ opKind: "delegate", delegationWeightBps: 1250, clusterId: 3 })}
        counterpartyLabel={undefined}
      />,
    );
    expect(html).toContain("Delegating 12.50% to Cluster #3");
  });
});
