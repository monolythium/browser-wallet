import type { CurrencyCode } from "./iso4217";

export const AUTO_LOCK_MINUTES_DEFAULT = 15;
export const AUTO_LOCK_OPTIONS = [5, 15, 30, 60] as const;

/** The exact word the user types to confirm the destructive no-re-auth wipe.
 *  Single source for the SW verify (P4-004) + both confirm screens. */
export const WIPE_CONFIRM_WORD = "DELETE";

export const ALARM_AUTO_LOCK = "monolythium.autolock";

/** Periodic poll that runs `pollPendingAndNotify` while any tx is
 *  pending, so a transaction confirming while every wallet surface is closed
 *  still toasts + badges at confirm time. Self-limiting: created when the
 *  pending set becomes non-empty, cleared when it empties. */
export const ALARM_NOTIF_POLL = "monolythium.notif-poll";

/** Periodic reaper that rejects any dApp approval older than APPROVAL_TTL_MS
 *  (P4-001 D1b). Self-limiting like ALARM_NOTIF_POLL: armed when an approval is
 *  enqueued, cleared when the bus drains. */
export const ALARM_APPROVAL_REAP = "monolythium.approval-reap";
/** A pending approval older than this is auto-rejected. 3 min: generous for a
 *  user to act on a VISIBLE prompt (incl. reading a complex EIP-712 payload),
 *  while bounding a forgotten / flooded approval. Kept <= the 5-min shortest
 *  AUTO_LOCK_OPTIONS value so the reaper is the tighter independent bound in
 *  every auto-lock config. */
export const APPROVAL_TTL_MS = 180_000;

// chrome.storage.local
export const STORAGE_KEY_AUTO_LOCK_MINUTES = "mono.autoLockMinutes";
export const STORAGE_KEY_PENDING_APPROVALS = "mono.pending-approvals";
export const STORAGE_KEY_CONNECTED_SITES = "mono.connected-sites";
// Multi-vault container. Keep in sync with VAULTS_CONTAINER_KEY_V4 in
// src/background/keystore-mldsa.ts; the popup mirrors this key in its
// chrome.storage.onChanged listener so vault-create / vault-import /
// vault-select propagate to the UI without IPC plumbing.
export const STORAGE_KEY_VAULTS_CONTAINER_V4 = "mono.vaults.v4";
// Contacts (address book). Keyed by lowercase 0x
// address; value is a ContactRecord (see src/background/contacts.ts).
// Mirrored to the popup via chrome.storage.onChanged.
export const STORAGE_KEY_CONTACTS = "mono.contacts.v1";
// UI open mode. The SW reads this on boot + on every
// chrome.storage.onChanged event to bind action-icon click to either
// the side-panel or the popup. Default "sidepanel" matches modern
// wallet UX (MetaMask Flask, Phantom, Rabby).
export const STORAGE_KEY_UI_OPEN_MODE = "mono.ui.open-mode";
export const UI_OPEN_MODE_VALUES = ["sidepanel", "popup"] as const;
export type UiOpenMode = (typeof UI_OPEN_MODE_VALUES)[number];
export const UI_OPEN_MODE_DEFAULT: UiOpenMode = "sidepanel";

// UI language. Display-only and popup-consumed; no service-worker behavior
// depends on it (unlike open-mode, which the SW reads on boot to bind the
// action-icon click). A placeholder for future locales — only English (US)
// ships today, so there is nothing to switch between yet. Read/validated via
// src/popup/display-prefs.ts.
export const STORAGE_KEY_LANGUAGE = "mono.ui.language";
export const LANGUAGE_VALUES = ["en-US"] as const;
export type LanguageCode = (typeof LANGUAGE_VALUES)[number];
export const LANGUAGE_DEFAULT: LanguageCode = "en-US";

// Display currency (ISO-4217). STORED PREFERENCE ONLY — no value renders today
// (no LYTH->fiat oracle exists). The curated code set + per-currency minor-unit
// precision live in ./iso4217; this is just the storage key + default.
export const STORAGE_KEY_DISPLAY_CURRENCY = "mono.ui.display-currency";
export const DISPLAY_CURRENCY_DEFAULT: CurrencyCode = "USD";

