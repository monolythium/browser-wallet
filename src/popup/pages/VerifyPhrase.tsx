import { useEffect, useMemo, useState } from "react";
import { Icon } from "../Icon";

interface VerifyPhraseProps {
  mnemonic: string;
  onVerified: () => void;
  onBack: () => void;
}

interface Challenge {
  index: number;
  correct: string;
  candidates: string[];
}

function shuffle<T>(arr: T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function pickIndices(total: number, n: number): number[] {
  const set = new Set<number>();
  while (set.size < n && set.size < total) {
    set.add(Math.floor(Math.random() * total));
  }
  return Array.from(set).sort((a, b) => a - b);
}

function buildChallenges(words: string[]): Challenge[] {
  const indices = pickIndices(words.length, 3);
  return indices.map((index) => {
    const correct = words[index]!;
    // Distractor pool — every other word in the mnemonic except the correct
    // one. Dedup so duplicate mnemonic words don't become the same option
    // twice.
    const pool = Array.from(
      new Set(words.filter((_, i) => i !== index && words[i] !== correct)),
    );
    const distractors = shuffle(pool).slice(0, 5);
    const candidates = shuffle([correct, ...distractors]);
    return { index, correct, candidates };
  });
}

export function VerifyPhrase({
  mnemonic,
  onVerified,
  onBack,
}: VerifyPhraseProps) {
  const words = useMemo(() => mnemonic.trim().split(/\s+/), [mnemonic]);
  const [challenges] = useState<Challenge[]>(() => buildChallenges(words));

  // Per-challenge state. `selected` is the chosen candidate (null = unanswered);
  // `locked` flips to true once the correct word is picked.
  const [picks, setPicks] = useState<
    Array<{ selected: string | null; locked: boolean; nudge: boolean }>
  >(() => challenges.map(() => ({ selected: null, locked: false, nudge: false })));

  // Briefly flash the "try again" nudge after a wrong pick. Cleared per
  // challenge by the timer below.
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    picks.forEach((p, i) => {
      if (p.nudge) {
        timers.push(
          setTimeout(() => {
            setPicks((prev) => {
              const next = prev.slice();
              next[i] = { selected: null, locked: false, nudge: false };
              return next;
            });
          }, 1200),
        );
      }
    });
    return () => {
      for (const t of timers) clearTimeout(t);
    };
  }, [picks]);

  const handlePick = (challengeIdx: number, word: string) => {
    setPicks((prev) => {
      const next = prev.slice();
      const c = challenges[challengeIdx]!;
      if (word === c.correct) {
        next[challengeIdx] = { selected: word, locked: true, nudge: false };
      } else {
        next[challengeIdx] = { selected: word, locked: false, nudge: true };
      }
      return next;
    });
  };

  const allCorrect = picks.every((p) => p.locked);

  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div
          style={{ flex: 1, fontSize: 13, fontWeight: 600, textAlign: "center" }}
        >
          Verify recovery phrase
        </div>
        <div style={{ width: 36 }} />
      </div>

      <div
        style={{
          padding: "16px 18px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 14,
          overflowY: "auto",
        }}
      >
        <div
          style={{
            fontSize: "var(--fs-12)",
            color: "var(--fg-300)",
            lineHeight: 1.5,
          }}
        >
          Tap the word that goes in each numbered position to confirm you saved
          the phrase.
        </div>

        {challenges.map((c, ci) => {
          const pick = picks[ci]!;
          return (
            <div
              key={c.index}
              style={{
                padding: 12,
                borderRadius: 12,
                background: "rgba(0,0,0,0.25)",
                border: pick.locked
                  ? "1px solid var(--ok)"
                  : pick.nudge
                  ? "1px solid var(--err)"
                  : "1px solid var(--fg-700)",
                display: "flex",
                flexDirection: "column",
                gap: 10,
                transition: "border-color 200ms var(--e-out)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  fontFamily: "var(--f-mono)",
                  fontSize: 11,
                  color: pick.locked ? "var(--ok)" : "var(--fg-300)",
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                }}
              >
                <span>Word #{c.index + 1}</span>
                {pick.nudge && (
                  <span style={{ color: "var(--err)" }}>Try again</span>
                )}
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr 1fr",
                  gap: 6,
                }}
              >
                {c.candidates.map((word) => {
                  const isSelected = pick.selected === word;
                  const isLockedCorrect = pick.locked && isSelected;
                  return (
                    <button
                      key={word}
                      disabled={pick.locked}
                      onClick={() => handlePick(ci, word)}
                      style={{
                        padding: "8px 6px",
                        borderRadius: 8,
                        border: isLockedCorrect
                          ? "1px solid var(--ok)"
                          : isSelected
                          ? "1px solid var(--err)"
                          : "1px solid var(--fg-700)",
                        background: isLockedCorrect
                          ? "rgba(80,200,140,0.12)"
                          : isSelected
                          ? "rgba(240,112,112,0.10)"
                          : "rgba(255,255,255,0.04)",
                        color: "var(--fg-100)",
                        fontFamily: "var(--f-mono)",
                        fontSize: 12,
                        cursor: pick.locked ? "default" : "pointer",
                        transition: "all 150ms var(--e-out)",
                      }}
                    >
                      {word}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <div
        className="req-foot"
        style={{ marginTop: "auto", gridTemplateColumns: "1fr" }}
      >
        <button
          className="prim"
          disabled={!allCorrect}
          onClick={onVerified}
          style={
            allCorrect ? undefined : { opacity: 0.45, cursor: "not-allowed" }
          }
        >
          Continue
        </button>
      </div>
    </>
  );
}
