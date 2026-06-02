// Unit coverage for the activity-cache shared helpers. The SW-level
// IPC tests in service-worker.activity.test.ts (commit 9) cover the
// integrated path; these pin the pure logic so refactors of the
// validators, mappers, dedupe, or eviction show up here without dragging
// in the SW boot harness.

import { describe, expect, it } from "vitest";
import {
  ACTIVITY_ROLLING_WINDOW,
  PENDING_TTL_MS,
  PENDING_MATCH_BLOCK_WINDOW,
  activityCacheKey,
  activityPendingKey,
  validateActivityRow,
  validateActivityCache,
  validatePendingActivityCache,
  mapDelegationHistoryToRows,
  mapAddressActivityToRows,
  delegationKeySet,
  mergeIndexerSnapshot,
  applyCapturedClusterNames,
  mergeActivityNewestFirst,
  evictExpiredPending,
  reconcilePending,
  NATIVE_LYTH_TOKEN_ID,
  isNativeLythTokenId,
  type PendingTxRow,
  type ConfirmedRow,
  type DelegateRow,
  type RedelegateRow,
  type TxSendRow,
  type RawAddressActivity,
  type RawDelegationHistory,
} from "./activity.js";

// ─────────────────────────────────────────────────────────────────────────────
// Storage key builders
// ─────────────────────────────────────────────────────────────────────────────

