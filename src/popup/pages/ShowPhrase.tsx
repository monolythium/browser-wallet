import { Icon } from "../Icon";
import { MnemonicGrid } from "../components/MnemonicGrid";

interface ShowPhraseProps {
  mnemonic: string;
  onConfirmed: () => void;
  /** Back button is optional. During first-setup
   *  onboarding the parent intentionally omits onBack so the user
   *  can't bypass the verify-phrase step by tapping back into home.
   *  When omitted, the back chevron is hidden and a spacer keeps the
   *  title centered. */
  onBack?: () => void;
}

export function ShowPhrase({ mnemonic, onConfirmed, onBack }: ShowPhraseProps) {
  const wordCount = mnemonic.trim().split(/\s+/).length;

  return (
    <>
      <div className="ext-top">
        {onBack ? (
          <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
            <Icon name="back" size={15} />
          </button>
        ) : (
          <div style={{ width: 36 }} />
        )}
        <div
          style={{
            flex: 1,
            fontSize: 15,
            fontWeight: 600,
            textAlign: "center",
          }}
        >
          Recovery phrase
        </div>
        <div style={{ width: 36 }} />
      </div>

      {/* Content moved into .ext-body so the screen
         scrolls when the 15 px-mono grid + copy button + warning
         exceed the popup viewport. Without scroll, the
         font-size bump pushed the Continue button (in .req-foot)
         below the visible area and the user couldn't reach it. */}
      <div
        className="ext-body"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 10,
            color: "var(--fg-400)",
            letterSpacing: "0.14em",
            textTransform: "uppercase",
          }}
        >
          ML-DSA-65 · {wordCount} words
        </div>

        <MnemonicGrid mnemonic={mnemonic} />

        <div
          style={{
            padding: "10px 12px",
            borderRadius: 10,
            background: "rgba(242,180,65,0.08)",
            border: "1px solid rgba(242,180,65,0.4)",
            color: "var(--fg-100)",
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          Write these words down on paper, in order, and keep them
          offline. Don&apos;t screenshot them or save them to a file or
          the cloud. Anyone with these words controls your funds —
          Monolythium cannot recover them.
        </div>
      </div>

      <div
        className="req-foot"
        style={{ marginTop: "auto", gridTemplateColumns: "1fr" }}
      >
        <button className="prim" onClick={onConfirmed}>
          I&apos;ve written it down
        </button>
      </div>
    </>
  );
}
