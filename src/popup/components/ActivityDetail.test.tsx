// Unit coverage for ActivityDetail's fee-eligibility gate (#7). The component's
// async fee fetch (useEffect → bgWalletTxFee → feeText → Fee DRow) can't run
// under renderToStaticMarkup (effects don't fire, no DOM), so this pins the
// load-bearing decision: a reward claim is self-paid → its fee resolves and the
// Fee row renders (the render line mirrors the 3 proven confirmed-row Fee lines).

import { describe, expect, it } from "vitest";

import { isSelfPaid } from "./ActivityDetail.js";
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
