import { useMemo, useState } from "react";
import { Icon } from "../Icon";

interface ImportWalletProps {
  onSubmit: (mnemonic: string) => void;
  onBack: () => void;
  error?: string | null;
}

export function ImportWallet({ onSubmit, onBack, error }: ImportWalletProps) {
  const [text, setText] = useState("");

  const cleaned = useMemo(
    () => text.trim().toLowerCase().split(/\s+/).filter(Boolean),
    [text],
  );
  const wordCount = cleaned.length;
  const canSubmit = wordCount === 24;

  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div
          style={{ flex: 1, fontSize: 15, fontWeight: 600, textAlign: "center" }}
        >
          Import wallet
        </div>
        <div style={{ width: 36 }} />
      </div>

      <div
        style={{
          padding: "20px 18px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div
          style={{
            fontSize: "var(--fs-12)",
            color: "var(--fg-300)",
            lineHeight: 1.5,
          }}
        >
          Paste your 24-word recovery phrase. Words are separated by
          spaces. Case is normalised on import.
        </div>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
          placeholder="word1 word2 word3 ..."
          autoFocus
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          style={{
            width: "100%",
            padding: "10px 12px",
            borderRadius: 10,
            background: "rgba(0,0,0,0.3)",
            border: "1px solid var(--fg-700)",
            color: "var(--fg-100)",
            fontFamily: "var(--f-mono)",
            fontSize: 12,
            lineHeight: 1.5,
            outline: "none",
            resize: "vertical",
            boxSizing: "border-box",
          }}
        />

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontFamily: "var(--f-mono)",
            fontSize: 11,
            color:
              wordCount === 24
                ? "var(--ok)"
                : wordCount === 0
                ? "var(--fg-400)"
                : "var(--warn)",
          }}
        >
          <span>{wordCount} / 24 words</span>
          {wordCount > 0 && wordCount !== 24 && (
            <span style={{ color: "var(--fg-400)" }}>
              {wordCount < 24 ? "keep going…" : "too many"}
            </span>
          )}
        </div>

        {error && (
          <div
            style={{
              fontSize: "var(--fs-11)",
              color: "var(--err)",
              fontFamily: "var(--f-mono)",
            }}
          >
            {error}
          </div>
        )}
      </div>

      <div
        className="req-foot"
        style={{ marginTop: "auto", gridTemplateColumns: "1fr" }}
      >
        <button
          className="prim"
          disabled={!canSubmit}
          onClick={() => onSubmit(cleaned.join(" "))}
          style={
            canSubmit ? undefined : { opacity: 0.45, cursor: "not-allowed" }
          }
        >
          Continue
        </button>
      </div>
    </>
  );
}
