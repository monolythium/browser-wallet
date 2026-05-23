import { Icon } from "../Icon";
import { MnemonicGrid } from "../components/MnemonicGrid";

interface ShowPhraseProps {
  mnemonic: string;
  onConfirmed: () => void;
  onBack: () => void;
}

export function ShowPhrase({ mnemonic, onConfirmed, onBack }: ShowPhraseProps) {
  const wordCount = mnemonic.trim().split(/\s+/).length;

  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div
          style={{
            flex: 1,
            fontSize: 13,
            fontWeight: 600,
            textAlign: "center",
          }}
        >
          Recovery phrase
        </div>
        <div style={{ width: 36 }} />
      </div>

      <div
        style={{
          padding: "16px 18px 12px",
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
          PQM-1 · {wordCount} words
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
          Write these words down. Anyone with these words controls your
          funds. Monolythium cannot recover them.
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
