// Setup-health nag state — snooze / dismiss persistence for the Home
// `SetupHealthChip` ("N of 3 wallet features configured").
//
// The chip otherwise shows on every Home render while setup is < 100%. This
// module is the PURE decision + state layer (no `chrome` import, Node-pinnable);
// the chip owns the thin `chrome.storage.local` read/write wrappers, mirroring
// `SlhDsaBackupHintBar`'s `shouldShowHint` + per-vault hint-state pattern.
//
// Per-VAULT scope: the chip + the recovery config it counts (SLH-DSA backup,
// passkey) are keyed by vaultId, so a fresh vault re-shows the nag.

/** Per-vault nag dismissal/snooze state. */
export interface RecoveryNagState {
  /** "Don't ask again" — permanent suppression for this vault. */
  dismissedForever: boolean;
  /** "Later" — `Date.now()` after which the nag may re-surface; null = not
   *  snoozed. */
  snoozedUntilMs: number | null;
}

/** Snooze window for a "Later" tap: 30 days. A SEPARATE const from the SLH-DSA
 *  hint bar's `HINT_BAR_RESURFACE_MS` (same value, decoupled modules). */
export const SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

/** Pure gate — returns `true` iff the chip should render right now for the given
 *  (per-vault state, all-3-complete, current-time) triple. */
export function shouldShowRecoveryNag(
  state: RecoveryNagState | undefined,
  allComplete: boolean,
  nowMs: number,
): boolean {
  if (allComplete) return false; // all-3 configured wins regardless
  if (!state) return true; // absent → show (non-breaking default)
  if (state.dismissedForever) return false; // "Don't ask again"
  return nowMs >= (state.snoozedUntilMs ?? 0); // snooze elapsed (or never snoozed)
}

/** "Later" — snooze from `nowMs`. Repeatable: each call re-snoozes afresh. */
export function applyLater(nowMs: number): RecoveryNagState {
  return { dismissedForever: false, snoozedUntilMs: nowMs + SNOOZE_MS };
}

/** "Don't ask again" — permanent suppression for this vault. */
export function applyDismissForever(): RecoveryNagState {
  return { dismissedForever: true, snoozedUntilMs: null };
}

/** Tolerant read — normalises an arbitrary storage blob into a well-formed
 *  per-vault map, dropping malformed entries silently (mirrors the
 *  SlhDsaBackupHintBar `normaliseMap` idiom). */
export function normaliseRecoveryNagMap(
  raw: unknown,
): Record<string, RecoveryNagState> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, RecoveryNagState> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
    if (typeof r.dismissedForever !== "boolean") continue;
    if (!(r.snoozedUntilMs === null || typeof r.snoozedUntilMs === "number")) {
      continue;
    }
    out[k] = {
      dismissedForever: r.dismissedForever,
      snoozedUntilMs: r.snoozedUntilMs,
    };
  }
  return out;
}
