export const AUTO_LOCK_MINUTES_DEFAULT = 15;
export const AUTO_LOCK_OPTIONS = [5, 15, 30, 60] as const;
export type AutoLockMinutes = (typeof AUTO_LOCK_OPTIONS)[number];

export const ALARM_AUTO_LOCK = "monolythium.autolock";

/** GAP-N1 — periodic poll that runs `pollPendingAndNotify` while any tx is
 *  pending, so a transaction confirming while every wallet surface is closed
 *  still toasts + badges at confirm time. Self-limiting: created when the
 *  pending set becomes non-empty, cleared when it empties. */
export const ALARM_NOTIF_POLL = "monolythium.notif-poll";

// chrome.storage.local
export const STORAGE_KEY_AUTO_LOCK_MINUTES = "mono.autoLockMinutes";
export const STORAGE_KEY_PENDING_APPROVALS = "mono.pending-approvals";
export const STORAGE_KEY_CONNECTED_SITES = "mono.connected-sites";
// Multi-vault container. Keep in sync with VAULTS_CONTAINER_KEY_V4 in
// src/background/keystore-mldsa.ts; the popup mirrors this key in its
// chrome.storage.onChanged listener so vault-create / vault-import /
// vault-select propagate to the UI without IPC plumbing.
export const STORAGE_KEY_VAULTS_CONTAINER_V4 = "mono.vaults.v4";
// Round 7 TASK 5 — Contacts (address book). Keyed by lowercase 0x
// address; value is a ContactRecord (see src/background/contacts.ts).
// Mirrored to the popup via chrome.storage.onChanged.
export const STORAGE_KEY_CONTACTS = "mono.contacts.v1";
// Round 4 TASK 4 — UI open mode. The SW reads this on boot + on every
// chrome.storage.onChanged event to bind action-icon click to either
// the side-panel or the popup. Default "sidepanel" matches modern
// wallet UX (MetaMask Flask, Phantom, Rabby).
export const STORAGE_KEY_UI_OPEN_MODE = "mono.ui.open-mode";
export const UI_OPEN_MODE_VALUES = ["sidepanel", "popup"] as const;
export type UiOpenMode = (typeof UI_OPEN_MODE_VALUES)[number];
export const UI_OPEN_MODE_DEFAULT: UiOpenMode = "sidepanel";

// chrome.storage.session
export const SESSION_KEY_AUTO_LOCK_DEADLINE = "autoLockDeadline";
export const SESSION_KEY_WALLET_LOCKED = "walletLocked";
export const SESSION_KEY_UNLOCK_FAIL_COUNT = "unlockFailCount";
export const SESSION_KEY_UNLOCK_LOCKOUT_UNTIL = "unlockLockoutUntil";
// Round 4 TASK 2 — MEK (master encryption key) cache for cross-SW-
// hibernation rehydrate. chrome.storage.session is in-memory only and
// cleared on browser restart, so this never persists to disk. On SW
// reboot, keystore-mldsa.ts reads this back and unwraps the active
// vault without prompting for the password. Cleared on lock /
// auto-lock fire / wipe.
export const SESSION_KEY_MEK_V4 = "mono.session.mek.v4";

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
// Round 12 TASK 5 — the regression the user reported as "autolock
// broken again": Round 7 + Round 11 added revoke-* and contacts-add/
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
  "sprintnet-operators-get",
  "sprintnet-operators-health",
  // Phase 11 Commit 2 — WS infra polls are passive: status reads and
  // fire-and-forget subscribe don't represent user activity.
  "ws-status",
  "ws-subscribe-new-heads",
  // Phase 11 Commit 3 — AddressActivityKind probe is passive metadata
  // (used by the activity feed to render empty-state context).
  "wallet-activity-kind",
  "list-pending",
  "get-pending",
  "focus-approval",
  // ConnectedSites: list is the passive surface mount; revoke ops
  // are USER ACTIONS — Round 12 moved them OUT of exempt.
  "list-connected-sites",
  // Round 12 TASK 5 — contacts-list + contacts-check stay exempt
  // (read-only surface mounts: contact list rendering, address-book
  // lookup during send-tx address resolution). contacts-add /
  // contacts-rename / contacts-remove are USER ACTIONS — Round 12
  // moved them OUT of exempt.
  "contacts-list",
  "contacts-check",
  "keystore-unlock",
  "keystore-lock",
  "keystore-create-new",
  "keystore-create-from-mnemonic",
  "keystore-export-seed",
  "keystore-reset",
  "keystore-wipe-unauth",
]);
