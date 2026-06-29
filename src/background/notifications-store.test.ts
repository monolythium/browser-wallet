// `notifications-store` round-trip coverage.
//
// We stub `chrome.storage.local` with an in-memory record (the same
// pattern used by `keystore.test.ts`) so the real `recordNotification`
// path is exercised under Node, including the dedupe + cap + namespacing
// + status-fidelity invariants the chokepoint hook depends on.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface StorageMap {
  [k: string]: unknown;
}

function installChromeStub(): { storage: StorageMap } {
  const storage: StorageMap = {};
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: (
          keys: string | string[] | null,
          cb: (res: Record<string, unknown>) => void,
        ) => {
          if (keys === null) {
            // `chrome.storage.local.get(null, …)` returns ALL entries —
            // this is what `getUnread` uses to aggregate across scopes.
            queueMicrotask(() => cb({ ...storage }));
            return;
          }
          const arr = typeof keys === "string" ? [keys] : keys;
          const out: Record<string, unknown> = {};
          for (const k of arr) {
            if (k in storage) out[k] = storage[k];
          }
          queueMicrotask(() => cb(out));
        },
        set: (entries: Record<string, unknown>, cb: () => void) => {
          for (const [k, v] of Object.entries(entries)) {
            storage[k] = v;
          }
          queueMicrotask(() => cb());
        },
        remove: (keys: string | string[], cb?: () => void) => {
          const arr = typeof keys === "string" ? [keys] : keys;
          for (const k of arr) delete storage[k];
          if (cb) queueMicrotask(() => cb());
        },
      },
    },
  };
  return { storage };
}

const ADDR_A = "0x" + "ab".repeat(20);
const ADDR_B = "0x" + "cd".repeat(20);
const CHAIN_A = "0x10f2c";
const CHAIN_B = "0x1";
const HASH_1 = "0x" + "11".repeat(32);
const HASH_2 = "0x" + "22".repeat(32);

function baseInput(overrides: {
  addressLower?: string;
  chainIdHex?: string;
  txHash?: string;
  status?: "confirmed" | "failed";
  kind?: "send" | "contract_call";
  blockNumber?: number | null;
  feeLythoshi?: string;
  clusterId?: number;
  clusterName?: string;
} = {}) {
  return {
    addressLower: ADDR_A,
    chainIdHex: CHAIN_A,
    txHash: HASH_1,
    status: "confirmed" as const,
    blockNumber: 100,
    kind: "send" as const,
    amountDecimal: "0.10",
    counterparty: "0x" + "01".repeat(20),
    ...overrides,
  };
}

