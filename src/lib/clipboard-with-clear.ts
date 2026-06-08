// Clipboard helper for security-sensitive material
// (24-word PQM-1 recovery phrase). Copies to the OS clipboard, then
// schedules a best-effort wipe after a configurable timeout. The wipe
// is best-effort because navigator.clipboard.readText requires user
// permission and may reject; if it fails we still blindly call
// writeText("") so the clipboard is at least cleared even though we
// can't verify it still held our copy.
//
// Only one in-flight clear-timer is tracked. Calling copyWithAutoClear
// again while a previous timer is pending resets the timer (the user
// expects a fresh 30s window after each copy).

let clearTimer: ReturnType<typeof setTimeout> | null = null;
let lastCopiedText: string | null = null;

/**
 * Copy `text` to the clipboard, scheduling a best-effort wipe after
 * `clearAfterMs`. Returns once the initial write completes. The wipe
 * fires asynchronously and is not awaited.
 *
 * Throws if `navigator.clipboard.writeText` rejects — callers should
 * surface a user-visible "copy failed" hint in that case.
 */
export async function copyWithAutoClear(
  text: string,
  clearAfterMs: number = 30_000,
): Promise<void> {
  cancelClipboardAutoClear();
  await navigator.clipboard.writeText(text);
  lastCopiedText = text;
  clearTimer = setTimeout(() => {
    void (async () => {
      try {
        // Best-effort: only clear if the clipboard still holds what we
        // wrote. readText may reject due to missing focus / permission
        // — fall through to a blind clear.
        let currentMatchesOurs = true;
        try {
          const current = await navigator.clipboard.readText();
          currentMatchesOurs = current === lastCopiedText;
        } catch {
          // readText denied — assume our text is still there.
        }
        if (currentMatchesOurs) {
          try {
            await navigator.clipboard.writeText("");
          } catch {
            // writeText denied during clear — nothing we can do.
          }
        }
      } finally {
        clearTimer = null;
        lastCopiedText = null;
      }
    })();
  }, clearAfterMs);
}

/** Cancel any pending auto-clear without touching the clipboard.
 *  Used internally before scheduling a fresh timer. NOTE: prefer
 *  {@link flushClipboardAutoClear} on component unmount — plain cancel
 *  leaves the copied secret sitting on the OS clipboard. */
export function cancelClipboardAutoClear(): void {
  if (clearTimer !== null) {
    clearTimeout(clearTimer);
    clearTimer = null;
    lastCopiedText = null;
  }
}

/**
 * Flush the pending auto-clear NOW (best-effort), then drop the timer.
 *
 * Call this from the unmount cleanup of any component that owns a seed-phrase
 * copy. The dominant flow is: the user copies the phrase and then navigates
 * away (or the screen auto-hides) BEFORE the 30 s timer fires — a plain
 * `cancelClipboardAutoClear()` would tear that timer down and leave the
 * phrase on the OS clipboard indefinitely. This wipes it on the way out
 * instead.
 *
 * Wipe policy (seed-safety first, don't clobber a later copy):
 *  - clipboard still holds exactly what we wrote  → clear it;
 *  - `readText` is denied (no clipboard-read permission / focus)
 *      → blind-clear (prioritise wiping the secret);
 *  - clipboard holds something else (a value copied after ours)
 *      → leave it alone.
 *
 * No-op when no copy is pending. Fire-and-forget from cleanups; returns a
 * promise so callers/tests may await it.
 */
export async function flushClipboardAutoClear(): Promise<void> {
  if (clearTimer !== null) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }
  const mine = lastCopiedText;
  lastCopiedText = null;
  if (mine === null) return; // nothing pending — never touch the clipboard

  let shouldClear = true;
  try {
    const current = await navigator.clipboard.readText();
    shouldClear = current === mine; // don't clobber a value copied after ours
  } catch {
    // readText denied — prioritise wiping the secret over preserving a
    // possible later copy.
    shouldClear = true;
  }
  if (shouldClear) {
    try {
      await navigator.clipboard.writeText("");
    } catch {
      // writeText denied during flush — nothing we can do.
    }
  }
}

/**
 * Format a 24-word recovery phrase for the clipboard as BARE, space-
 * separated words ("plunge thank ... odor") — no ordinal numbers.
 *
 * Both clipboard surfaces copy through this single join so their payloads
 * can't drift: the onboarding grid (MnemonicGrid's built-in copy button)
 * and Settings → "Show recovery phrase" (RevealPhrase). Numbers belong to
 * the on-screen layout only; a clipboard payload must be the raw phrase so
 * it can be pasted straight back into a wallet on restore. Splitting on
 * whitespace first normalizes any stray spacing in the source mnemonic.
 */
export function formatPhraseForClipboard(mnemonic: string): string {
  return mnemonic.trim().split(/\s+/).join(" ");
}
