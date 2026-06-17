import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_HISTORY_CAP,
  NOTIFICATION_LABELS,
  appendCapped,
  isTxOpKind,
  notificationId,
  notificationTitle,
  notifiedSetKey,
  notificationsHistoryKey,
  parseHistoryEnvelope,
  parseNotifiedSetEnvelope,
  type NotificationRecord,
  type TxOpKind,
} from "./notifications.js";

function fixtureRecord(
  overrides: Partial<NotificationRecord> = {},
): NotificationRecord {
  return {
    id: "0x10f2c:0x" + "ab".repeat(32),
    txHash: "0x" + "ab".repeat(32),
    status: "confirmed",
    blockNumber: 100,
    kind: "send",
    amountDecimal: "0.10",
    counterparty: "0x" + "01".repeat(20),
    createdAtMs: 1_700_000_000_000,
    read: false,
    schemaVersion: 0,
    ...overrides,
  };
}

describe("notification key builders", () => {
  it("history key is per-(addr, chain) and versioned", () => {
    expect(notificationsHistoryKey("0xabc", "0x10f2c")).toBe(
      "mono.notifications.history.0xabc.0x10f2c.v1",
    );
  });

  it("notified-set key is per-(addr, chain) and versioned", () => {
    expect(notifiedSetKey("0xabc", "0x10f2c")).toBe(
      "mono.notifications.notified.0xabc.0x10f2c.v1",
    );
  });

  it("history and notified-set live under distinct keys for the same scope", () => {
    const h = notificationsHistoryKey("0xabc", "0x10f2c");
    const n = notifiedSetKey("0xabc", "0x10f2c");
    expect(h).not.toBe(n);
  });

  it("notificationId is `${chainIdHex}:${txHash}`", () => {
    expect(notificationId("0x10f2c", "0xdeadbeef")).toBe("0x10f2c:0xdeadbeef");
  });
});

describe("appendCapped", () => {
  it("inserts newest-first when under cap", () => {
    const a = fixtureRecord({ id: "a", createdAtMs: 1 });
    const b = fixtureRecord({ id: "b", createdAtMs: 2 });
    const next = appendCapped([a], b);
    expect(next[0]?.id).toBe("b");
    expect(next[1]?.id).toBe("a");
    expect(next.length).toBe(2);
  });

  it("slices to cap when overflowing — 51 in, 50 newest retained", () => {
    let entries: NotificationRecord[] = [];
    for (let i = 0; i < 51; i++) {
      entries = appendCapped(
        entries,
        fixtureRecord({ id: `r${i}`, createdAtMs: i }),
      );
    }
    expect(entries.length).toBe(NOTIFICATION_HISTORY_CAP);
    expect(entries.length).toBe(50);
    // Newest at index 0 — the 51st insert (`r50`) — and the 1st insert
    // (`r0`) has been dropped.
    expect(entries[0]?.id).toBe("r50");
    expect(entries.find((r) => r.id === "r0")).toBeUndefined();
    expect(entries[entries.length - 1]?.id).toBe("r1");
  });

  it("honors a custom cap", () => {
    const a = fixtureRecord({ id: "a" });
    const b = fixtureRecord({ id: "b" });
    const c = fixtureRecord({ id: "c" });
    const next = appendCapped(appendCapped(appendCapped([], a), b), c, 2);
    expect(next.length).toBe(2);
    expect(next[0]?.id).toBe("c");
    expect(next[1]?.id).toBe("b");
  });
});

describe("parseHistoryEnvelope", () => {
  it("parses a valid envelope round-trip", () => {
    const env = { schemaVersion: 0, entries: [fixtureRecord()] };
    const parsed = parseHistoryEnvelope(env);
    expect(parsed?.entries[0]?.id).toBe(env.entries[0]!.id);
    expect(parsed?.entries.length).toBe(1);
  });

  it("returns null for non-objects + missing schemaVersion + bad shape", () => {
    expect(parseHistoryEnvelope(null)).toBeNull();
    expect(parseHistoryEnvelope("garbage")).toBeNull();
    expect(parseHistoryEnvelope(42)).toBeNull();
    expect(parseHistoryEnvelope({})).toBeNull();
    expect(parseHistoryEnvelope({ schemaVersion: "wrong", entries: [] })).toBeNull();
    expect(parseHistoryEnvelope({ schemaVersion: 0 })).toBeNull(); // missing entries
    expect(parseHistoryEnvelope({ schemaVersion: 0, entries: "x" })).toBeNull();
  });

  it("drops malformed individual entries but keeps the well-formed ones", () => {
    const env = {
      schemaVersion: 0,
      entries: [
        fixtureRecord({ id: "good" }),
        { id: "bad", status: "maybe" }, // invalid status
        fixtureRecord({ id: "good2" }),
      ],
    };
    const parsed = parseHistoryEnvelope(env);
    expect(parsed?.entries.map((e) => e.id)).toEqual(["good", "good2"]);
  });

  it("rejects entries with non-confirmed/failed status values (no silent coercion)", () => {
    const env = {
      schemaVersion: 0,
      entries: [fixtureRecord({ status: "pending" as unknown as "confirmed" })],
    };
    const parsed = parseHistoryEnvelope(env);
    expect(parsed?.entries.length).toBe(0);
  });
});

