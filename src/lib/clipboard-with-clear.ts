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
//
// A pagehide listener (armed lazily on the first copy) adds a best-effort
// wipe when the popup/sidepanel document is actually unloading — the only
// backstop for a hard popup-close, where the 30 s timer and the unmount
// flush both die with the document and the service worker has no clipboard.
// It is best-effort (teardown async + focus limits), not a hard guarantee.

let clearTimer: ReturnType<typeof setTimeout> | null = null;
let lastCopiedText: string | null = null;
// The document the pagehide backstop is bound to (popup/sidepanel). Tracked
// by reference so the listener is registered at most once per document.
let pagehideTarget: EventTarget | null = null;

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
  // Arm the popup-close backstop on the first real copy. Lazy (never an
  // import-time side-effect) so it stays inert in the service worker and
  // other non-document contexts.
  ensurePagehideWipe();
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
          } catch (err) {
            // Keep swallowing — a failed clear must never crash anything —
            // but surface it: without clipboardWrite a non-gesture clear is
            // denied, and a silent swallow hid that the auto-clear never ran.
            console.warn("[clipboard] auto-clear write failed:", err);
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
    } catch (err) {
      console.warn("[clipboard] auto-clear write failed:", err);
    }
  }
}

/**
 * Clear the OS clipboard NOW, on an explicit user request. Always invoked
 * from a click, so it carries transient activation — and with clipboardWrite
 * declared the write is not gesture-gated either way. This is the RELIABLE,
 * on-demand counterpart to the best-effort auto-clear: the timer / flush /
 * pagehide paths can be defeated by a browser-action popup closing on blur or
 * by an unfocused surface, but a user tap is always a valid write context.
 *
 * Unconditional (the user asked to clear): drops any pending auto-clear timer
 * and the tracked copy, then writes "". Returns true on success, false on
 * failure (failure is also surfaced via console.warn, like the auto-clear
 * paths). Only ever writes "" — never a placeholder.
 */
export async function clearClipboardNow(): Promise<boolean> {
  cancelClipboardAutoClear(); // drop any pending timer + its tracked copy
  lastCopiedText = null; // ensure no tracked copy remains even if no timer
  try {
    await navigator.clipboard.writeText("");
    return true;
  } catch (err) {
    console.warn("[clipboard] auto-clear write failed:", err);
    return false;
  }
}

/**
 * Best-effort clipboard wipe fired when the popup/sidepanel document is
 * actually UNLOADING (pagehide) — not merely losing focus. This is the only
 * backstop for a hard popup-close: there the in-page 30 s timer and the
 * unmount flush both die with the document, and the service worker has no
 * clipboard. pagehide runs during teardown (async work may not finish, and
 * the document may already be unfocused), so this NARROWS the popup-close
 * window but is not a hard guarantee — the accepted MV3/OS residual.
 *
 * Only acts on a still-pending seed copy; never touches the clipboard
 * otherwise. Uses a DIRECT blind writeText("") (no readText round-trip):
 * during teardown the user just had the phrase copied, so clobber risk is
 * low and completing the write matters more than confirming first.
 */
function handlePagehideWipe(): void {
  if (lastCopiedText === null) return; // nothing pending — no-op
  if (clearTimer !== null) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }
  lastCopiedText = null;
  try {
    void navigator.clipboard.writeText("").catch((err) => {
      console.warn("[clipboard] auto-clear write failed:", err);
    });
  } catch (err) {
    console.warn("[clipboard] auto-clear write failed:", err);
  }
}

/**
 * Register {@link handlePagehideWipe} on the current document, at most once
 * per document. No-op in non-document contexts (the service worker has no
 * `window`). Called lazily from copyWithAutoClear so it is never an
 * import-time side-effect.
 */
function ensurePagehideWipe(): void {
  const w = typeof window !== "undefined" ? window : null;
  if (!w || typeof w.addEventListener !== "function") return;
  if (pagehideTarget === w) return; // already armed on this document
  pagehideTarget = w;
  w.addEventListener("pagehide", handlePagehideWipe);
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