describe("activityCacheKey / activityPendingKey", () => {
  it("formats per-address per-chain keys", () => {
    expect(activityCacheKey("0xabc", "0x10f2c")).toBe(
      "mono.activity.0xabc.0x10f2c",
    );
    expect(activityPendingKey("0xabc", "0x10f2c")).toBe(
      "mono.activity.pending.0xabc.0x10f2c",
    );
  });

  it("keeps the cache and pending key namespaces distinct", () => {
    const cache = activityCacheKey("0xabc", "0x10f2c");
    const pending = activityPendingKey("0xabc", "0x10f2c");
    expect(cache).not.toBe(pending);
    expect(pending.startsWith("mono.activity.pending.")).toBe(true);
    // Cache key must NOT collide with the pending namespace prefix.
    expect(cache.startsWith("mono.activity.pending.")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateActivityRow — discriminated-union structural validation
// ─────────────────────────────────────────────────────────────────────────────

describe("validateActivityRow", () => {
  it("accepts a well-formed pending_tx row", () => {
    const row = {
      kind: "pending_tx",
      txHash: "0xdeadbeef",
      to: "0xabc",
      amountDecimal: "0.01",
      broadcastedAtMs: 1_700_000_000_000,
      broadcastBlockHeight: 12345,
      via: "halcyon",
    };
    expect(validateActivityRow(row)).toEqual(row);
  });

  it("accepts pending_tx with null broadcastBlockHeight (eth_blockNumber fallback)", () => {
    const row = {
      kind: "pending_tx",
      txHash: "0xdeadbeef",
      to: "0xabc",
      amountDecimal: "0.01",
      broadcastedAtMs: 1_700_000_000_000,
      broadcastBlockHeight: null,
      via: "halcyon",
    };
    expect(validateActivityRow(row)).toEqual(row);
  });

  it("rejects pending_tx with missing required fields", () => {
    expect(validateActivityRow({ kind: "pending_tx" })).toBeNull();
    expect(
      validateActivityRow({
        kind: "pending_tx",
        txHash: "",
        to: "0xabc",
        amountDecimal: "0.01",
        broadcastedAtMs: 1,
        broadcastBlockHeight: null,
        via: "x",
      }),
    ).toBeNull();
  });

  it("accepts tx_send and tx_receive with the confirmed anchor", () => {
    const send = {
      kind: "tx_send",
      blockHeight: 100,
      txIndex: 2,
      logIndex: 0,
      counterparty: "0xabc",
      amountDecimal: "1.5",
    };
    const receive = { ...send, kind: "tx_receive" };
    expect(validateActivityRow(send)).toEqual(send);
    expect(validateActivityRow(receive)).toEqual(receive);
  });

  it("accepts tx_send with null counterparty + null amount", () => {
    const row = {
      kind: "tx_send",
      blockHeight: 100,
      txIndex: 2,
      logIndex: 0,
      counterparty: null,
      amountDecimal: null,
    };
    expect(validateActivityRow(row)).toEqual(row);
  });

  it("rejects tx_send with non-finite blockHeight", () => {
    expect(
      validateActivityRow({
        kind: "tx_send",
        blockHeight: Number.NaN,
        txIndex: 0,
        logIndex: 0,
        counterparty: null,
        amountDecimal: null,
      }),
    ).toBeNull();
  });

  it("accepts a token_transfer with valid direction + tokenId", () => {
    const row = {
      kind: "token_transfer",
      blockHeight: 100,
      txIndex: 0,
      logIndex: 0,
      direction: "in",
      counterparty: "0xabc",
      tokenId: "0x" + "11".repeat(32),
      amountDecimal: "5",
    };
    expect(validateActivityRow(row)).toEqual(row);
  });

  it("rejects token_transfer with invalid direction", () => {
    expect(
      validateActivityRow({
        kind: "token_transfer",
        blockHeight: 100,
        txIndex: 0,
        logIndex: 0,
        direction: "sideways",
        counterparty: null,
        tokenId: "0x11",
        amountDecimal: null,
      }),
    ).toBeNull();
  });

  it("accepts delegate / undelegate rows with required fields", () => {
    const del = {
      kind: "delegate",
      blockHeight: 100,
      txIndex: 0,
      logIndex: 0,
      cluster: 7,
      weightBps: 1234,
    };
    const undel = { ...del, kind: "undelegate" };
    expect(validateActivityRow(del)).toEqual(del);
    expect(validateActivityRow(undel)).toEqual(undel);
  });

  it("round-trips an optional clusterName on delegate / undelegate / redelegate rows", () => {
    const del = {
      kind: "delegate",
      blockHeight: 100,
      txIndex: 0,
      logIndex: 0,
      cluster: 0,
      weightBps: 1234,
      clusterName: "halcyon.cluster.mono",
    };
    expect(validateActivityRow(del)).toEqual(del);
    const redel = {
      kind: "redelegate",
      blockHeight: 100,
      txIndex: 0,
      logIndex: 0,
      cluster: 3,
      toCluster: 9,
      weightBps: 500,
      clusterName: "salt.cluster.mono",
    };
    expect(validateActivityRow(redel)).toEqual(redel);
  });

  it("drops a malformed/empty clusterName rather than rejecting the delegation row", () => {
    const bad = {
      kind: "delegate",
      blockHeight: 100,
      txIndex: 0,
      logIndex: 0,
      cluster: 0,
      weightBps: 1234,
      clusterName: "",
    };
    const got = validateActivityRow(bad);
    expect(got).not.toBeNull();
    expect("clusterName" in (got as object)).toBe(false);
    const badType = { ...bad, clusterName: 42 as unknown as string };
    const got2 = validateActivityRow(badType);
    expect(got2).not.toBeNull();
    expect("clusterName" in (got2 as object)).toBe(false);
  });

  it("accepts delegate with null weightBps (activity-stream fallback)", () => {
    const del = {
      kind: "delegate",
      blockHeight: 100,
      txIndex: 0,
      logIndex: 0,
      cluster: 7,
      weightBps: null,
    };
    expect(validateActivityRow(del)).toEqual(del);
  });

  it("accepts redelegate with null toCluster (activity-stream fallback)", () => {
    const r = {
      kind: "redelegate",
      blockHeight: 100,
      txIndex: 0,
      logIndex: 0,
      cluster: 3,
      toCluster: null,
      weightBps: 500,
    };
    expect(validateActivityRow(r)).toEqual(r);
  });

  it("accepts a crossing_to_private row even though Sprintnet doesn't emit it", () => {
    const row = {
      kind: "crossing_to_private",
      blockHeight: 100,
      txIndex: 0,
      logIndex: 0,
      amountDecimal: "1.0",
    };
    expect(validateActivityRow(row)).toEqual(row);
  });

  it("rejects unknown kinds", () => {
    expect(
      validateActivityRow({ kind: "alien_event", blockHeight: 1 }),
    ).toBeNull();
  });

  it("rejects non-object inputs", () => {
    expect(validateActivityRow(null)).toBeNull();
    expect(validateActivityRow(undefined)).toBeNull();
    expect(validateActivityRow("string")).toBeNull();
    expect(validateActivityRow(42)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateActivityCache / validatePendingActivityCache
// ─────────────────────────────────────────────────────────────────────────────

describe("validateActivityCache", () => {
  it("accepts an empty cache", () => {
    const r = validateActivityCache({ confirmed: [], lastFetchedAtMs: 1 });
    expect(r).toEqual({ confirmed: [], lastFetchedAtMs: 1 });
  });

  it("rejects a cache without lastFetchedAtMs", () => {
    expect(validateActivityCache({ confirmed: [] })).toBeNull();
  });

  it("rejects a cache without a confirmed array", () => {
    expect(validateActivityCache({ lastFetchedAtMs: 1 })).toBeNull();
  });

  it("drops malformed rows but keeps valid ones (partial-data preferred)", () => {
    const cache = {
      confirmed: [
        {
          kind: "tx_send",
          blockHeight: 100,
          txIndex: 0,
          logIndex: 0,
          counterparty: "0xabc",
          amountDecimal: "1",
        },
        { kind: "garbage" },
        {
          kind: "tx_receive",
          blockHeight: 99,
          txIndex: 0,
          logIndex: 0,
          counterparty: "0xdef",
          amountDecimal: "2",
        },
      ],
      lastFetchedAtMs: 1,
    };
    const r = validateActivityCache(cache);
    expect(r).not.toBeNull();
    expect(r!.confirmed).toHaveLength(2);
    expect(r!.confirmed[0]?.kind).toBe("tx_send");
    expect(r!.confirmed[1]?.kind).toBe("tx_receive");
  });

  it("rejects a pending_tx row found in the confirmed list", () => {
    // pending_tx belongs in the separate pending cache; if it leaks into
    // the confirmed list it's a sign of storage corruption — drop it.
    const r = validateActivityCache({
      confirmed: [
        {
          kind: "pending_tx",
          txHash: "0x1",
          to: "0xabc",
          amountDecimal: "1",
          broadcastedAtMs: 0,
          broadcastBlockHeight: null,
          via: "x",
        },
      ],
      lastFetchedAtMs: 1,
    });
    expect(r).not.toBeNull();
    expect(r!.confirmed).toHaveLength(0);
  });
});

describe("validatePendingActivityCache", () => {
  it("accepts an empty pending list", () => {
    expect(validatePendingActivityCache({ pending: [] })).toEqual({
      pending: [],
    });
  });

  it("drops non-pending_tx rows from the pending list", () => {
    const r = validatePendingActivityCache({
      pending: [
        {
          kind: "pending_tx",
          txHash: "0x1",
          to: "0xabc",
          amountDecimal: "1",
          broadcastedAtMs: 0,
          broadcastBlockHeight: 5,
          via: "x",
        },
        {
          kind: "tx_send",
          blockHeight: 100,
          txIndex: 0,
          logIndex: 0,
          counterparty: "0xabc",
          amountDecimal: "1",
        },
      ],
    });
    expect(r).not.toBeNull();
    expect(r!.pending).toHaveLength(1);
    expect(r!.pending[0]?.kind).toBe("pending_tx");
  });

  it("rejects a non-object input", () => {
    expect(validatePendingActivityCache(null)).toBeNull();
    expect(validatePendingActivityCache("string")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mapDelegationHistoryToRows — canonical delegation source
// ─────────────────────────────────────────────────────────────────────────────

describe("mapDelegationHistoryToRows", () => {
  const makeDel = (overrides: Partial<RawDelegationHistory> = {}): RawDelegationHistory => ({
    blockHeight: 100,
    txIndex: 0,
    logIndex: 0,
    wallet: "0xabc",
    cluster: 7,
    toCluster: null,
    kind: "delegated",
    weightBps: 1000,
    walletTotalBps: null,
    ...overrides,
  });

  it("maps delegated → DelegateRow", () => {
    const rows = mapDelegationHistoryToRows([makeDel({ kind: "delegated" })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("delegate");
    expect((rows[0] as DelegateRow).cluster).toBe(7);
    expect((rows[0] as DelegateRow).weightBps).toBe(1000);
  });

  it("maps undelegated → UndelegateRow", () => {
    const rows = mapDelegationHistoryToRows([makeDel({ kind: "undelegated" })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("undelegate");
  });

  it("maps redelegated → RedelegateRow with toCluster preserved", () => {
    const rows = mapDelegationHistoryToRows([
      makeDel({ kind: "redelegated", cluster: 3, toCluster: 9 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("redelegate");
    expect((rows[0] as RedelegateRow).cluster).toBe(3);
    expect((rows[0] as RedelegateRow).toCluster).toBe(9);
  });

  it("drops unknown kinds (forward-compat)", () => {
    const rows = mapDelegationHistoryToRows([makeDel({ kind: "rebalanced" })]);
    expect(rows).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// applyCapturedClusterNames — thread the send-time cluster name onto the
// confirmed indexer row (the indexer carries only the numeric id, §C).
// ─────────────────────────────────────────────────────────────────────────────

describe("applyCapturedClusterNames", () => {
  const delRow = (over: Partial<DelegateRow> = {}): DelegateRow => ({
    kind: "delegate",
    blockHeight: 100,
    txIndex: 2,
    logIndex: 0,
    cluster: 0,
    weightBps: 5000,
    ...over,
  });
  const pendingNamed = (over: Partial<PendingTxRow> = {}): PendingTxRow => ({
    kind: "pending_tx",
    txHash: "0xdead",
    to: "0x100a",
    amountDecimal: "1",
    broadcastedAtMs: 1,
    broadcastBlockHeight: 100,
    via: "operator-1",
    confirmedBlockHeight: 100,
    confirmedTxIndex: 2,
    clusterName: "halcyon.cluster.mono",
    clusterId: 0,
    ...over,
  });

  it("threads the captured name from a bridged pending row onto the confirmed delegate row (cluster 0)", () => {
    const out = applyCapturedClusterNames([delRow({ cluster: 0 })], {
      pending: [pendingNamed()],
    });
    expect((out[0] as DelegateRow).clusterName).toBe("halcyon.cluster.mono");
    expect((out[0] as DelegateRow).cluster).toBe(0);
  });

  it("keeps the name sticky from prevConfirmed after the pending row is gone", () => {
    const prev = [delRow({ clusterName: "salt.cluster.mono" })];
    const out = applyCapturedClusterNames([delRow()], { confirmed: prev });
    expect((out[0] as DelegateRow).clusterName).toBe("salt.cluster.mono");
  });

  it("prefers the already-named prevConfirmed copy over a pending capture", () => {
    const out = applyCapturedClusterNames([delRow()], {
      confirmed: [delRow({ clusterName: "polar.cluster.mono" })],
      pending: [pendingNamed({ clusterName: "halcyon.cluster.mono" })],
    });
    expect((out[0] as DelegateRow).clusterName).toBe("polar.cluster.mono");
  });

  it("leaves a row WITHOUT a matching source unnamed (honest #id fallback at render)", () => {
    const out = applyCapturedClusterNames([delRow({ cluster: 0 })], {
      pending: [pendingNamed({ confirmedTxIndex: 99 })], // slot mismatch
    });
    expect((out[0] as DelegateRow).clusterName).toBeUndefined();
  });

  it("never overwrites an existing clusterName", () => {
    const out = applyCapturedClusterNames([delRow({ clusterName: "real.cluster.mono" })], {
      pending: [pendingNamed({ clusterName: "other.cluster.mono" })],
    });
    expect((out[0] as DelegateRow).clusterName).toBe("real.cluster.mono");
  });

  it("matches by exact (blockHeight, txIndex) slot, not by cluster id", () => {
    const out = applyCapturedClusterNames([delRow({ blockHeight: 200 })], {
      pending: [pendingNamed({ confirmedBlockHeight: 999 })],
    });
    expect((out[0] as DelegateRow).clusterName).toBeUndefined();
  });

  it("is a no-op when no prior sources are supplied", () => {
    const rows = [delRow()];
    expect(applyCapturedClusterNames(rows, {})).toBe(rows);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mapAddressActivityToRows — dedupe vs delegation stream + fallback shaping
// ─────────────────────────────────────────────────────────────────────────────

describe("mapAddressActivityToRows", () => {
  const makeActivity = (overrides: Partial<RawAddressActivity> = {}): RawAddressActivity => ({
    blockHeight: 100,
    txIndex: 0,
    logIndex: 0,
    kind: "transfer",
    direction: "out",
    counterparty: "0xabc",
    tokenId: null,
    amount: "1000000000000000000", // raw lythoshi = 1 LYTH (18-dec; indexer wire is lythoshi)
    cluster: null,
    weightBps: null,
    subKind: null,
    ...overrides,
  });

  it("maps transfer/out (no tokenId) → TxSendRow", () => {
    const rows = mapAddressActivityToRows([makeActivity()], new Set());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("tx_send");
    expect((rows[0] as TxSendRow).counterparty).toBe("0xabc");
    expect((rows[0] as TxSendRow).amountDecimal).toBe("1");
  });

  it("converts the indexer's raw lythoshi amount to decimal LYTH for tx_send rows", () => {
    // The indexer wires amounts as raw lythoshi (18-dec; 1 lythoshi == 1 wei);
    // 10^16 lythoshi = 0.01 LYTH.
    const rows = mapAddressActivityToRows(
      [makeActivity({ amount: "10000000000000000" })],
      new Set(),
    );
    expect(rows).toHaveLength(1);
    expect((rows[0] as TxSendRow).amountDecimal).toBe("0.01");
  });

  it("converts a 1-lythoshi receive to 0.000000000000000001 LYTH (18-decimal floor)", () => {
    const rows = mapAddressActivityToRows(
      [makeActivity({ direction: "in", amount: "1" })],
      new Set(),
    );
    expect(rows).toHaveLength(1);
    expect((rows[0] as TxSendRow).amountDecimal).toBe("0.000000000000000001");
  });

  it("maps transfer/in (no tokenId) → TxReceiveRow", () => {
    const rows = mapAddressActivityToRows(
      [makeActivity({ direction: "in" })],
      new Set(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("tx_receive");
  });

  it("maps transfer with tokenId → TokenTransferRow", () => {
    const rows = mapAddressActivityToRows(
      [makeActivity({ tokenId: "0xdeadbeef" })],
      new Set(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("token_transfer");
  });

  it("routes a zero (Hash::ZERO) tokenId transfer to native tx_send, not token_transfer", () => {
    const rows = mapAddressActivityToRows(
      [makeActivity({ tokenId: NATIVE_LYTH_TOKEN_ID, direction: "out" })],
      new Set(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("tx_send");
  });

  it("routes a zero-tokenId inbound transfer to native tx_receive", () => {
    const rows = mapAddressActivityToRows(
      [makeActivity({ tokenId: NATIVE_LYTH_TOKEN_ID, direction: "in" })],
      new Set(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("tx_receive");
  });

  it("keeps a real (non-zero) MRC-20 tokenId as token_transfer", () => {
    const rows = mapAddressActivityToRows(
      [makeActivity({ tokenId: "0x" + "11".repeat(32), direction: "in" })],
      new Set(),
    );
    expect(rows[0]?.kind).toBe("token_transfer");
  });

  it("suppresses delegation entries whose anchor is in delegationKeys", () => {
    const keys = new Set(["100.0.0"]);
    const rows = mapAddressActivityToRows(
      [
        makeActivity({
          kind: "delegation",
          subKind: "delegated",
          cluster: 7,
          weightBps: 500,
        }),
      ],
      keys,
    );
    expect(rows).toHaveLength(0);
  });

  it("produces a fallback DelegateRow when delegation anchor is NOT in keys", () => {
    const rows = mapAddressActivityToRows(
      [
        makeActivity({
          kind: "delegation",
          subKind: "delegated",
          cluster: 7,
          weightBps: 500,
        }),
      ],
      new Set(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("delegate");
    expect((rows[0] as DelegateRow).cluster).toBe(7);
  });

  it("produces a fallback RedelegateRow with toCluster=null", () => {
    const rows = mapAddressActivityToRows(
      [
        makeActivity({
          kind: "delegation",
          subKind: "redelegated",
          cluster: 3,
        }),
      ],
      new Set(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("redelegate");
    expect((rows[0] as RedelegateRow).toCluster).toBeNull();
  });

  it("drops delegation entries with null cluster (bad data)", () => {
    const rows = mapAddressActivityToRows(
      [
        makeActivity({
          kind: "delegation",
          subKind: "delegated",
          cluster: null,
        }),
      ],
      new Set(),
    );
    expect(rows).toHaveLength(0);
  });

  it("drops delegation entries with unknown subKind", () => {
    const rows = mapAddressActivityToRows(
      [
        makeActivity({
          kind: "delegation",
          subKind: "weird-staking-thing",
          cluster: 1,
        }),
      ],
      new Set(),
    );
    expect(rows).toHaveLength(0);
  });

  it("maps crossing kinds (forward-compat — never fires on Sprintnet today)", () => {
    const rows = mapAddressActivityToRows(
      [
        makeActivity({ kind: "crossing", amount: "1.5" }),
        makeActivity({ kind: "cross_to_private", amount: "2.5" }),
      ],
      new Set(),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.kind).toBe("crossing_to_private");
    expect(rows[1]?.kind).toBe("crossing_to_private");
  });

  it("drops swap / staking / unknown kinds (out of supported surface)", () => {
    const rows = mapAddressActivityToRows(
      [
        makeActivity({ kind: "swap" }),
        makeActivity({ kind: "staking" }),
        makeActivity({ kind: "future_event" }),
      ],
      new Set(),
    );
    expect(rows).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// delegationKeySet
// ─────────────────────────────────────────────────────────────────────────────

describe("delegationKeySet", () => {
  it("builds keys with dot-separated anchor parts", () => {
    const rows: DelegateRow[] = [
      {
        kind: "delegate",
        blockHeight: 100,
        txIndex: 2,
        logIndex: 5,
        cluster: 1,
        weightBps: 1000,
      },
    ];
    const keys = delegationKeySet(rows);
    expect(keys.has("100.2.5")).toBe(true);
    expect(keys.size).toBe(1);
  });

  it("dedupes identical anchors silently", () => {
    const row: DelegateRow = {
      kind: "delegate",
      blockHeight: 100,
      txIndex: 0,
      logIndex: 0,
      cluster: 1,
      weightBps: 1000,
    };
    const keys = delegationKeySet([row, row]);
    expect(keys.size).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// evictExpiredPending — TTL backstop
// ─────────────────────────────────────────────────────────────────────────────

describe("evictExpiredPending", () => {
  const makePending = (broadcastedAtMs: number): PendingTxRow => ({
    kind: "pending_tx",
    txHash: "0x1",
    to: "0xabc",
    amountDecimal: "1",
    broadcastedAtMs,
    broadcastBlockHeight: 100,
    via: "halcyon",
  });

  it("keeps rows younger than PENDING_TTL_MS", () => {
    const now = 10_000_000;
    const fresh = makePending(now - PENDING_TTL_MS + 1);
    expect(evictExpiredPending([fresh], now)).toEqual([fresh]);
  });

  it("drops rows at or past PENDING_TTL_MS", () => {
    const now = 10_000_000;
    const expired = makePending(now - PENDING_TTL_MS);
    expect(evictExpiredPending([expired], now)).toEqual([]);
  });

  it("filters a mixed list correctly", () => {
    const now = 10_000_000;
    const fresh = makePending(now - 1000);
    const expired = makePending(now - PENDING_TTL_MS - 1000);
    const result = evictExpiredPending([fresh, expired], now);
    expect(result).toEqual([fresh]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// reconcilePending — heuristic match against confirmed stream
// ─────────────────────────────────────────────────────────────────────────────

describe("reconcilePending", () => {
  const makePending = (overrides: Partial<PendingTxRow> = {}): PendingTxRow => ({
    kind: "pending_tx",
    txHash: "0xtx1",
    to: "0xabc",
    amountDecimal: "0.01",
    broadcastedAtMs: 1_700_000_000_000,
    broadcastBlockHeight: 1000,
    via: "halcyon",
    ...overrides,
  });

  const makeTxSend = (overrides: Partial<TxSendRow> = {}): TxSendRow => ({
    kind: "tx_send",
    blockHeight: 1005,
    txIndex: 0,
    logIndex: 0,
    counterparty: "0xabc",
    amountDecimal: "0.01",
    ...overrides,
  });

  it("evicts a pending row when a tx_send matches within the block window", () => {
    const pending = makePending();
    const confirmed = makeTxSend({ blockHeight: 1005 });
    expect(reconcilePending([pending], [confirmed])).toEqual([]);
  });

  it("matches an indexer bech32m counterparty against a 0x pending `to` (the linger bug)", () => {
    // The indexer returns counterparty as bech32m; a pending row's `to` is the
    // 0x EVM address it was broadcast with. They must normalize to the same 0x —
    // otherwise reconcilePending never matched + the row lingered to the alarm.
    const pending = makePending({
      to: "0x01029862840d227ee9e76a845c8cbb80ba1d7d23",
      broadcastBlockHeight: 1000,
    });
    const confirmed = makeTxSend({
      counterparty: "mono1qypfsc5yp538a608d2z9er9mszap6lfrl3sc46",
      blockHeight: 1005,
    });
    expect(reconcilePending([pending], [confirmed])).toEqual([]);
  });

  it("matches a bridged row by exact (block, txIndex), kind-agnostic — incl. delegations", () => {
    // A receipt-confirmed (bridged) row carries (confirmedBlockHeight,
    // confirmedTxIndex). It matches the indexer's canonical row at that exact
    // slot regardless of KIND — a delegate surfaces as a delegation row, NEVER
    // a tx_send, so without this it would linger to the 30s alarm. (Note the
    // module `to` + delegate row would never match the tx_send heuristic.)
    const pending = makePending({
      opKind: "delegate",
      to: "0x" + "11".repeat(20),
      broadcastBlockHeight: 1000,
      confirmedBlockHeight: 1400,
      confirmedTxIndex: 2,
    });
    const delegate: DelegateRow = {
      kind: "delegate",
      blockHeight: 1400,
      txIndex: 2,
      logIndex: 0,
      cluster: 1,
      weightBps: 1000,
    };
    expect(reconcilePending([pending], [delegate])).toEqual([]);
  });

  it("keeps a bridged row when the indexer slot doesn't match (same block, different txIndex)", () => {
    const pending = makePending({ confirmedBlockHeight: 1400, confirmedTxIndex: 2 });
    const confirmed = makeTxSend({ blockHeight: 1400, txIndex: 5 });
    expect(reconcilePending([pending], [confirmed])).toEqual([pending]);
  });

  it("matches pending and confirmed rows at 1-lythoshi precision", () => {
    const pending = makePending({ amountDecimal: "0.00000001" });
    const confirmed = makeTxSend({
      blockHeight: 1005,
      amountDecimal: "0.00000001",
    });
    expect(reconcilePending([pending], [confirmed])).toEqual([]);
  });

  it("evicts when the block delta is exactly PENDING_MATCH_BLOCK_WINDOW", () => {
    const pending = makePending({ broadcastBlockHeight: 1000 });
    const confirmed = makeTxSend({ blockHeight: 1000 + PENDING_MATCH_BLOCK_WINDOW });
    expect(reconcilePending([pending], [confirmed])).toEqual([]);
  });

  it("keeps the pending row when block delta exceeds the window", () => {
    const pending = makePending({ broadcastBlockHeight: 1000 });
    const confirmed = makeTxSend({ blockHeight: 1000 + PENDING_MATCH_BLOCK_WINDOW + 1 });
    expect(reconcilePending([pending], [confirmed])).toEqual([pending]);
  });

  it("keeps the pending row when amount differs", () => {
    const pending = makePending({ amountDecimal: "0.01" });
    const confirmed = makeTxSend({ amountDecimal: "0.02" });
    expect(reconcilePending([pending], [confirmed])).toEqual([pending]);
  });

  it("keeps the pending row when counterparty differs (case-insensitive compare)", () => {
    const pending = makePending({ to: "0xabc" });
    const confirmed = makeTxSend({ counterparty: "0xdef" });
    expect(reconcilePending([pending], [confirmed])).toEqual([pending]);
  });

  it("matches counterparty case-insensitively", () => {
    const pending = makePending({ to: "0xABC" });
    const confirmed = makeTxSend({ counterparty: "0xabc" });
    expect(reconcilePending([pending], [confirmed])).toEqual([]);
  });

  it("keeps the pending row when broadcastBlockHeight is null (TTL-only path)", () => {
    const pending = makePending({ broadcastBlockHeight: null });
    const confirmed = makeTxSend({ blockHeight: 1005 });
    expect(reconcilePending([pending], [confirmed])).toEqual([pending]);
  });

  it("does not match a tx_receive row (pending rows are always sends)", () => {
    const pending = makePending();
    const confirmed: ConfirmedRow = {
      kind: "tx_receive",
      blockHeight: 1005,
      txIndex: 0,
      logIndex: 0,
      counterparty: "0xabc",
      amountDecimal: "0.01",
    };
    expect(reconcilePending([pending], [confirmed])).toEqual([pending]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mergeIndexerSnapshot — end-to-end (dedupe + sort + cap)
// ─────────────────────────────────────────────────────────────────────────────

describe("mergeIndexerSnapshot", () => {
  it("returns an empty cache on empty inputs", () => {
    const r = mergeIndexerSnapshot({ activity: [], delegation: [] }, 1_700_000_000_000);
    expect(r.confirmed).toEqual([]);
    expect(r.lastFetchedAtMs).toBe(1_700_000_000_000);
  });

  it("threads a captured cluster name (from prior.pending) onto the confirmed delegate row; leaves an un-sourced row unnamed", () => {
    const r = mergeIndexerSnapshot(
      {
        activity: [],
        delegation: [
          {
            blockHeight: 150,
            txIndex: 2,
            logIndex: 0,
            wallet: "0xself",
            cluster: 0, // the real, 0-indexed cluster the user delegated to
            toCluster: null,
            kind: "delegated",
            weightBps: 5000,
            walletTotalBps: null,
          },
        ],
      },
      1,
      {
        pending: [
          {
            kind: "pending_tx",
            txHash: "0xdead",
            to: "0x100a",
            amountDecimal: "1",
            broadcastedAtMs: 1,
            broadcastBlockHeight: 150,
            via: "operator-1",
            confirmedBlockHeight: 150,
            confirmedTxIndex: 2,
            clusterId: 0,
            clusterName: "halcyon.cluster.mono",
          },
        ],
      },
    );
    const del = r.confirmed.find((c) => c.kind === "delegate") as DelegateRow;
    expect(del.cluster).toBe(0);
    expect(del.clusterName).toBe("halcyon.cluster.mono");

    // No prior → the same confirmed row stays unnamed (honest #id fallback).
    const bare = mergeIndexerSnapshot(
      {
        activity: [],
        delegation: [
          {
            blockHeight: 150,
            txIndex: 2,
            logIndex: 0,
            wallet: "0xself",
            cluster: 0,
            toCluster: null,
            kind: "delegated",
            weightBps: 5000,
            walletTotalBps: null,
          },
        ],
      },
      1,
    );
    expect((bare.confirmed[0] as DelegateRow).clusterName).toBeUndefined();
  });

  it("interleaves activity + delegation streams, newest first", () => {
    const r = mergeIndexerSnapshot(
      {
        activity: [
          {
            blockHeight: 200,
            txIndex: 0,
            logIndex: 0,
            kind: "transfer",
            direction: "out",
            counterparty: "0xabc",
            tokenId: null,
            amount: "1",
            cluster: null,
            weightBps: null,
            subKind: null,
          },
          {
            blockHeight: 100,
            txIndex: 0,
            logIndex: 0,
            kind: "transfer",
            direction: "in",
            counterparty: "0xdef",
            tokenId: null,
            amount: "2",
            cluster: null,
            weightBps: null,
            subKind: null,
          },
        ],
        delegation: [
          {
            blockHeight: 150,
            txIndex: 0,
            logIndex: 0,
            wallet: "0xself",
            cluster: 7,
            toCluster: null,
            kind: "delegated",
            weightBps: 1000,
            walletTotalBps: null,
          },
        ],
      },
      1_700_000_000_000,
    );
    expect(r.confirmed.map((c) => c.kind)).toEqual([
      "tx_send",       // block 200
      "delegate",      // block 150
      "tx_receive",    // block 100
    ]);
  });

  it("SELF-TRANSFER: keeps BOTH the out + in legs (same anchor, u32::MAX logIndex)", () => {
    // The indexer emits two entries for a self-send at the SAME
    // (blockHeight, txIndex, logIndex) — native transfers share the
    // logIndex=0xFFFFFFFF sentinel. Both must survive the dedupe.
    const SELF = "mono1qypfsc5yp538a608d2z9er9mszap6lfrl3sc46";
    const leg = (direction: "in" | "out") => ({
      blockHeight: 107461,
      txIndex: 0,
      logIndex: 4294967295,
      kind: "transfer" as const,
      direction,
      counterparty: SELF,
      tokenId: "0x" + "00".repeat(32),
      amount: "120000000000000000", // 0.12 LYTH (18-dec)
      cluster: null,
      weightBps: null,
      subKind: null,
    });
    const r = mergeIndexerSnapshot({ activity: [leg("in"), leg("out")], delegation: [] }, 1);
    const kinds = r.confirmed.map((c) => c.kind).sort();
    expect(kinds).toEqual(["tx_receive", "tx_send"]);
    // Both legs carry the same amount + the self counterparty.
    for (const c of r.confirmed) {
      expect((c as { amountDecimal: string | null }).amountDecimal).toBe("0.12");
      expect((c as { counterparty: string | null }).counterparty).toBe(SELF);
    }
  });

  it("DEDUPE: when both streams surface the same on-chain delegation event, DelegationHistoryRecord wins", () => {
    // This is the central correctness test for the activity-vs-delegation
    // dedupe. The activity-stream entry at
    // (100, 0, 0) MUST be suppressed; only the rich delegation-history
    // row appears, with `toCluster: 9` (which the activity stream cannot
    // surface).
    const r = mergeIndexerSnapshot(
      {
        activity: [
          {
            blockHeight: 100,
            txIndex: 0,
            logIndex: 0,
            kind: "delegation",
            direction: null,
            counterparty: null,
            tokenId: null,
            amount: null,
            cluster: 3,
            weightBps: 500,
            subKind: "redelegated",
          },
        ],
        delegation: [
          {
            blockHeight: 100,
            txIndex: 0,
            logIndex: 0,
            wallet: "0xself",
            cluster: 3,
            toCluster: 9,
            kind: "redelegated",
            weightBps: 500,
            walletTotalBps: null,
          },
        ],
      },
      1_700_000_000_000,
    );
    expect(r.confirmed).toHaveLength(1);
    expect(r.confirmed[0]?.kind).toBe("redelegate");
    expect((r.confirmed[0] as RedelegateRow).toCluster).toBe(9);
  });

  it("FALLBACK: activity-stream delegation WITHOUT a delegation-history match survives (toCluster=null)", () => {
    const r = mergeIndexerSnapshot(
      {
        activity: [
          {
            blockHeight: 100,
            txIndex: 0,
            logIndex: 0,
            kind: "delegation",
            direction: null,
            counterparty: null,
            tokenId: null,
            amount: null,
            cluster: 3,
            weightBps: 500,
            subKind: "redelegated",
          },
        ],
        delegation: [],
      },
      1_700_000_000_000,
    );
    expect(r.confirmed).toHaveLength(1);
    expect(r.confirmed[0]?.kind).toBe("redelegate");
    expect((r.confirmed[0] as RedelegateRow).toCluster).toBeNull();
  });

  it("respects the rolling window cap at ACTIVITY_ROLLING_WINDOW", () => {
    // Generate 150 activity entries; merged cache should hold exactly 100,
    // newest first.
    const activity: RawAddressActivity[] = [];
    for (let i = 0; i < 150; i++) {
      activity.push({
        blockHeight: i,
        txIndex: 0,
        logIndex: 0,
        kind: "transfer",
        direction: "in",
        counterparty: "0xabc",
        tokenId: null,
        amount: String(i),
        cluster: null,
        weightBps: null,
        subKind: null,
      });
    }
    const r = mergeIndexerSnapshot({ activity, delegation: [] }, 1);
    expect(r.confirmed).toHaveLength(ACTIVITY_ROLLING_WINDOW);
    // Newest first: highest block heights kept.
    expect(r.confirmed[0]?.blockHeight).toBe(149);
    expect(r.confirmed[r.confirmed.length - 1]?.blockHeight).toBe(50);
  });

  it("sorts by full (blockHeight, txIndex, logIndex) anchor", () => {
    const r = mergeIndexerSnapshot(
      {
        activity: [
          {
            blockHeight: 100,
            txIndex: 1,
            logIndex: 0,
            kind: "transfer",
            direction: "out",
            counterparty: "0xabc",
            tokenId: null,
            amount: "1000000000000000000", // 1 LYTH (18-dec)
            cluster: null,
            weightBps: null,
            subKind: null,
          },
          {
            blockHeight: 100,
            txIndex: 0,
            logIndex: 5,
            kind: "transfer",
            direction: "in",
            counterparty: "0xabc",
            tokenId: null,
            amount: "2000000000000000000", // 2 LYTH (18-dec)
            cluster: null,
            weightBps: null,
            subKind: null,
          },
          {
            blockHeight: 100,
            txIndex: 0,
            logIndex: 3,
            kind: "transfer",
            direction: "in",
            counterparty: "0xabc",
            tokenId: null,
            amount: "3000000000000000000", // 3 LYTH (18-dec)
            cluster: null,
            weightBps: null,
            subKind: null,
          },
        ],
        delegation: [],
      },
      1,
    );
    // Newest first within same block: higher txIndex wins; within same tx,
    // higher logIndex wins.
    expect(r.confirmed.map((c) => (c as TxSendRow | TxSendRow).amountDecimal)).toEqual([
      "1", // (100, 1, 0)
      "2", // (100, 0, 5)
      "3", // (100, 0, 3)
    ]);
  });
});

describe("isNativeLythTokenId", () => {
  it("treats null / empty / all-zero hex as native LYTH", () => {
    expect(isNativeLythTokenId(null)).toBe(true);
    expect(isNativeLythTokenId("")).toBe(true);
    expect(isNativeLythTokenId("0x0")).toBe(true);
    expect(isNativeLythTokenId(NATIVE_LYTH_TOKEN_ID)).toBe(true);
  });

  it("treats a real non-zero token id as NOT native", () => {
    expect(isNativeLythTokenId("0x" + "11".repeat(32))).toBe(false);
    expect(isNativeLythTokenId("0xdeadbeef")).toBe(false);
  });
});

describe("mergeActivityNewestFirst", () => {
  const pending = (over: Partial<PendingTxRow> = {}): PendingTxRow => ({
    kind: "pending_tx",
    txHash: "0xp",
    to: "0x2",
    amountDecimal: "1",
    broadcastedAtMs: 1000,
    broadcastBlockHeight: null,
    via: "op",
    ...over,
  });
  const confirmed = (over: Partial<TxSendRow> = {}): TxSendRow => ({
    kind: "tx_send",
    blockHeight: 100,
    txIndex: 0,
    logIndex: 0,
    counterparty: "0x3",
    amountDecimal: "1",
    ...over,
  });
  const failed = (over: Record<string, unknown> = {}) =>
    ({
      id: "c:0xf",
      txHash: "0xf",
      status: "failed",
      blockNumber: null,
      kind: "delegate",
      amountDecimal: "1",
      counterparty: "0x4",
      createdAtMs: 2000,
      read: false,
      schemaVersion: 0,
      ...over,
    }) as Parameters<typeof mergeActivityNewestFirst>[2][number];

  it("interleaves a failed row chronologically instead of pinning it on top", () => {
    // failed at 23s-ago (block 41269) must sit BELOW a newer pending (7s ago,
    // not yet anchored) — the bug was failed-always-on-top.
    const now = 100_000;
    const out = mergeActivityNewestFirst(
      [pending({ txHash: "0xnew", broadcastedAtMs: now - 7_000 })],
      [],
      [failed({ txHash: "0xold", blockNumber: 41269, createdAtMs: now - 23_000 })],
    );
    expect(out.map((i) => (i.tag === "row" ? "pending" : "failed"))).toEqual([
      "pending",
      "failed",
    ]);
  });

  it("orders by block desc, with unanchored (null-block) rows floating to top", () => {
    const out = mergeActivityNewestFirst(
      [pending({ txHash: "0xp", broadcastBlockHeight: null, broadcastedAtMs: 5000 })],
      [confirmed({ blockHeight: 200 }), confirmed({ blockHeight: 100 })],
      [failed({ txHash: "0xf", blockNumber: 150, createdAtMs: 1 })],
    );
    const blocks = out.map((i) =>
      i.tag === "row"
        ? i.row.kind === "pending_tx"
          ? "pending"
          : (i.row as TxSendRow).blockHeight
        : "failed150",
    );
    // null-block pending first, then 200, then failed@150, then 100.
    expect(blocks).toEqual(["pending", 200, "failed150", 100]);
  });

  it("does not NaN when two rows are both unanchored (Infinity===Infinity → ms tie-break)", () => {
    const out = mergeActivityNewestFirst(
      [pending({ txHash: "0xa", broadcastBlockHeight: null, broadcastedAtMs: 10 })],
      [],
      [failed({ txHash: "0xb", blockNumber: null, createdAtMs: 20 })],
    );
    // Both block=Infinity → newer ms (failed@20) first.
    expect(out[0]!.tag === "failed").toBe(true);
    expect(out[1]!.tag === "row").toBe(true);
  });
});
