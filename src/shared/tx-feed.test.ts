import { describe, expect, it } from "vitest";

import { mapTxFeedToRows, txFeedFallbackEnabled, type RawTxFeedTx } from "./tx-feed.js";

const ME = "0x" + "11".repeat(20);
const OTHER = "0x" + "22".repeat(20);
const THIRD = "0x" + "33".repeat(20);

function feedTx(partial: Partial<RawTxFeedTx>): RawTxFeedTx {
  return {
    blockNumber: 100,
    txIndex: 0,
    from: OTHER,
    to: ME,
    value: "1000000000000000000", // 1 LYTH in lythoshi
    input: "0x",
    ...partial,
  };
}

describe("mapTxFeedToRows — indexer-off fallback (#B3-2)", () => {
  it("maps an incoming native transfer to a tx_receive row", () => {
    const rows = mapTxFeedToRows([feedTx({ from: OTHER, to: ME })], ME);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.kind).toBe("tx_receive");
    if (r.kind === "tx_receive") {
      expect(r.counterparty).toBe(OTHER);
      expect(r.amountDecimal).toBe("1");
      expect(r.blockHeight).toBe(100);
    }
  });

  it("maps an outgoing native transfer to a tx_send row", () => {
    const rows = mapTxFeedToRows([feedTx({ from: ME, to: OTHER })], ME);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.kind).toBe("tx_send");
    if (r.kind === "tx_send") {
      expect(r.counterparty).toBe(OTHER);
      expect(r.amountDecimal).toBe("1");
    }
  });

  it("drops txs that don't involve the queried address", () => {
    const rows = mapTxFeedToRows([feedTx({ from: OTHER, to: THIRD })], ME);
    expect(rows).toHaveLength(0);
  });

  it("skips contract calls (non-empty input) — never mislabels a decode it can't do", () => {
    const rows = mapTxFeedToRows(
      [feedTx({ from: ME, to: OTHER, input: "0x86593454" })],
      ME,
    );
    expect(rows).toHaveLength(0);
  });

  it("skips zero-value txs", () => {
    const rows = mapTxFeedToRows([feedTx({ from: ME, to: OTHER, value: "0" })], ME);
    expect(rows).toHaveLength(0);
  });

  it("resolves a self-send to a single tx_send leg", () => {
    const rows = mapTxFeedToRows([feedTx({ from: ME, to: ME })], ME);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("tx_send");
  });

  it("matches case-insensitively", () => {
    const rows = mapTxFeedToRows(
      [feedTx({ from: OTHER.toUpperCase(), to: ME.toUpperCase() })],
      ME,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("tx_receive");
  });

  it("returns an empty list for an empty feed (honest empty, no fabrication)", () => {
    expect(mapTxFeedToRows([], ME)).toEqual([]);
  });
});

describe("txFeedFallbackEnabled — trigger discipline (#B3-2)", () => {
  const base = {
    hideConfirmed: false,
    confirmedCount: 0,
    failedCount: 0,
    hasIndexerError: false,
    kind: "indexer_disabled" as const,
  };

  it("fires on indexer_disabled with an empty timeline", () => {
    expect(txFeedFallbackEnabled(base)).toBe(true);
  });

  it("fires on not_found (genuinely-empty envelope)", () => {
    expect(txFeedFallbackEnabled({ ...base, kind: "not_found" })).toBe(true);
  });

  it("does NOT fire on a transient/operator error (Phase 1 empty-vs-error)", () => {
    expect(txFeedFallbackEnabled({ ...base, hasIndexerError: true })).toBe(false);
  });

  it("does NOT fire when there are confirmed rows to show", () => {
    expect(txFeedFallbackEnabled({ ...base, confirmedCount: 3 })).toBe(false);
  });

  it("does NOT fire when there are failed rows to show", () => {
    expect(txFeedFallbackEnabled({ ...base, failedCount: 1 })).toBe(false);
  });

  it("does NOT fire while the chain is non-live (hideConfirmed)", () => {
    expect(txFeedFallbackEnabled({ ...base, hideConfirmed: true })).toBe(false);
  });

  it("does NOT fire for pruned / private / unknown (they keep their own empty state)", () => {
    expect(txFeedFallbackEnabled({ ...base, kind: "pruned" })).toBe(false);
    expect(txFeedFallbackEnabled({ ...base, kind: "private" })).toBe(false);
    expect(txFeedFallbackEnabled({ ...base, kind: "unknown" })).toBe(false);
  });

  it("does NOT fire while the kind probe is still in flight (null)", () => {
    expect(txFeedFallbackEnabled({ ...base, kind: null })).toBe(false);
  });
});
