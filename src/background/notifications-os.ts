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

/** Phase 5 — user-facing toggle key. The flag gates ONLY the OS toast
 *  (chrome.notifications.create). The in-app notification history record
 *  AND the unread badge run regardless — the notifications center stays
 *  the durable record (§0.4). Default true (absent ⇒ on); fail-open on a
 *  storage read error so a corrupt blob can never silently mute the
 *  user. */
const OS_ENABLED_KEY = "mono.notifications.os-enabled.v1";

/** Read the OS-toast enabled flag. Default `true` (absent key ⇒ on).
 *  Fails open: a chrome.storage error returns `true` so a transient
 *  read failure can't silently mute the user. */
export async function getOsNotificationsEnabled(): Promise<boolean> {
  try {
    if (typeof chrome === "undefined" || !chrome.storage?.local?.get) {
      return true;
    }
    const v = await new Promise<unknown>((resolve) => {
      chrome.storage.local.get([OS_ENABLED_KEY], (res) =>
        resolve(res?.[OS_ENABLED_KEY]),
      );
    });
    if (v === undefined) return true;
    return v !== false;
  } catch {
    return true;
  }
}

/** Persist the OS-toast enabled flag. Best-effort. */
export async function setOsNotificationsEnabled(
  enabled: boolean,
): Promise<void> {
  try {
    if (typeof chrome === "undefined" || !chrome.storage?.local?.set) {
      return;
    }
    await new Promise<void>((resolve) => {
      chrome.storage.local.set({ [OS_ENABLED_KEY]: !!enabled }, () => resolve());
    });
  } catch {
    // Best-effort.
  }
}

// GAP-N1 settings — three additional user-facing notification toggles, all
// default ON (absent ⇒ true) and fail-open (a read error ⇒ true) exactly like
// the Phase-5 os-enabled flag. Local-only. They gate only the on-screen
// surfaces (the OS toast + the toolbar badge), NEVER the in-app history record
// (§0.4 — recordNotification always writes).
const SHOW_DETAILS_KEY = "mono.notifications.show-details.v1";
const NOTIFY_WHEN_LOCKED_KEY = "mono.notifications.notify-when-locked.v1";
const BADGE_WHEN_LOCKED_KEY = "mono.notifications.badge-when-locked.v1";

/** Default-true, fail-open boolean setting read (mirrors the os-enabled
 *  semantics: absent key ⇒ true; a chrome.storage error ⇒ true, so a
 *  transient failure never silently mutes the user). */
async function getBoolSetting(key: string): Promise<boolean> {
  try {
    if (typeof chrome === "undefined" || !chrome.storage?.local?.get) {
      return true;
    }
    const v = await new Promise<unknown>((resolve) => {
      chrome.storage.local.get([key], (res) => resolve(res?.[key]));
    });
    return v === undefined ? true : v !== false;
  } catch {
    return true;
  }
}

/** Persist a boolean setting. Best-effort. */
async function setBoolSetting(key: string, enabled: boolean): Promise<void> {
  try {
    if (typeof chrome === "undefined" || !chrome.storage?.local?.set) {
      return;
    }
    await new Promise<void>((resolve) => {
      chrome.storage.local.set({ [key]: !!enabled }, () => resolve());
    });
  } catch {
    // Best-effort.
  }
}

/** "Show transaction details" — when off, toasts carry a generic body
 *  (no amount/address/op). Default true. */
export const getShowDetails = (): Promise<boolean> =>
  getBoolSetting(SHOW_DETAILS_KEY);
export const setShowDetails = (enabled: boolean): Promise<void> =>
  setBoolSetting(SHOW_DETAILS_KEY, enabled);

/** "Notify while locked" — when off, no OS toast fires for a tx that
 *  confirms while the wallet is locked (the record + badge still update).
 *  Default true. */
export const getNotifyWhenLocked = (): Promise<boolean> =>
  getBoolSetting(NOTIFY_WHEN_LOCKED_KEY);
export const setNotifyWhenLocked = (enabled: boolean): Promise<void> =>
  setBoolSetting(NOTIFY_WHEN_LOCKED_KEY, enabled);

/** "Unread badge while locked" — when off, the toolbar count is held (not
 *  surfaced) while locked; it appears on unlock. Default true. */
export const getBadgeWhenLocked = (): Promise<boolean> =>
  getBoolSetting(BADGE_WHEN_LOCKED_KEY);
export const setBadgeWhenLocked = (enabled: boolean): Promise<void> =>
  setBoolSetting(BADGE_WHEN_LOCKED_KEY, enabled);

/** GAP-N1 / polish C3 — true when at least one POPUP or SIDE_PANEL wallet
 *  surface is currently open. Used at notification-record time to set the
 *  `read` flag: a surface open at observe-time means the user is present
 *  (record as read, no badge bump); closed ⇒ accumulate unread. Defaults
 *  FALSE on any error / missing API (Chrome < 116) so an unrecognized
 *  environment behaves as "closed" — it never silently mutes the unread
 *  state. Full-view (`?mode=fullscreen`) is a normal tab, NOT a
 *  POPUP/SIDE_PANEL context, so it reads as closed (by design). */
export async function isWalletSurfaceOpen(): Promise<boolean> {
  try {
    if (
      typeof chrome === "undefined" ||
      typeof chrome.runtime?.getContexts !== "function"
    ) {
      return false;
    }
    const ctxs = await chrome.runtime.getContexts({
      contextTypes: ["POPUP", "SIDE_PANEL"] as chrome.runtime.ContextType[],
    });
    return Array.isArray(ctxs) && ctxs.length > 0;
  } catch {
    return false;
  }
}

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
 *  internally so it can never break the SW snapshot path.
 *
 *  Phase 5 — gated by the user-facing OS-enabled flag: when off, the
 *  toast is skipped entirely (history + badge still run on the caller
 *  side; the notifications center remains the durable record). */
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
    const enabled = await getOsNotificationsEnabled();
    if (!enabled) return;
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