// chrome.storage.session
export const SESSION_KEY_AUTO_LOCK_DEADLINE = "autoLockDeadline";
export const SESSION_KEY_WALLET_LOCKED = "walletLocked";
export const SESSION_KEY_UNLOCK_FAIL_COUNT = "unlockFailCount";
export const SESSION_KEY_UNLOCK_LOCKOUT_UNTIL = "unlockLockoutUntil";
// MEK (master encryption key) cache for cross-SW-
// hibernation rehydrate. chrome.storage.session is in-memory only and
// cleared on browser restart, so this never persists to disk. On SW
// reboot, keystore-mldsa.ts reads this back and unwraps the active
// vault without prompting for the password. Cleared on lock /
// auto-lock fire / wipe.
export const SESSION_KEY_MEK_V4 = "mono.session.mek.v4";
// T1-03 (Item B) — hard cap on the password-less session-MEK rehydrate window,
// independent of the (user-configurable, up to 60 min) auto-lock window. The
// deadline is written when the MEK is persisted AND refreshed on every genuine
// user action (resetAutoLock), so the window slides to "MEK_REHYDRATE_MAX_MINUTES
// since last activity". Once past it, tryRestoreFromSessionV4 refuses and wipes
// the session MEK, forcing a fresh password unlock. Bounds the local/evil-maid
// re-unlock window without retyping the password during continuous use.
export const SESSION_KEY_MEK_REHYDRATE_DEADLINE =
  "mono.session.mek.rehydrate.deadline";
export const MEK_REHYDRATE_MAX_MINUTES = 5;

// Highest threshold first so lockoutMsFor() returns the longest matching window.
export const LOCKOUT_THRESHOLDS = [
  { fails: 20, ms: 30 * 60_000 },
  { fails: 10, ms: 5 * 60_000 },
  { fails: 5, ms: 30_000 },
] as const;

// Exempt set — ops that do NOT bump the auto-lock deadline.
//
// The rule: an op belongs in this set only if it represents PASSIVE
// activity (background polling, read-only surface mounts, infra
// keepalives) OR if the handler itself calls resetAutoLock()
// explicitly (keystore-* ops self-manage).
//
// Fixes the regression where actively clicking Revoke or editing contacts
// did not extend the auto-lock deadline: an earlier change added revoke-* and contacts-add/
// remove/rename to this set with the rationale "labelling shouldn't
// bump." That rationale was wrong from a user-perspective POV: when
// the user is actively clicking Revoke on Connected Sites or editing
// contacts in the address book, they ARE using the wallet, and the
// auto-lock deadline must extend. Without the bump, the wallet
// locked at the configured time despite the user being mid-task —
// which read as "premature lock".
//
// browser-wallet-old (reference repo) has just 5 exempt ops, all
// strictly read-only polls (KEYRING_GET_STATE, GET_AUTO_LOCK,
// GET_PENDING_APPROVAL, GET_CONNECTED_SITES, MONITOR_INCOMING_
// TRANSFERS). Our larger set is mostly polling-equivalent (chain
// reads, indexer reads, WS infra, approval-queue reads); the
// user-action ops that crept in are the bug fixed here.
//
// To debug a future regression: an op is wrongly EXEMPT if a user-
// initiated action triggers it (any click in the popup that mutates
// chrome.storage.local outside the keystore container). An op is
// wrongly NON-EXEMPT if it's polled at a fixed interval by
// useEffect without user input.
export const AUTO_LOCK_EXEMPT_OPS: ReadonlySet<string> = new Set([
  "keystore-status",
  "get-auto-lock-minutes",
  "wallet-active-account",
  "wallet-balance",
  "wallet-fee-suggestion",
  "wallet-active-chain",
  "chain-list",
  "wallet-operator-status",
  "wallet-chain-block-number",
  "wallet-indexer-snapshot",
  "testnet-operators-get",
  "testnet-operators-health",
  // WS infra polls are passive: status reads and
  // fire-and-forget subscribe don't represent user activity.
  "ws-status",
  "ws-subscribe-new-heads",
  // AddressActivityKind probe is passive metadata
  // (used by the activity feed to render empty-state context).
  "wallet-activity-kind",
  // Background refreshers fired on a fixed setInterval WITHOUT user input (the App
  // balance/activity poll, the Delegations/Stake rewards poll, the 30s indexer-status
  // tick). Like wallet-balance / wallet-indexer-snapshot above, these are passive —
  // they must NOT re-arm auto-lock, or an open surface keeps the wallet unlocked
  // past its timeout indefinitely (P4-001 D2). See the wrongly-non-exempt rule above.
  "wallet-activity-get",
  "staking-pending-rewards",
  "wallet-indexer-status",
  "list-pending",
  "focus-approval",
  "keystore-unlock",
  "keystore-lock",
  "keystore-create-from-mnemonic",
  "keystore-export-seed",
  "keystore-reset",
  "keystore-wipe-unauth",
]);
