// Unit coverage for ActivityDetail's fee-eligibility gate (#7). The component's
// async fee fetch (useEffect → bgWalletTxFee → feeText → Fee DRow) can't run
// under renderToStaticMarkup (effects don't fire, no DOM), so this pins the
// load-bearing decision: a reward claim is self-paid → its fee resolves and the
// Fee row renders (the render line mirrors the 3 proven confirmed-row Fee lines).

import { describe, expect, it } from "vitest";

import { isSelfPaid, pendingAmountDisplay, rowDescription } from "./ActivityDetail.js";
import type { ActivityRow, PendingTxRow } from "../../shared/activity.js";

function pending(over: Partial<PendingTxRow> = {}): PendingTxRow {
  return {
    kind: "pending_tx",
    txHash: "0x" + "c".repeat(64),
    to: "0x" + "2".repeat(40),
    amountDecimal: "0",
    broadcastedAtMs: 1_000,
    broadcastBlockHeight: 100,
    via: "op",
    ...over,
  };
}

describe("ActivityDetail.isSelfPaid — #7 claim fee eligibility", () => {
  it("a reward claim (source:local-claim) is self-paid → fee fetch runs", () => {
    expect(isSelfPaid(pending({ opKind: "claim", source: "local-claim" }))).toBe(true);
  });

  it("an ordinary pending row is NOT self-paid here (resolves its fee via the confirmed counterpart)", () => {
    expect(isSelfPaid(pending({ opKind: "send" }))).toBe(false);
  });

  it("confirmed self-paid kinds still gate true (regression)", () => {
    const send: ActivityRow = {
      kind: "tx_send", blockHeight: 1, txIndex: 0, logIndex: 0,
      counterparty: null, amountDecimal: "1",
    };
    const recv: ActivityRow = {
      kind: "tx_receive", blockHeight: 1, txIndex: 0, logIndex: 0,
      counterparty: null, amountDecimal: "1",
    };
    expect(isSelfPaid(send)).toBe(true);
    expect(isSelfPaid(recv)).toBe(false); // inbound — not self-paid
  });
});

// The Amount row's decision is extracted (the modal portals, so it can't be
// render-tested). A confirmed claim must NEVER show "0 LYTH" — the fallback to
// amountDecimal is gated behind non-claim rows.
describe("ActivityDetail.pendingAmountDisplay — claim never renders 0 LYTH", () => {
  const claim = (over: Partial<PendingTxRow> = {}) =>
    pending({ opKind: "claim", source: "local-claim", amountDecimal: "0", ...over });

  it("a claim with a decoded figure shows it", () => {
    expect(pendingAmountDisplay(claim({ claimedAmount: "1.5" }))).toEqual({
      kind: "claim-figure",
      lyth: "1.5",
    });
  });

  it("a claim with claimedAmount '0' → bare 'Rewards claimed', NOT a 0 figure", () => {
    expect(pendingAmountDisplay(claim({ claimedAmount: "0" }))).toEqual({
      kind: "claim-no-figure",
    });
  });

  it("a claim with null / absent / empty claimedAmount → 'Rewards claimed' (no figure)", () => {
    expect(pendingAmountDisplay(claim({ claimedAmount: null }))).toEqual({ kind: "claim-no-figure" });
    expect(pendingAmountDisplay(claim())).toEqual({ kind: "claim-no-figure" });
    expect(pendingAmountDisplay(claim({ claimedAmount: "" }))).toEqual({ kind: "claim-no-figure" });
  });

  it("a non-claim pending row keeps its amountDecimal (the fallback stays for non-claims)", () => {
    expect(pendingAmountDisplay(pending({ opKind: "send", amountDecimal: "2.5" }))).toEqual({
      kind: "plain",
      lyth: "2.5",
    });
  });
});

// rowDescription is the secondary line under the detail title (the modal portals,
// so the string is the testable unit). It echoes the activity row's label.
describe("ActivityDetail.rowDescription (D)", () => {
  const dir = new Map<number, string | null>([
    [1, "halcyon"],
    [2, "polar"],
  ]);

  it("confirmed redelegate → 'Redelegated <pct> from <src> to <dst>'", () => {
    const row: ActivityRow = {
      kind: "redelegate", blockHeight: 1, txIndex: 0, logIndex: 0,
      cluster: 1, toCluster: 2, weightBps: 1250, clusterName: "halcyon",
    };
    expect(rowDescription(row, undefined, dir)).toBe(
      "Redelegated 12.50% from halcyon to polar",
    );
  });

  it("confirmed delegate / undelegate", () => {
    const del: ActivityRow = {
      kind: "delegate", blockHeight: 1, txIndex: 0, logIndex: 0,
      cluster: 1, weightBps: 5000, clusterName: "halcyon",
    };
    const undel: ActivityRow = {
      kind: "undelegate", blockHeight: 1, txIndex: 0, logIndex: 0,
      cluster: 1, weightBps: 5000, clusterName: "halcyon",
    };
    expect(rowDescription(del, undefined, dir)).toBe("Delegated to halcyon");
    expect(rowDescription(undel, undefined, dir)).toBe("Undelegated from halcyon");
  });

  it("confirmed claim with a figure", () => {
    const row: ActivityRow = {
      kind: "claim", blockHeight: 1, txIndex: 0, logIndex: 0, amountDecimal: "1.5",
    };
    expect(rowDescription(row, undefined, undefined)).toBe("Rewards claimed +1.5 LYTH");
  });

  it("confirmed tx_send → plain-text 'Sent N LYTH to <cp>'", () => {
    const row: ActivityRow = {
      kind: "tx_send", blockHeight: 1, txIndex: 0, logIndex: 0,
      counterparty: "0x" + "22".repeat(20), amountDecimal: "5",
    };
    expect(rowDescription(row, undefined, undefined)).toMatch(/^Sent 5 LYTH to mono1/);
  });

  it("pending delegate / claim use the present-continuous builder", () => {
    expect(
      rowDescription(
        pending({ opKind: "delegate", delegationWeightBps: 1250, clusterId: 1, clusterName: "halcyon" }),
        undefined,
        dir,
      ),
    ).toBe("Delegating 12.50% to halcyon");
    expect(
      rowDescription(pending({ opKind: "claim", source: "local-claim" }), undefined, undefined),
    ).toBe("Claiming rewards");
  });
});
