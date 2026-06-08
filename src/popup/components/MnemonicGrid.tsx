import { useEffect, useState } from "react";
import {
  copyWithAutoClear,
  flushClipboardAutoClear,
  formatPhraseForClipboard,
} from "../../lib/clipboard-with-clear";
import { Icon } from "../Icon";

interface MnemonicGridProps {
  mnemonic: string;
  /** Show a Copy-to-clipboard button below the grid
   *  with 30 s auto-clear. Default true. Pass false on surfaces that
   *  have their own copy button (e.g. the SLH-DSA backup reveal modal
   *  uses a 60 s timer + ghost button variant we don't double here). */
  showCopyButton?: boolean;
}

const CLEAR_AFTER_MS = 30_000;
const FEEDBACK_RESET_MS = 3_000;

/**
 * Two-column 24-word grid used by both ShowPhrase (onboarding) and
 * RevealPhrase (Settings → Show recovery phrase). Splits on whitespace
 * internally; callers pass the raw mnemonic string.
 *
 * Word font 12 → 15 px monospace for readability, and
 * an optional Copy-to-clipboard button below the grid. The clipboard
 * payload is the BARE phrase (bare words, no ordinal numbers — the
 * on-screen ordinals are layout only), matching the Settings → "Show
 * recovery phrase" copy via the shared `formatPhraseForClipboard` join,
 * and auto-clears 30 s after copy via the shared clipboard helper.
 */
export function MnemonicGrid({
  mnemonic,
  showCopyButton = true,
}: MnemonicGridProps) {
  const words = mnemonic.trim().split(/\s+/);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );

  // Reset the "Copied" badge after a few seconds so the button settles
  // back to its default label. The underlying clipboard timer is
  // independent and runs to 30 s regardless of this visual reset.
  useEffect(() => {
    if (copyState === "idle") return;
    const t = setTimeout(
      () => setCopyState("idle"),
      FEEDBACK_RESET_MS,
    );
    return () => clearTimeout(t);
  }, [copyState]);

  // On unmount, FLUSH the pending auto-clear (best-effort wipe NOW) rather
  // than merely cancelling the timer — the dominant flow is the user copies
  // then navigates away before the 30 s timer fires, which would otherwise
  // leave the phrase on the OS clipboard. The flush only wipes if the
  // clipboard still holds our phrase (or readText is denied).
  useEffect(() => () => void flushClipboardAutoClear(), []);

  const handleCopy = async () => {
    const text = formatPhraseForClipboard(mnemonic);
    try {
      await copyWithAutoClear(text, CLEAR_AFTER_MS);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div
        style={{
          padding: 14,
          borderRadius: 12,
          background: "rgba(124,127,255,0.06)",
          border: "1px solid var(--fg-700)",
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          columnGap: 14,
          rowGap: 10,
          fontFamily: "var(--f-mono)",
          fontSize: 15,
          lineHeight: 1.35,
          color: "var(--fg-100)",
        }}
      >
        {words.map((word, i) => (
          <div
            key={`${i}-${word}`}
            style={{
              display: "grid",
              gridTemplateColumns: "24px 1fr",
              gap: 8,
              alignItems: "baseline",
            }}
          >
            <span
              style={{
                color: "var(--fg-500)",
                textAlign: "right",
                fontSize: 11,
              }}
            >
              {i + 1}
            </span>
            <span style={{ fontWeight: 500 }}>{word}</span>
          </div>
        ))}
      </div>

      {showCopyButton && (
        <>
          <button
            type="button"
            onClick={() => void handleCopy()}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              width: "100%",
              padding: "8px 12px",
              borderRadius: 10,
              // Secondary affordance: copy is the convenience, handwriting is
              // the recommended path — so this reads as a quiet outline
              // button (transparent fill, muted text), not a primary action.
              border: "1px solid var(--fg-700)",
              background: "transparent",
              color:
                copyState === "copied" ? "var(--ok)" : "var(--fg-400)",
              fontFamily: "var(--f-sans)",
              fontSize: 12,
              fontWeight: 500,
              cursor: "pointer",
              transition: "all 160ms var(--e-out)",
            }}
          >
            <Icon
              name={copyState === "copied" ? "check" : "copy"}
              size={13}
            />
            {copyState === "copied"
              ? "Copied — auto-clears in ~30 s"
              : copyState === "failed"
                ? "Copy failed — try again"
                : "Copy to clipboard"}
          </button>
          <div
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 10,
              color: "var(--fg-500)",
              letterSpacing: "0.04em",
              lineHeight: 1.5,
              textAlign: "center",
            }}
          >
            Auto-clears ~30 s after copy, only while the wallet stays open.
            Clear your clipboard yourself if you paste the phrase elsewhere.
          </div>
        </>
      )}
    </div>
  );
}
