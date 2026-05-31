import { describe, expect, it } from "vitest";
import { txTypeLabel, txTypeLabelForOpKind } from "./tx-type-label.js";
import type { ActivityRow } from "./activity.js";

const anchor = { blockHeight: 100, txIndex: 0, logIndex: 0 };

describe("txTypeLabel", () => {
  it("names native transfers by direction", () => {
    expect(
      txTypeLabel({ kind: "tx_send", counterparty: "0x1", amountDecimal: "1", ...anchor }),
    ).toBe("Outgoing transfer");
    expect(
      txTypeLabel({ kind: "tx_receive", counterparty: "0x1", amountDecimal: "1", ...anchor }),
    ).toBe("Incoming transfer");
  });

  it("names token transfers by direction, falling back to Token transfer", () => {
    const base = { kind: "token_transfer" as const, counterparty: "0x1", tokenId: "0xtok", amountDecimal: "1", ...anchor };
    expect(txTypeLabel({ ...base, direction: "out" })).toBe("Outgoing transfer");
    expect(txTypeLabel({ ...base, direction: "in" })).toBe("Incoming transfer");
    expect(txTypeLabel({ ...base, direction: null })).toBe("Token transfer");
  });

  it("names the delegation family", () => {
    expect(txTypeLabel({ kind: "delegate", cluster: 0, weightBps: 100, ...anchor })).toBe("Stake");
    expect(txTypeLabel({ kind: "undelegate", cluster: 0, weightBps: 100, ...anchor })).toBe("Unstake");
    expect(
      txTypeLabel({ kind: "redelegate", cluster: 0, toCluster: 1, weightBps: 100, ...anchor }),
    ).toBe("Restake");
  });

  it("names rebalance + crossing rows", () => {
    expect(txTypeLabel({ kind: "rebalance", weightBps: 100, ...anchor })).toBe("Auto-rebalance");
    expect(txTypeLabel({ kind: "crossing_to_private", amountDecimal: "1", ...anchor })).toBe(
      "Private transfer",
    );
  });

  it("labels a pending row by its broadcast-time opKind", () => {
    const base = {
      kind: "pending_tx" as const,
      txHash: "0xabc",
      to: "0x1",
      amountDecimal: "1",
      broadcastedAtMs: 0,
      broadcastBlockHeight: null,
      via: "op",
    };
    expect(txTypeLabel({ ...base, opKind: "delegate" })).toBe("Stake");
    expect(txTypeLabel({ ...base, opKind: "claim" })).toBe("Claim rewards");
    // Untagged pending broadcast → honest "Outgoing transfer", never "Transaction".
    expect(txTypeLabel(base as ActivityRow)).toBe("Outgoing transfer");
  });
});

describe("txTypeLabelForOpKind", () => {
  it("maps every op kind to a friendly noun", () => {
    expect(txTypeLabelForOpKind("send")).toBe("Outgoing transfer");
    expect(txTypeLabelForOpKind("undelegate")).toBe("Unstake");
    expect(txTypeLabelForOpKind("redelegate")).toBe("Restake");
    expect(txTypeLabelForOpKind("complete-redemption")).toBe("Redemption");
    expect(txTypeLabelForOpKind("emergency-key")).toBe("Backup key");
    expect(txTypeLabelForOpKind("agent-policy")).toBe("Agent policy");
    expect(txTypeLabelForOpKind("contract_call")).toBe("Contract call");
    expect(txTypeLabelForOpKind(undefined)).toBe("Outgoing transfer");
  });
});
