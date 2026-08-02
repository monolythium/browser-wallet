import type { CurrencyCode } from "./iso4217";

export const AUTO_LOCK_MINUTES_DEFAULT = 5;
export const AUTO_LOCK_OPTIONS = [5, 15, 30, 60] as const;

/** The word the user types to confirm an irreversible destroy.
 *
 *  GLOBAL AND IDENTICAL EVERYWHERE. The same "DELETE" confirms the whole-wallet
 *  wipe (`keystore-wipe-unauth`, which the SW compares against this constant),
 *  Reset wallet, the unlock screen's no-phrase path, AND the removal of a single
 *  wallet through ConfirmWordDialog. It is not derived from the thing being
 *  destroyed and is never checked against it, so typing it proves intent to
 *  destroy — never intent to destroy THIS one.
 *
 *  What identifies the target is the dialog's own copy: Wallets.tsx passes
 *  `title={`Remove ${label}?`}` and a matching warning heading. Nothing in the
 *  confirm step binds the typed word to that label. Anything that needs the
 *  destroy bound to a target must pin the target itself — the removal flow does,
 *  by snapshotting the vault id into state at mount so a re-render or a list
 *  reorder cannot retarget an already-armed confirm. */
export const WIPE_CONFIRM_WORD = "DELETE";

/** Typed confirmation for turning the loopback opt-in ON.
 *
 *  Deliberately NOT {@link WIPE_CONFIRM_WORD}. Nothing is destroyed here — the
 *  user is authorising the wallet to dial a node on their own machine — and
 *  reusing "DELETE" would erode it on the three paths where it does signal
 *  destruction. "CONNECT" names what is actually being authorised. */
export const LOOPBACK_CONFIRM_WORD = "CONNECT";

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

/** Low-cadence poll that detects INCOMING transfers for the active unlocked
 *  account even when it has no in-flight pending tx (which is the only thing that
 *  keeps ALARM_NOTIF_POLL alive). Armed while unlocked + the "Incoming transfers"
 *  toggle is on; cleared on lock / toggle-off / no active account, so it never
 *  keeps the SW awake while locked. Closes the closed-surface, no-pending
 *  cross-wallet gap (see 2026-07-02_incoming-notif-bug-inspect). */
export const ALARM_INCOMING_POLL = "monolythium.incoming-poll";
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
// LEGACY (2026-06-28 auto-lock overhaul) — the password-less session-MEK restore
// window is now governed SOLELY by the configured auto-lock deadline
// (SESSION_KEY_AUTO_LOCK_DEADLINE): tryRestoreFromSessionV4 refuses + wipes once
// that deadline is absent or passed, so the user's configured auto-lock IS the
// intended exposure bound (default 5 min, max 60), with the increase-warning
// dialog as explicit consent for a longer window. The former independent 5-min
// cap (MEK_REHYDRATE_MAX_MINUTES) is REMOVED — it shadowed the configured timer
// and relocked at ~5 min of idle regardless of the setting. This key is no longer
// WRITTEN; it is only REMOVED (clearMekFromSessionV4 / triggerAutoLock /
// resetAutoLock-when-locked) to purge any stale deadline a pre-overhaul unlock
// left in the same browser session.
export const SESSION_KEY_MEK_REHYDRATE_DEADLINE =
  "mono.session.mek.rehydrate.deadline";

// Highest threshold first so lockoutMsFor() returns the longest matching window.
export const LOCKOUT_THRESHOLDS = [
  { fails: 20, ms: 30 * 60_000 },
  { fails: 10, ms: 5 * 60_000 },
  { fails: 5, ms: 30_000 },
] as const;

/**
 * Shown alongside a lockout countdown on the surfaces where the user could
 * otherwise conclude the wallet is permanently unreachable.
 *
 * This is true by construction, not a reassurance: the counter lives in
 * `chrome.storage.session` (see SESSION_KEY_UNLOCK_FAIL_COUNT above), which is
 * in-memory for the browser session and dropped when the browser closes. There
 * is no `chrome.storage.local` mirror of it anywhere.
 *
 * It matters because a single counter is shared by every password surface and
 * never decays, so a user who is locked out at the unlock screen is also locked
 * out of Reset wallet — the recovery path — at the exact moment they need it.
 * At the 30-minute tier, with no way to know the lockout is not permanent, the
 * reasonable conclusion is that the wallet is dead. It is not.
 */
export const LOCKOUT_RESTART_HINT =
  "This limit resets if you restart your browser.";

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
  // #B3-2 indexer-off fallback: fired automatically by the empty-state effect,
  // not by user input — passive, so it must not re-arm auto-lock.
  "wallet-activity-txfeed",
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

// ─────────────────────────────────────────────────────────────────────────────
// Genesis-probe cache TTLs
//
// Moved here from background/networks.ts so BOTH the probe logic and the Help
// page's developer-mode mechanics read the same value. The mechanics previously
// described these two states without their number, because networks.ts cannot
// be imported popup-side — and a typed "60" would have been a copied constant
// inside the very blocks that exist to argue against copied constants.
//
// This module is a safe home: it carries no chrome API call (every `chrome.`
// in it is comment prose naming a storage key), no side effects, and one
// type-only import. The popup already imports it, so it costs no new bundle.
// ─────────────────────────────────────────────────────────────────────────────

/** TTL for a NON-definitive genesis-cache entry (observed === null:
 *  unreachable / timeout / probe-unsupported). Definitive reads (a real
 *  observed hash, match or mismatch) are cached forever; only the
 *  "couldn't read" verdict expires, so a transient outage self-heals. */
export const GENESIS_OBSERVED_NULL_TTL_MS = 60_000;

/** C6 (R3): re-probe TTL for a DEFINITIVE positive ("passed") verdict. A pass is
 *  bounded (not forever) so an operator that passed once then silently forked
 *  while the SW is alive is re-detected within this window. A definitive MISMATCH
 *  stays sticky (no TTL) — it correctly keeps the wallet paused until resolved. */
export const GENESIS_POSITIVE_TTL_MS = 60_000;
