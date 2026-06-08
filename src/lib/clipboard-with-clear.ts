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
 * Log a best-effort clear-write the browser declined — almost always because
 * the wallet document isn't focused (DOMException "Document is not focused"),
 * which `clipboardWrite` does NOT lift. Expected and harmless: the auto-clear
 * is best-effort and the manual "Clear clipboard" button is the reliable path.
 * Prints a readable reason instead of "[object DOMException]".
 */
function warnClearWriteSkipped(err: unknown): void {
  const e = err as { name?: string; message?: string } | null;
  const reason = e?.name ? `${e.name}: ${e.message ?? ""}` : String(err);
  // "Document is not focused" (NotAllowedError) is the EXPECTED best-effort
  // skip when the wallet isn't focused — log it quietly at debug level so it
  // doesn't read as an error in the console. Anything else is unexpected → warn.
  const log = e?.name === "NotAllowedError" ? console.debug : console.warn;
  log("[clipboard] best-effort auto-clear skipped —", reason);
}

/**
 * Overwrite the OS clipboard with `value` via the legacy execCommand('copy')
 * path. Unlike the async navigator.clipboard.writeText, this works even when
 * the wallet document is NOT focused — provided the extension declares
 * `clipboardWrite` (it does). The async API throws "Document is not focused"
 * from a timer / teardown clear, which is exactly why the auto-clear used to
 * fail silently. Restores prior focus so the UI isn't disturbed. Returns
 * execCommand's success flag.
 */
function execCommandWrite(value: string): boolean {
  if (
    typeof document === "undefined" ||
    typeof document.execCommand !== "function" ||
    !document.body
  ) {
    return false;
  }
  const active = document.activeElement as HTMLElement | null;
  const ta = document.createElement("textarea");
  ta.value = value;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0;";
  document.body.appendChild(ta);
  let ok = false;
  try {
    ta.focus();
    ta.select();
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  try {
    active?.focus?.();
  } catch {
    /* restoring focus is best-effort */
  }
  return ok;
}

/**
 * Clear the OS clipboard synchronously and focus-independently (legacy path).
 * Writes "" — or, if the browser declines to copy an empty selection, a single
 * space — so the recovery phrase is removed even when the document isn't
 * focused. Returns true on success.
 */
function clearClipboardLegacy(): boolean {
  return execCommandWrite("") || execCommandWrite(" ");
}

/**
 * Empty the clipboard, used by every clear path. Tries the async writeText("")
 * first (cleanest — a true empty string — but it needs the document focused);
 * on denial (the unfocused timer / teardown case, "Document is not focused")
 * falls back to the focus-independent legacy path. Logs quietly only if BOTH
 * fail. Returns true on success.
 */
async function clearClipboardEmpty(): Promise<boolean> {
  try {
    await navigator.clipboard.writeText("");
    return true;
  } catch (err) {
    if (clearClipboardLegacy()) return true;
    warnClearWriteSkipped(err);
    return false;
  }
}

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
          // The timer almost always fires while the wallet is unfocused, where
          // the async writeText is denied — clearClipboardEmpty falls back to
          // the focus-independent legacy path so the phrase is actually cleared.
          await clearClipboardEmpty();
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
    await clearClipboardEmpty();
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
 * and the tracked copy, then empties the clipboard via clearClipboardEmpty
 * (async writeText("") when focused, else the focus-independent legacy path).
 * Returns true on success, false on failure (also surfaced via a quiet log).
 */
export async function clearClipboardNow(): Promise<boolean> {
  cancelClipboardAutoClear(); // drop any pending timer + its tracked copy
  lastCopiedText = null; // ensure no tracked copy remains even if no timer
  return clearClipboardEmpty();
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
 * otherwise. Prefers the SYNC legacy clear (execCommand) — it works even
 * unfocused and completes during teardown, where an async writeText usually
 * can't; writeText is the fallback only if execCommand is unavailable.
 */
function handlePagehideWipe(): void {
  if (lastCopiedText === null) return; // nothing pending — no-op
  if (clearTimer !== null) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }
  lastCopiedText = null;
  if (!clearClipboardLegacy()) {
    try {
      void navigator.clipboard.writeText("").catch((err) => {
        warnClearWriteSkipped(err);
      });
    } catch (err) {
      warnClearWriteSkipped(err);
    }
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
