import { Icon } from "../Icon";

interface ShowPhraseProps {
  mnemonic: string;
  onConfirmed: () => void;
  onBack: () => void;
}

export function ShowPhrase({ mnemonic, onConfirmed, onBack }: ShowPhraseProps) {
  const words = mnemonic.trim().split(/\s+/);

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
          PQM-1 · {words.length} words
        </div>

        <div
          style={{
            padding: 14,
            borderRadius: 12,
            background: "rgba(124,127,255,0.06)",
            border: "1px solid var(--fg-700)",
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            columnGap: 14,
            rowGap: 8,
            fontFamily: "var(--f-mono)",
            fontSize: 12,
            lineHeight: 1.4,
            color: "var(--fg-100)",
          }}
        >
          {words.map((word, i) => (
            <div
              key={`${i}-${word}`}
              style={{
                display: "grid",
                gridTemplateColumns: "22px 1fr",
                gap: 6,
              }}
            >
              <span style={{ color: "var(--fg-500)", textAlign: "right" }}>
                {i + 1}
              </span>
              <span>{word}</span>
            </div>
          ))}
        </div>

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
