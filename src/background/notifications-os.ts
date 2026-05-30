// Phase 2 — OS toast + unread badge layer on top of the Phase-1
// notifications core.
//
// What this module owns
// =====================
// Three best-effort helpers the SW chokepoint hook + the SW boot path
// call. Every helper is internally try/catch'd: an OS-deny / disabled-
// notification / API-quirk error MUST swallow silently — the Phase-1
// history record + the badge readback are still authoritative on disk,
// and a popup-side UI surface (Phase 3) reads them. The OS toast is a
// notification *amplifier*, not the system of record.
//
//   - `fireOsNotification(record)` — calls `chrome.notifications.create`
//     with the friendly title from `notificationTitle(kind, status)` (so
//     a confirmed delegate reads "Staked", a failed send reads "Send
//     failed", etc.). Body = "<amount> LYTH · <short-bech32m-counterparty>"
//     (amount omitted on zero / empty so a 0-LYTH claim reads cleanly).
//   - `refreshUnreadBadge()` — reads the derived `getUnread()` count from
//     `notifications-store.ts` and forwards it to
//     `chrome.action.setBadgeText`. Used after every recordNotification
//     batch + once at SW startup so the toolbar pip is correct after a
//     MV3 SW re-init.
//   - `installNotificationsClickListener()` — registers
//     `chrome.notifications.onClicked` at the SW top level (MV3 re-inits
//     the SW per event; late-registered listeners get missed). Click →
//     parse the canonical inner tx hash off the notification id and open
//     Monoscan in a new tab.
//
// §0 invariants enforced here
// ===========================
// §0.4 — every entry point is keyed off a `NotificationRecord` produced
//        by `recordNotification` (the wallet's own tracked-tx registry).
//        This module never synthesises content from page/dapp/IPC input.
// §0.6 — the toast `message` carries ONLY the amount + short bech32m
//        counterparty. NO mnemonic, NO pubkey, NO signature, NO
//        address-book name (which could leak a contact list).

import { monoscanTxUrl } from "../shared/build-info.js";
import { bech32mDisplay } from "../shared/bech32m.js";
import {
  notificationTitle,
  type NotificationRecord,
} from "../shared/notifications.js";
import { getUnread } from "./notifications-store.js";

/** Packaged icon path used for every OS toast. MUST be a string (not an
 *  `Image` object — there is no `Image` global in a Manifest V3 service
 *  worker, so passing one throws `ReferenceError` at runtime). */
const NOTIFICATION_ICON_URL = "icon-48.png";

/** Toolbar badge color when an unread count is shown. Tracks the project's
 *  attention-red used elsewhere (`var(--err)` family ≈ `#dc5050`). */
const BADGE_BG_COLOR = "#dc5050";

/** Middle-truncate any string (bech32m address or hash) for compact
 *  display. Pure — never throws. Mirrors the helper in
 *  `popup/components/ActivityDetail.tsx` so the toast body reads the
 *  same as the activity-detail counterparty cell. */
function truncMiddle(s: string, head = 10, tail = 6): string {
  return s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
}

/** Render a record's `counterparty` (stored as lowercase 0x) for the
 *  toast body. Uses the SAFE `bech32mDisplay` (never throws — returns
 *  the input on non-0x) + a pure `truncMiddle` — never the strict
 *  `shortBech32m`, which throws on non-0x input (the Phase-1 indexer
 *  returns counterparties as bech32m on some paths). */
function shortCounterparty(counterparty: string): string {
  return truncMiddle(bech32mDisplay(counterparty));
}

/** True for amount strings that mean "zero LYTH" — we omit the amount
 *  from the body in this case so a 0-LYTH claim/agent-policy tx reads
 *  cleanly as just the counterparty. */
function isZeroAmount(amountDecimal: string): boolean {
  if (amountDecimal.length === 0) return true;
  // Tolerate the canonical formatter's outputs: "0", "0.00", "0.0000",
  // etc. A non-zero LYTH amount always has at least one non-zero digit.
  return /^0(\.0+)?$/.test(amountDecimal);
}