describe("notificationTitle / NOTIFICATION_LABELS", () => {
  // Pin every kind's confirmed/failed wording explicitly — these are
  // the user-facing strings the Phase-2 toast + Phase-3 row title will
  // render, so a one-line table makes drift obvious.
  const expected: Array<[TxOpKind, { confirmed: string; failed: string }]> = [
    ["send", { confirmed: "Sent", failed: "Send failed" }],
    ["delegate", { confirmed: "Delegated", failed: "Delegate failed" }],
    ["undelegate", { confirmed: "Undelegated", failed: "Undelegate failed" }],
    ["redelegate", { confirmed: "Redelegated", failed: "Redelegate failed" }],
    ["claim", { confirmed: "Rewards claimed", failed: "Claim failed" }],
    [
      "complete-redemption",
      { confirmed: "Redemption completed", failed: "Redemption failed" },
    ],
    [
      "emergency-key",
      { confirmed: "Backup key registered", failed: "Backup registration failed" },
    ],
    [
      "agent-policy",
      { confirmed: "Agent policy updated", failed: "Agent policy failed" },
    ],
    [
      "contract_call",
      { confirmed: "Transaction confirmed", failed: "Transaction failed" },
    ],
  ];

  for (const [kind, labels] of expected) {
    it(`renders ${kind} → confirmed: "${labels.confirmed}" / failed: "${labels.failed}"`, () => {
      expect(notificationTitle(kind, "confirmed")).toBe(labels.confirmed);
      expect(notificationTitle(kind, "failed")).toBe(labels.failed);
      expect(NOTIFICATION_LABELS[kind]).toEqual(labels);
    });
  }

  it("covers every TxOpKind literal (no fall-through)", () => {
    const kinds: TxOpKind[] = [
      "send",
      "delegate",
      "undelegate",
      "redelegate",
      "claim",
      "complete-redemption",
      "emergency-key",
      "agent-policy",
      "contract_call",
    ];
    for (const k of kinds) {
      expect(NOTIFICATION_LABELS[k].confirmed.length).toBeGreaterThan(0);
      expect(NOTIFICATION_LABELS[k].failed.length).toBeGreaterThan(0);
    }
  });
});

describe("isTxOpKind", () => {
  it("accepts every TxOpKind literal", () => {
    const kinds: TxOpKind[] = [
      "send",
      "delegate",
      "undelegate",
      "redelegate",
      "claim",
      "complete-redemption",
      "emergency-key",
      "agent-policy",
      "contract_call",
    ];
    for (const k of kinds) expect(isTxOpKind(k)).toBe(true);
  });

  it("rejects unknown / wrong-type values", () => {
    expect(isTxOpKind("Send")).toBe(false);        // wrong case
    expect(isTxOpKind("token-transfer")).toBe(false); // not in union
    expect(isTxOpKind("")).toBe(false);
    expect(isTxOpKind(undefined)).toBe(false);
    expect(isTxOpKind(null)).toBe(false);
    expect(isTxOpKind(42)).toBe(false);
    expect(isTxOpKind({})).toBe(false);
  });
});

describe("parseNotifiedSetEnvelope", () => {
  it("parses a valid envelope round-trip", () => {
    const env = { schemaVersion: 0, ids: ["a", "b"] };
    const parsed = parseNotifiedSetEnvelope(env);
    expect(parsed?.ids).toEqual(["a", "b"]);
  });

  it("returns null for bad shapes", () => {
    expect(parseNotifiedSetEnvelope(null)).toBeNull();
    expect(parseNotifiedSetEnvelope({ schemaVersion: 0 })).toBeNull();
    expect(parseNotifiedSetEnvelope({ schemaVersion: 0, ids: "x" })).toBeNull();
    expect(parseNotifiedSetEnvelope({ schemaVersion: 1, ids: [] })).toBeNull();
  });

  it("filters non-string ids", () => {
    const env = { schemaVersion: 0, ids: ["a", 7, null, "b"] };
    const parsed = parseNotifiedSetEnvelope(env);
    expect(parsed?.ids).toEqual(["a", "b"]);
  });
});