describe("notifications-store", () => {
  let storage: StorageMap;

  beforeEach(() => {
    ({ storage } = installChromeStub());
    vi.resetModules();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("records a new notification and writes both history + notified-set", async () => {
    const { recordNotification } = await import("./notifications-store.js");
    const r = await recordNotification(baseInput());
    expect(r.added).toBe(true);
    expect(r.record?.id).toBe(`${CHAIN_A}:${HASH_1}`);
    expect(r.record?.read).toBe(false);
    expect(r.record?.schemaVersion).toBe(0);
    expect(
      (storage[`mono.notifications.history.${ADDR_A}.${CHAIN_A}.v1`] as {
        entries: unknown[];
      }).entries,
    ).toHaveLength(1);
    expect(
      (storage[`mono.notifications.notified.${ADDR_A}.${CHAIN_A}.v1`] as {
        ids: string[];
      }).ids,
    ).toContain(`${CHAIN_A}:${HASH_1}`);
  });

  it("persists + round-trips an optional feeLythoshi; absent stays absent", async () => {
    const { recordNotification, listNotifications } = await import(
      "./notifications-store.js"
    );
    // With a fee → stored + read back verbatim.
    await recordNotification(baseInput({ txHash: HASH_1, feeLythoshi: "600000" }));
    // Without a fee → the field is omitted (no fake "0").
    await recordNotification(baseInput({ txHash: HASH_2 }));
    const list = await listNotifications(ADDR_A, CHAIN_A);
    const withFee = list.find((r) => r.txHash === HASH_1);
    const noFee = list.find((r) => r.txHash === HASH_2);
    expect(withFee?.feeLythoshi).toBe("600000");
    expect(noFee).toBeDefined();
    expect("feeLythoshi" in (noFee as object)).toBe(false);
  });

  it("persists + round-trips optional cluster metadata; absent stays absent", async () => {
    const { recordNotification, listNotifications } = await import(
      "./notifications-store.js"
    );
    await recordNotification(
      baseInput({ txHash: HASH_1, clusterId: 1, clusterName: "halcyon.cluster.mono" }),
    );
    await recordNotification(baseInput({ txHash: HASH_2 }));
    const list = await listNotifications(ADDR_A, CHAIN_A);
    const withCluster = list.find((r) => r.txHash === HASH_1);
    const noCluster = list.find((r) => r.txHash === HASH_2);
    expect(withCluster?.clusterId).toBe(1);
    expect(withCluster?.clusterName).toBe("halcyon.cluster.mono");
    expect("clusterId" in (noCluster as object)).toBe(false);
    expect("clusterName" in (noCluster as object)).toBe(false);
  });

  it("dedupes — a second call with the same (addr, chain, txHash) is a no-op", async () => {
    const { recordNotification } = await import("./notifications-store.js");
    const first = await recordNotification(baseInput());
    expect(first.added).toBe(true);
    const second = await recordNotification(baseInput());
    expect(second.added).toBe(false);
    expect(second.record).toBeNull();
    const entries = (storage[
      `mono.notifications.history.${ADDR_A}.${CHAIN_A}.v1`
    ] as { entries: unknown[] }).entries;
    expect(entries).toHaveLength(1);
    const ids = (storage[
      `mono.notifications.notified.${ADDR_A}.${CHAIN_A}.v1`
    ] as { ids: string[] }).ids;
    expect(ids).toHaveLength(1);
  });

  it("caps history at 50 newest-first when overflowed (51 in → 50 retained)", async () => {
    const { recordNotification, listNotifications } = await import(
      "./notifications-store.js"
    );
    for (let i = 0; i < 51; i++) {
      const hash = "0x" + i.toString(16).padStart(64, "0");
      await recordNotification(baseInput({ txHash: hash }));
    }
    const list = await listNotifications(ADDR_A, CHAIN_A);
    expect(list).toHaveLength(50);
    // Newest first — `i=50` is the most recent insert.
    const expectedNewest =
      "0x" + (50).toString(16).padStart(64, "0");
    expect(list[0]?.txHash).toBe(expectedNewest);
    // The very first insert (`i=0`) is dropped.
    const droppedHash = "0x" + (0).toString(16).padStart(64, "0");
    expect(list.find((r) => r.txHash === droppedHash)).toBeUndefined();
    // Dedupe-set keeps ALL ids — it's intentionally uncapped so a long-
    // dropped record can't re-fire if it ever resurfaces.
    const ids = (storage[
      `mono.notifications.notified.${ADDR_A}.${CHAIN_A}.v1`
    ] as { ids: string[] }).ids;
    expect(ids).toHaveLength(51);
  });

  it("isolates scope per (addr, chain) — no cross-bleed in history or dedupe-set", async () => {
    const { recordNotification, listNotifications } = await import(
      "./notifications-store.js"
    );
    // Same txHash recorded for two different addresses (same chain).
    await recordNotification(baseInput({ addressLower: ADDR_A, txHash: HASH_1 }));
    const otherAddr = await recordNotification(
      baseInput({ addressLower: ADDR_B, txHash: HASH_1 }),
    );
    // Dedupe is per-scope — the SAME tx on a DIFFERENT addr is "new".
    expect(otherAddr.added).toBe(true);

    // Same txHash recorded for the same address on a different chain.
    const otherChain = await recordNotification(
      baseInput({ addressLower: ADDR_A, chainIdHex: CHAIN_B, txHash: HASH_1 }),
    );
    expect(otherChain.added).toBe(true);

    expect(await listNotifications(ADDR_A, CHAIN_A)).toHaveLength(1);
    expect(await listNotifications(ADDR_B, CHAIN_A)).toHaveLength(1);
    expect(await listNotifications(ADDR_A, CHAIN_B)).toHaveLength(1);
    // ADDR_B / CHAIN_B was never touched.
    expect(await listNotifications(ADDR_B, CHAIN_B)).toHaveLength(0);
  });

  it("status fidelity — a 'failed' input is stored as 'failed', never coerced", async () => {
    const { recordNotification, listNotifications } = await import(
      "./notifications-store.js"
    );
    await recordNotification(baseInput({ txHash: HASH_1, status: "failed" }));
    const list = await listNotifications(ADDR_A, CHAIN_A);
    expect(list[0]?.status).toBe("failed");
    // And the round-trip preserves the literal — guard against any future
    // accidental coercion in the read path.
    const env = storage[
      `mono.notifications.history.${ADDR_A}.${CHAIN_A}.v1`
    ] as { entries: Array<{ status: string }> };
    expect(env.entries[0]?.status).toBe("failed");
  });

  it("markAllRead flips unread entries; idempotent on already-read scopes", async () => {
    const { recordNotification, markAllRead, listNotifications } = await import(
      "./notifications-store.js"
    );
    await recordNotification(baseInput({ txHash: HASH_1 }));
    await recordNotification(baseInput({ txHash: HASH_2 }));

    const first = await markAllRead(ADDR_A, CHAIN_A);
    expect(first.flipped).toBe(2);
    const list = await listNotifications(ADDR_A, CHAIN_A);
    expect(list.every((r) => r.read)).toBe(true);

    const second = await markAllRead(ADDR_A, CHAIN_A);
    expect(second.flipped).toBe(0);
  });

  it("getUnread sums unread across ALL scopes (no separate counter key)", async () => {
    const { recordNotification, markAllRead, getUnread } = await import(
      "./notifications-store.js"
    );
    await recordNotification(baseInput({ addressLower: ADDR_A, txHash: HASH_1 }));
    await recordNotification(baseInput({ addressLower: ADDR_A, txHash: HASH_2 }));
    await recordNotification(baseInput({ addressLower: ADDR_B, txHash: HASH_1 }));
    expect(await getUnread()).toBe(3);

    // Marking one scope read drops only that scope's contribution.
    await markAllRead(ADDR_A, CHAIN_A);
    expect(await getUnread()).toBe(1);

    // The derived count goes to zero when every scope is read.
    await markAllRead(ADDR_B, CHAIN_A);
    expect(await getUnread()).toBe(0);
  });

  it("tolerant parse — garbage at the history key heals on the next write", async () => {
    const { recordNotification, listNotifications } = await import(
      "./notifications-store.js"
    );
    // Plant junk where the history envelope should live.
    storage[`mono.notifications.history.${ADDR_A}.${CHAIN_A}.v1`] =
      "this is not an envelope";
    // The read path returns [] for the garbage scope.
    expect(await listNotifications(ADDR_A, CHAIN_A)).toEqual([]);

    // recordNotification heals — next call writes a fresh envelope.
    const r = await recordNotification(baseInput({ txHash: HASH_1 }));
    expect(r.added).toBe(true);
    expect(await listNotifications(ADDR_A, CHAIN_A)).toHaveLength(1);
  });

  it("stored record matches the NotificationRecord schema (id, read:false, schemaVersion:0)", async () => {
    const { recordNotification, listNotifications } = await import(
      "./notifications-store.js"
    );
    await recordNotification(baseInput({ txHash: HASH_1 }));
    const list = await listNotifications(ADDR_A, CHAIN_A);
    const rec = list[0];
    expect(rec).toBeDefined();
    expect(rec?.id).toBe(`${CHAIN_A}:${HASH_1}`);
    expect(rec?.txHash).toBe(HASH_1);
    expect(rec?.read).toBe(false);
    expect(rec?.schemaVersion).toBe(0);
    expect(rec?.status).toBe("confirmed");
    expect(rec?.kind).toBe("send");
    expect(rec?.blockNumber).toBe(100);
    expect(rec?.amountDecimal).toBe("0.10");
    expect(typeof rec?.createdAtMs).toBe("number");
  });

  // ───────────────────────────────────────────────────────────────────────
  // Global inbox helpers (listAllNotifications +
  // markAllNotificationsRead). The Notifications page reads via these.
  // ───────────────────────────────────────────────────────────────────────

  it("listAllNotifications merges every scope and sorts newest-first by createdAtMs", async () => {
    const { recordNotification, listAllNotifications } = await import(
      "./notifications-store.js"
    );
    // Spread three records across two distinct scopes (addr × chain).
    // We can't pin createdAtMs directly because recordNotification stamps
    // Date.now(), but sequential awaits guarantee monotonically-increasing
    // timestamps — so the LAST insert must be at index 0 of the merged
    // list and the FIRST insert at the end.
    await recordNotification(
      baseInput({ addressLower: ADDR_A, chainIdHex: CHAIN_A, txHash: HASH_1 }),
    );
    // Small wait so the next record gets a strictly-later createdAtMs.
    await new Promise<void>((r) => setTimeout(r, 5));
    await recordNotification(
      baseInput({ addressLower: ADDR_B, chainIdHex: CHAIN_A, txHash: HASH_1 }),
    );
    await new Promise<void>((r) => setTimeout(r, 5));
    await recordNotification(
      baseInput({ addressLower: ADDR_A, chainIdHex: CHAIN_B, txHash: HASH_2 }),
    );

    const all = await listAllNotifications();
    expect(all).toHaveLength(3);
    // Newest-first: the LAST insert (ADDR_A / CHAIN_B / HASH_2) leads.
    expect(all[0]?.id).toBe(`${CHAIN_B}:${HASH_2}`);
    // Monotonic — the merged sort respects createdAtMs across scopes.
    expect(all[0]!.createdAtMs).toBeGreaterThanOrEqual(all[1]!.createdAtMs);
    expect(all[1]!.createdAtMs).toBeGreaterThanOrEqual(all[2]!.createdAtMs);
  });

  it("listAllNotifications returns [] when no history keys exist", async () => {
    const { listAllNotifications } = await import("./notifications-store.js");
    expect(await listAllNotifications()).toEqual([]);
  });

  it("markAllNotificationsRead flips every scope's records; second call returns 0", async () => {
    const {
      recordNotification,
      markAllNotificationsRead,
      listAllNotifications,
    } = await import("./notifications-store.js");
    // Plant 2 records on ADDR_A/CHAIN_A and 1 on ADDR_B/CHAIN_A.
    await recordNotification(
      baseInput({ addressLower: ADDR_A, chainIdHex: CHAIN_A, txHash: HASH_1 }),
    );
    await recordNotification(
      baseInput({ addressLower: ADDR_A, chainIdHex: CHAIN_A, txHash: HASH_2 }),
    );
    await recordNotification(
      baseInput({ addressLower: ADDR_B, chainIdHex: CHAIN_A, txHash: HASH_1 }),
    );

    const first = await markAllNotificationsRead();
    expect(first.flipped).toBe(3);
    const all = await listAllNotifications();
    expect(all.every((r) => r.read)).toBe(true);

    // Idempotent — a second call on an already-all-read inbox.
    const second = await markAllNotificationsRead();
    expect(second.flipped).toBe(0);
  });

  it("getUnread reflects markAllNotificationsRead → goes from N to 0", async () => {
    const {
      recordNotification,
      markAllNotificationsRead,
      getUnread,
    } = await import("./notifications-store.js");
    await recordNotification(
      baseInput({ addressLower: ADDR_A, chainIdHex: CHAIN_A, txHash: HASH_1 }),
    );
    await recordNotification(
      baseInput({ addressLower: ADDR_B, chainIdHex: CHAIN_A, txHash: HASH_1 }),
    );
    expect(await getUnread()).toBe(2);
    await markAllNotificationsRead();
    expect(await getUnread()).toBe(0);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Per-record click-to-mark-read. Wired from the
  // Notifications page when the user opens a notification's detail.
  // ───────────────────────────────────────────────────────────────────────

  it("markNotificationRead flips exactly that record (other records in the same scope untouched)", async () => {
    const {
      recordNotification,
      markNotificationRead,
      listAllNotifications,
    } = await import("./notifications-store.js");
    await recordNotification(
      baseInput({ addressLower: ADDR_A, chainIdHex: CHAIN_A, txHash: HASH_1 }),
    );
    await recordNotification(
      baseInput({ addressLower: ADDR_A, chainIdHex: CHAIN_A, txHash: HASH_2 }),
    );

    const r = await markNotificationRead(`${CHAIN_A}:${HASH_1}`);
    expect(r.flipped).toBe(true);

    const all = await listAllNotifications();
    const flipped = all.find((x) => x.id === `${CHAIN_A}:${HASH_1}`);
    const other = all.find((x) => x.id === `${CHAIN_A}:${HASH_2}`);
    expect(flipped?.read).toBe(true);
    // The other record in the SAME scope must remain unread.
    expect(other?.read).toBe(false);
  });

  it("markNotificationRead locates the right scope across multiple history blobs", async () => {
    const {
      recordNotification,
      markNotificationRead,
      listAllNotifications,
    } = await import("./notifications-store.js");
    // Seed across two distinct (addr, chain) scopes; target the second.
    await recordNotification(
      baseInput({ addressLower: ADDR_A, chainIdHex: CHAIN_A, txHash: HASH_1 }),
    );
    await recordNotification(
      baseInput({ addressLower: ADDR_B, chainIdHex: CHAIN_B, txHash: HASH_2 }),
    );

    const r = await markNotificationRead(`${CHAIN_B}:${HASH_2}`);
    expect(r.flipped).toBe(true);

    const all = await listAllNotifications();
    const aScope = all.find((x) => x.id === `${CHAIN_A}:${HASH_1}`);
    const bScope = all.find((x) => x.id === `${CHAIN_B}:${HASH_2}`);
    expect(aScope?.read).toBe(false);
    expect(bScope?.read).toBe(true);
  });

  it("markNotificationRead is idempotent — a second call on the same id is a no-op", async () => {
    const { recordNotification, markNotificationRead } = await import(
      "./notifications-store.js"
    );
    await recordNotification(
      baseInput({ addressLower: ADDR_A, chainIdHex: CHAIN_A, txHash: HASH_1 }),
    );
    const id = `${CHAIN_A}:${HASH_1}`;

    const first = await markNotificationRead(id);
    expect(first.flipped).toBe(true);

    // Pin a sentinel on a sibling storage key and confirm the no-op
    // does not touch storage (writeStorage was not called for this
    // second invocation).
    const sentinelKey = "mono.notifications.sentinel";
    storage[sentinelKey] = { schemaVersion: 0, entries: ["sentinel"] };

    const second = await markNotificationRead(id);
    expect(second.flipped).toBe(false);
    expect(storage[sentinelKey]).toEqual({
      schemaVersion: 0,
      entries: ["sentinel"],
    });
  });

  it("markNotificationRead returns flipped:false for an unknown id and writes nothing", async () => {
    const { recordNotification, markNotificationRead } = await import(
      "./notifications-store.js"
    );
    await recordNotification(
      baseInput({ addressLower: ADDR_A, chainIdHex: CHAIN_A, txHash: HASH_1 }),
    );
    const r = await markNotificationRead(`${CHAIN_A}:0xffffffffffff`);
    expect(r.flipped).toBe(false);
  });

  it("getUnread decrements by exactly one after a per-record flip", async () => {
    const { recordNotification, markNotificationRead, getUnread } = await import(
      "./notifications-store.js"
    );
    await recordNotification(
      baseInput({ addressLower: ADDR_A, chainIdHex: CHAIN_A, txHash: HASH_1 }),
    );
    await recordNotification(
      baseInput({ addressLower: ADDR_A, chainIdHex: CHAIN_A, txHash: HASH_2 }),
    );
    await recordNotification(
      baseInput({ addressLower: ADDR_B, chainIdHex: CHAIN_B, txHash: HASH_1 }),
    );
    expect(await getUnread()).toBe(3);

    const r = await markNotificationRead(`${CHAIN_A}:${HASH_1}`);
    expect(r.flipped).toBe(true);
    expect(await getUnread()).toBe(2);

    // Second call → already-read → no further decrement.
    await markNotificationRead(`${CHAIN_A}:${HASH_1}`);
    expect(await getUnread()).toBe(2);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Presence-aware read at insert. `input.read` defaults false
  // (today's behavior); `true` ⇒ the record lands already-read (no unread).
  // ───────────────────────────────────────────────────────────────────────

  it("read:true → record.read true + getUnread does NOT count it", async () => {
    const { recordNotification, getUnread } = await import(
      "./notifications-store.js"
    );
    const r = await recordNotification({ ...baseInput(), read: true });
    expect(r.added).toBe(true);
    expect(r.record?.read).toBe(true);
    expect(await getUnread()).toBe(0);
  });

  it("read omitted → record.read false (default) + getUnread counts it", async () => {
    const { recordNotification, getUnread } = await import(
      "./notifications-store.js"
    );
    const r = await recordNotification(baseInput());
    expect(r.record?.read).toBe(false);
    expect(await getUnread()).toBe(1);
  });

  it("writes the in-app record regardless of notification settings (settings gate only surfaces)", async () => {
    // recordNotification takes NO notification-settings input — the
    // show-details / notify-when-locked / badge-when-locked toggles live in
    // notifications-os and gate ONLY fireOsNotification / refreshUnreadBadge.
    // So the durable in-app record is always written (§0.4), even when the
    // toast is suppressed and the badge is held.
    const { recordNotification, listNotifications } = await import(
      "./notifications-store.js"
    );
    const r = await recordNotification(baseInput());
    expect(r.added).toBe(true);
    const list = await listNotifications(ADDR_A, CHAIN_A);
    expect(list).toHaveLength(1);
  });

  // ───────────────────────────────────────────────────────────────────────
  // S6 #44 B3 — active-address display scoping (3-way contract:
  // undefined → global · null → empty · address → that address only).
  // ───────────────────────────────────────────────────────────────────────

  it("B3: with vault A active, listAllNotifications excludes vault B's records (undefined stays global)", async () => {
    const { recordNotification, listAllNotifications } = await import(
      "./notifications-store.js"
    );
    await recordNotification(
      baseInput({ addressLower: ADDR_A, chainIdHex: CHAIN_A, txHash: HASH_1 }),
    );
    await recordNotification(
      baseInput({ addressLower: ADDR_B, chainIdHex: CHAIN_A, txHash: HASH_2 }),
    );
    const scoped = await listAllNotifications(ADDR_A);
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.id).toBe(`${CHAIN_A}:${HASH_1}`); // B's record is hidden
    // Legacy global (no arg) still merges both — existing callers unchanged.
    expect(await listAllNotifications()).toHaveLength(2);
  });

  it("B3: the active-address scope keeps EVERY chain for that address (no same-vault hiding)", async () => {
    const { recordNotification, listAllNotifications } = await import(
      "./notifications-store.js"
    );
    await recordNotification(
      baseInput({ addressLower: ADDR_A, chainIdHex: CHAIN_A, txHash: HASH_1 }),
    );
    await recordNotification(
      baseInput({ addressLower: ADDR_A, chainIdHex: CHAIN_B, txHash: HASH_2 }),
    );
    await recordNotification(
      baseInput({ addressLower: ADDR_B, chainIdHex: CHAIN_A, txHash: HASH_1 }),
    );
    const scoped = await listAllNotifications(ADDR_A);
    expect(scoped).toHaveLength(2); // both of A's chains, none of B's
    expect(scoped.map((r) => r.id).sort()).toEqual(
      [`${CHAIN_A}:${HASH_1}`, `${CHAIN_B}:${HASH_2}`].sort(),
    );
  });

  it("B3: null (locked / no active vault) → empty inbox + zero unread, no throw", async () => {
    const { recordNotification, listAllNotifications, getUnread } = await import(
      "./notifications-store.js"
    );
    await recordNotification(baseInput({ addressLower: ADDR_A, txHash: HASH_1 }));
    expect(await listAllNotifications(null)).toEqual([]);
    expect(await getUnread(null)).toBe(0);
  });

  it("B3: getUnread scopes the count to the active address (badge matches the inbox)", async () => {
    const { recordNotification, getUnread } = await import(
      "./notifications-store.js"
    );
    await recordNotification(
      baseInput({ addressLower: ADDR_A, chainIdHex: CHAIN_A, txHash: HASH_1 }),
    );
    await recordNotification(
      baseInput({ addressLower: ADDR_A, chainIdHex: CHAIN_B, txHash: HASH_2 }),
    );
    await recordNotification(
      baseInput({ addressLower: ADDR_B, chainIdHex: CHAIN_A, txHash: HASH_1 }),
    );
    expect(await getUnread(ADDR_A)).toBe(2); // A's two chains
    expect(await getUnread(ADDR_B)).toBe(1); // B's one
    expect(await getUnread()).toBe(3); // global (legacy)
  });

  it("B3: markAllNotificationsRead(A) flips ONLY A — B's records stay unread (display-scoping)", async () => {
    const { recordNotification, markAllNotificationsRead, getUnread } =
      await import("./notifications-store.js");
    await recordNotification(
      baseInput({ addressLower: ADDR_A, chainIdHex: CHAIN_A, txHash: HASH_1 }),
    );
    await recordNotification(
      baseInput({ addressLower: ADDR_B, chainIdHex: CHAIN_A, txHash: HASH_2 }),
    );
    const r = await markAllNotificationsRead(ADDR_A);
    expect(r.flipped).toBe(1); // only A's record
    expect(await getUnread(ADDR_A)).toBe(0);
    expect(await getUnread(ADDR_B)).toBe(1); // B untouched on disk
    expect(await getUnread()).toBe(1); // global: only B's unread remains
  });

  it("B3: markNotificationRead(id, A) refuses to flip a record outside A's scope", async () => {
    const { recordNotification, markNotificationRead, getUnread } = await import(
      "./notifications-store.js"
    );
    // B owns this id; A is the active scope → the scan skips B's key → not found.
    await recordNotification(
      baseInput({ addressLower: ADDR_B, chainIdHex: CHAIN_A, txHash: HASH_1 }),
    );
    const r = await markNotificationRead(`${CHAIN_A}:${HASH_1}`, ADDR_A);
    expect(r.flipped).toBe(false);
    expect(await getUnread()).toBe(1); // B's record still unread on disk
  });

  // ── C3 — concurrent recordNotification serialization (lost-update + dup) ──

  it("C3: two CONCURRENT records (distinct txHashes, one scope) BOTH land — no lost update", async () => {
    const { recordNotification, listNotifications } = await import(
      "./notifications-store.js"
    );
    // Fired without awaiting between them → their read-modify-writes interleave.
    // Without the per-key lock, both would read an empty history and the second
    // write would clobber the first. The lock serializes them.
    const [r1, r2] = await Promise.all([
      recordNotification(baseInput({ txHash: HASH_1 })),
      recordNotification(baseInput({ txHash: HASH_2 })),
    ]);
    expect(r1.added).toBe(true);
    expect(r2.added).toBe(true);
    const entries = await listNotifications(ADDR_A, CHAIN_A);
    expect(entries.map((e) => e.txHash).sort()).toEqual([HASH_1, HASH_2].sort());
  });

  it("C3: two CONCURRENT records of the SAME txHash → exactly one record, no duplicate", async () => {
    const { recordNotification, listNotifications } = await import(
      "./notifications-store.js"
    );
    const [r1, r2] = await Promise.all([
      recordNotification(baseInput({ txHash: HASH_1 })),
      recordNotification(baseInput({ txHash: HASH_1 })),
    ]);
    // Exactly one wins the dedup; the other is a no-op (no double history row,
    // no double toast).
    expect([r1.added, r2.added].filter(Boolean)).toHaveLength(1);
    const entries = await listNotifications(ADDR_A, CHAIN_A);
    expect(entries).toHaveLength(1);
  });

  it("C3: FIVE concurrent records (burst, distinct txHashes) all land", async () => {
    const { recordNotification, listNotifications } = await import(
      "./notifications-store.js"
    );
    const hashes = Array.from(
      { length: 5 },
      (_, i) => "0x" + i.toString(16).padStart(2, "0").repeat(32),
    );
    const results = await Promise.all(
      hashes.map((txHash) => recordNotification(baseInput({ txHash }))),
    );
    expect(results.every((r) => r.added)).toBe(true);
    const entries = await listNotifications(ADDR_A, CHAIN_A);
    expect(entries.map((e) => e.txHash).sort()).toEqual([...hashes].sort());
  });
});
