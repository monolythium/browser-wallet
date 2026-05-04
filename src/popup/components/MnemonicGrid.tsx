interface MnemonicGridProps {
  mnemonic: string;
}

/**
 * Two-column 24-word grid used by both ShowPhrase (onboarding) and
 * RevealPhrase (Settings → Show recovery phrase). Splits on whitespace
 * internally; callers pass the raw mnemonic string.
 */
export function MnemonicGrid({ mnemonic }: MnemonicGridProps) {
  const words = mnemonic.trim().split(/\s+/);
  return (
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
  );
}
