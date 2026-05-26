export const AUTO_LOCK_MINUTES_DEFAULT = 15;
export const AUTO_LOCK_OPTIONS = [5, 15, 30, 60] as const;
export type AutoLockMinutes = (typeof AUTO_LOCK_OPTIONS)[number];

export const ALARM_AUTO_LOCK = "monolythium.autolock";

// chrome.storage.local
export const STORAGE_KEY_AUTO_LOCK_MINUTES = "mono.autoLockMinutes";
export const STORAGE_KEY_PENDING_APPROVALS = "mono.pending-approvals";
export const STORAGE_KEY_CONNECTED_SITES = "mono.connected-sites";
// Multi-vault container. Keep in sync with VAULTS_CONTAINER_KEY_V4 in
// src/background/keystore-mldsa.ts; the popup mirrors this key in its
// chrome.storage.onChanged listener so vault-create / vault-import /
// vault-select propagate to the UI without IPC plumbing.
export const STORAGE_KEY_VAULTS_CONTAINER_V4 = "mono.vaults.v4";

// chrome.storage.session
export const SESSION_KEY_AUTO_LOCK_DEADLINE = "autoLockDeadline";
export const SESSION_KEY_WALLET_LOCKED = "walletLocked";
export const SESSION_KEY_UNLOCK_FAIL_COUNT = "unlockFailCount";
export const SESSION_KEY_UNLOCK_LOCKOUT_UNTIL = "unlockLockoutUntil";

// Highest threshold first so lockoutMsFor() returns the longest matching window.
export const LOCKOUT_THRESHOLDS = [
  { fails: 20, ms: 30 * 60_000 },
  { fails: 10, ms: 5 * 60_000 },
  { fails: 5, ms: 30_000 },
] as const;

// Broad exempt set — passive polls don't bump the timer; keystore handlers
// self-manage the deadline via resetAutoLock(), so the post-dispatch hook
// doesn't need to fire for them too.
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
  "list-connected-sites",
  "revoke-origin",
  "revoke-all-origins",
  "keystore-unlock",
  "keystore-lock",
  "keystore-create-new",
  "keystore-create-from-mnemonic",
  "keystore-export-seed",
  "keystore-reset",
  "keystore-wipe-unauth",
]);
