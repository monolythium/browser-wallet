// Phase 1 — `chrome.storage.local`-backed notification store.
//
// What this module owns
// =====================
// The minimal storage round-trip the SW chokepoint hook needs to record
// one `NotificationRecord` per tracked-tx terminal transition, and the
// minimal read-side helpers Phases 2 + 3 will call:
//   - `recordNotification(input)` — dedupe-check via the notified set,
//     append (capped, newest-first) to history, return whether the entry
//     was new. Best-effort: every chrome.storage failure is swallowed
//     internally so the caller (the post-write microtask in
//     `service-worker.ts`) can NEVER propagate an error back into the
//     activity-snapshot response path.
//   - `listNotifications(addr, chain)` — newest-first read of the
//     per-scope history. Phase 3's Notifications page reads this.
//   - `markAllRead(addr, chain)` — flip every entry's `read` to `true`
//     in a scope. Phase 3 wires the "Mark all as read" CTA here.
//   - `getUnread()` — derived global count across all
//     `mono.notifications.history.*` keys (no separate counter key, no
//     desync risk). Phase 2 calls this to drive
//     `chrome.action.setBadgeText`.
//
// §0.4 — `recordNotification` is NOT exported through any IPC handler in
// Phase 1. The wallet-only invariant is enforced by keeping the call
// site to a single SW chokepoint that iterates the wallet's own pending
// rows; no dapp / page / popup path can synthesize a notification.

import {
  NOTIFICATION_HISTORY_CAP,
  appendCapped,
  notificationId,
  notificationsHistoryKey,
  notifiedSetKey,
  parseHistoryEnvelope,
  parseNotifiedSetEnvelope,
  type NotificationRecord,
  type TxOpKind,
} from "../shared/notifications.js";

async function readStorage(key: string): Promise<unknown> {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (res) => resolve(res?.[key]));
  });
}

async function readAllStorage(): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (res) => resolve(res ?? {}));
  });
}

async function writeStorage(entries: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set(entries, () => resolve());
  });
}

/** Input shape for the chokepoint hook — every field is already pre-
 *  normalized at the call site (status as the literal `"confirmed"` or
 *  `"failed"`, blockNumber as a finite number or null, etc.). */
export interface RecordNotificationInput {
  addressLower: string;
  chainIdHex: string;
  txHash: string;
  status: "confirmed" | "failed";
  blockNumber: number | null;
  /** Phase 1.5 — full TxOpKind union. The Phase-1 coarse literals
   *  ("send", "contract_call") remain valid and are the fallbacks the
   *  hook uses when the pending row carries no broadcast-time `opKind`. */
  kind: TxOpKind;
  amountDecimal: string;
  counterparty: string;
}

/** Append a notification for a tracked-tx terminal transition.
 *
 *  Idempotent on `(addressLower, chainIdHex, txHash)`: a second call
 *  returns `{ added: false, record: null }` without re-writing history
 *  (Phase-1 §0.5 — the persisted notified-set survives SW restarts so a
 *  reinit can neither re-fire nor lose dedupe state).
 *
 *  Best-effort: any `chrome.storage` failure is swallowed and reported as
 *  `{ added: false, record: null }`. A notification-write failure must
 *  never break the activity-snapshot response.
 *
 *  §0.2: `status` is taken verbatim from the input — this function never
 *  coerces "failed" to "confirmed" or vice versa. The upstream P2.A
 *  refactor of `dropConfirmedPendingByHash` is responsible for producing
 *  the right literal. */
export async function recordNotification(
  input: RecordNotificationInput,
): Promise<{ added: boolean; record: NotificationRecord | null }> {
  try {
    const id = notificationId(input.chainIdHex, input.txHash);
    const setKey = notifiedSetKey(input.addressLower, input.chainIdHex);
    const seen = parseNotifiedSetEnvelope(await readStorage(setKey)) ?? {
      schemaVersion: 0 as const,
      ids: [],
    };
    if (seen.ids.includes(id)) return { added: false, record: null };

    const record: NotificationRecord = {
      id,
      txHash: input.txHash,
      status: input.status,
      blockNumber: input.blockNumber,
      kind: input.kind,
      amountDecimal: input.amountDecimal,
      counterparty: input.counterparty,
      createdAtMs: Date.now(),
      read: false,
      schemaVersion: 0,
    };

    const historyKey = notificationsHistoryKey(
      input.addressLower,
      input.chainIdHex,
    );
    const history = parseHistoryEnvelope(await readStorage(historyKey)) ?? {
      schemaVersion: 0 as const,
      entries: [],
    };
    const nextEntries = appendCapped(
      history.entries,
      record,
      NOTIFICATION_HISTORY_CAP,
    );

    await writeStorage({
      [historyKey]: { schemaVersion: 0, entries: nextEntries },
      [setKey]: { schemaVersion: 0, ids: [...seen.ids, id] },
    });

    return { added: true, record };
  } catch {
    return { added: false, record: null };
  }
}

/** Per-scope read of the notification history, newest-first. Empty list
 *  on parse failure / missing key. */
export async function listNotifications(
  addressLower: string,
  chainIdHex: string,
): Promise<NotificationRecord[]> {
  try {
    const env = parseHistoryEnvelope(
      await readStorage(notificationsHistoryKey(addressLower, chainIdHex)),
    );
    return env?.entries ?? [];
  } catch {
    return [];
  }
}

/** Flip every record's `read` to `true` in the given scope. Returns the
 *  count of records that changed (already-read records do not count).
 *  Idempotent: a second call on an all-read scope returns
 *  `{ flipped: 0 }` and writes nothing. */
export async function markAllRead(
  addressLower: string,
  chainIdHex: string,
): Promise<{ flipped: number }> {
  try {
    const key = notificationsHistoryKey(addressLower, chainIdHex);
    const env = parseHistoryEnvelope(await readStorage(key));
    if (!env) return { flipped: 0 };
    let flipped = 0;
    const next = env.entries.map((r) => {
      if (r.read) return r;
      flipped++;
      return { ...r, read: true };
    });
    if (flipped > 0) {
      await writeStorage({ [key]: { schemaVersion: 0, entries: next } });
    }
    return { flipped };
  } catch {
    return { flipped: 0 };
  }
}

/** Derived global unread count = sum of `!read` across every
 *  `mono.notifications.history.*` history blob. Single source of truth
 *  (no separate counter key → no sync hazard). */
export async function getUnread(): Promise<number> {
  try {
    const all = await readAllStorage();
    let total = 0;
    for (const [k, v] of Object.entries(all)) {
      if (!k.startsWith("mono.notifications.history.")) continue;
      const env = parseHistoryEnvelope(v);
      if (!env) continue;
      for (const r of env.entries) if (!r.read) total++;
    }
    return total;
  } catch {
    return 0;
  }
}
