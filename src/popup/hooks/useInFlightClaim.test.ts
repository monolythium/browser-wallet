// Unit coverage for the in-flight-claim predicate (#2). The hook's effect/
// onChanged plumbing mirrors the proven App.tsx hasPendingTx idiom; this pins
// the load-bearing decision: a claim is "in flight" only while it's a
// source:"local-claim" row WITHOUT confirmedBlockHeight.

import { describe, expect, it } from "vitest";

import { hasInFlightClaim } from "./useInFlightClaim.js";
import type { PendingTxRow } from "../../shared/activity.js";

function row(over: Partial<PendingTxRow> = {}): PendingTxRow {
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

describe("hasInFlightClaim — #2 double-submit signal", () => {
  it("true for a local-claim row with no confirmedBlockHeight (in flight)", () => {
    expect(hasInFlightClaim([row({ opKind: "claim", source: "local-claim" })])).toBe(true);
  });

  it("false once the claim is receipt-bridged (confirmedBlockHeight set)", () => {
    expect(
      hasInFlightClaim([
        row({ opKind: "claim", source: "local-claim", confirmedBlockHeight: 500 }),
      ]),
    ).toBe(false);
  });

  it("false for a non-claim pending row", () => {
    expect(hasInFlightClaim([row({ opKind: "send" })])).toBe(false);
  });

  it("false for an empty list", () => {
    expect(hasInFlightClaim([])).toBe(false);
  });

  it("true when an in-flight claim sits among other rows", () => {
    expect(
      hasInFlightClaim([
        row({ txHash: "0xsend", opKind: "send" }),
        row({ txHash: "0xclaim", opKind: "claim", source: "local-claim" }),
      ]),
    ).toBe(true);
  });
});
