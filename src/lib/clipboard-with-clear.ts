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
 *  Used when the component that owns the copy unmounts. */
export function cancelClipboardAutoClear(): void {
  if (clearTimer !== null) {
    clearTimeout(clearTimer);
    clearTimer = null;
    lastCopiedText = null;
  }
}

/**
 * Format a 24-word phrase into the user-requested numbered, space-
 * separated form: "1.plunge 2.thank ... 24.odor". Used as the clipboard
 * payload so paste-into-storage preserves both word order and the
 * 1-based numbering callers can read back at a glance.
 */
export function formatPhraseForClipboard(words: readonly string[]): string {
  return words.map((word, i) => `${i + 1}.${word}`).join(" ");
}
