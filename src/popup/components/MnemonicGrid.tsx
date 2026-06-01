import { useEffect, useState } from "react";
import {
  cancelClipboardAutoClear,
  copyWithAutoClear,
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
 * format mirrors the on-screen layout ("1.word 2.word ... 24.word")
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

  // On unmount, cancel any pending auto-clear so a re-mounted grid
  // doesn't race against a stale timer from this instance.
  useEffect(() => () => cancelClipboardAutoClear(), []);

  const handleCopy = async () => {
    const text = formatPhraseForClipboard(words);
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
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid var(--fg-700)",
              background:
                copyState === "copied"
                  ? "rgba(88,200,140,0.10)"
                  : "rgba(255,255,255,0.04)",
              color:
                copyState === "copied" ? "var(--ok)" : "var(--fg-100)",
              fontFamily: "var(--f-sans)",
              fontSize: 12.5,
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
              ? "Copied — clears in 30 s"
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
            The clipboard auto-clears after 30 s. Store the phrase in a
            safe place before then.
          </div>
        </>
      )}
    </div>
  );
}