/** Build the user-facing toast body for one record. Public so tests can
 *  pin the wording without rendering the toast itself. */
export function notificationBody(record: NotificationRecord): string {
  const short = shortCounterparty(record.counterparty);
  if (isZeroAmount(record.amountDecimal)) {
    return short;
  }
  return `${record.amountDecimal} LYTH · ${short}`;
}

/** Fire one OS toast for a freshly-recorded notification. Best-effort:
 *  any `chrome.notifications.create` failure (API absent / OS-denied /
 *  user disabled / quota / unsupported environment) is swallowed
 *  internally so it can never break the SW snapshot path. */
export async function fireOsNotification(
  record: NotificationRecord,
): Promise<void> {
  try {
    if (
      typeof chrome === "undefined" ||
      typeof chrome.notifications?.create !== "function"
    ) {
      return;
    }
    const title = notificationTitle(record.kind, record.status);
    const message = notificationBody(record);
    // `chrome.notifications.create` returns a Promise in MV3 — wrap with
    // try/catch so a rejection (rare, but happens on some platforms when
    // the user has blocked notifications globally) doesn't escape.
    await chrome.notifications.create(record.id, {
      type: "basic",
      iconUrl: NOTIFICATION_ICON_URL,
      title,
      message,
    });
  } catch {
    // Swallowed by design — history + badge remain the durable record.
  }
}

/** Recompute the toolbar unread badge from `getUnread()` and push it to
 *  `chrome.action.setBadgeText`. Empty string clears the pip (per the
 *  chrome.action contract). Best-effort. */
export async function refreshUnreadBadge(): Promise<void> {
  try {
    if (
      typeof chrome === "undefined" ||
      typeof chrome.action?.setBadgeText !== "function"
    ) {
      return;
    }
    const n = await getUnread();
    const text = n > 0 ? String(n) : "";
    await chrome.action.setBadgeText({ text });
    if (
      n > 0 &&
      typeof chrome.action.setBadgeBackgroundColor === "function"
    ) {
      await chrome.action.setBadgeBackgroundColor({ color: BADGE_BG_COLOR });
    }
  } catch {
    // Best-effort. A badge-update failure leaves the prior pip stale,
    // which is harmless — the next successful refresh corrects it.
  }
}

/** Pure helper — derive the canonical inner tx hash from a notification
 *  id. The id is `${chainIdHex}:${txHash}` (see `shared/notifications.ts`).
 *  Returns `null` when the id doesn't contain a parseable 0x txHash, so
 *  the caller can short-circuit without opening a bad Monoscan URL. */
export function parseTxHashFromNotificationId(id: string): string | null {
  const idx = id.indexOf(":");
  const tail = idx >= 0 ? id.slice(idx + 1) : id;
  return tail.startsWith("0x") ? tail : null;
}

/** Click handler logic, split out from the listener registration so it's
 *  unit-testable without invoking the runtime listener registry. */
export async function handleNotificationClick(
  notificationId: string,
): Promise<void> {
  try {
    const txHash = parseTxHashFromNotificationId(notificationId);
    if (txHash !== null && typeof chrome?.tabs?.create === "function") {
      await chrome.tabs.create({ url: monoscanTxUrl(txHash) });
    }
    if (typeof chrome?.notifications?.clear === "function") {
      await chrome.notifications.clear(notificationId);
    }
  } catch {
    // Best-effort.
  }
}

/** Install the top-level `chrome.notifications.onClicked` listener.
 *  MUST be called at the SW module's top level (not from inside an
 *  async path) so a per-event SW re-init re-registers the listener
 *  before the click event is delivered. */
export function installNotificationsClickListener(): void {
  if (
    typeof chrome === "undefined" ||
    typeof chrome.notifications?.onClicked?.addListener !== "function"
  ) {
    return;
  }
  chrome.notifications.onClicked.addListener((notificationId) => {
    void handleNotificationClick(notificationId);
  });
}
