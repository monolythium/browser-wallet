import { useMemo, useState } from "react";
import { wordlist as bip39English } from "@scure/bip39/wordlists/english.js";
import { Icon } from "../Icon";

interface VerifyPhraseProps {
  mnemonic: string;
  onVerified: () => void;
  /** Round 12 TASK 1 — back button is optional. During first-setup
   *  onboarding the parent intentionally omits onBack so the user
   *  can't bypass verification by tapping back into the show-phrase
   *  step (which itself has no back to home anymore). */
  onBack?: () => void;
}

// Round 11 TASK 5 — number of slots to hide. The original 3-word
// picker proved too easy (any 6 distractors, 1/6 random guess hits a
// position). 6 hidden positions × ~10 candidate bank = ~10^6 random-
// guess hit rate when the user has no real memory, while staying
// fast enough that someone who actually wrote down 24 words finishes
// in under a minute.
const HIDDEN_COUNT = 6;
// How many BIP-39 distractors to mix into the word bank in addition
// to the 6 hidden correct words. Total bank size = 6 + DISTRACTOR_COUNT.
const DISTRACTOR_COUNT = 5;

function shuffle<T>(arr: readonly T[]): T[] {
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

function pickDistractors(count: number, exclude: ReadonlySet<string>): string[] {
  // The full BIP-39 English wordlist has 2048 entries; rejecting ones
  // that already appear in the phrase is fast enough that we don't
  // need a smarter sampler.
  const out: string[] = [];
  const used = new Set(exclude);
  // Cap loop so a pathological exclude set (impossible in practice)
  // can't infinite-loop. 200 attempts to find a few words is plenty.
  for (let attempts = 0; attempts < 200 && out.length < count; attempts++) {
    const idx = Math.floor(Math.random() * bip39English.length);
    const w = bip39English[idx];
    if (!w || used.has(w)) continue;
    used.add(w);
    out.push(w);
  }
  return out;
}

interface Slot {
  /** Position in the original phrase (0-based). */
  index: number;
  /** Pre-filled word (always-correct, non-interactive) when the
   *  position wasn't picked as hidden, OR the user's current pick
   *  when the position IS hidden (null = empty). */
  filled: string | null;
}

interface Challenge {
  slots: Slot[];
  bank: string[];
  hiddenIdxSet: ReadonlySet<number>;
}

function buildChallenge(words: readonly string[]): Challenge {
  const hiddenIdx = pickIndices(words.length, HIDDEN_COUNT);
  const hiddenIdxSet = new Set(hiddenIdx);
  const hiddenWords = hiddenIdx.map((i) => words[i]!);
  const distractors = pickDistractors(
    DISTRACTOR_COUNT,
    new Set(words),
  );
  const bank = shuffle([...hiddenWords, ...distractors]);
  const slots: Slot[] = words.map((word, i) => ({
    index: i,
    filled: hiddenIdxSet.has(i) ? null : word,
  }));
  return { slots, bank, hiddenIdxSet };
}

export function VerifyPhrase({
  mnemonic,
  onVerified,
  onBack,
}: VerifyPhraseProps) {
  const words = useMemo(() => mnemonic.trim().split(/\s+/), [mnemonic]);
  const [challenge] = useState<Challenge>(() => buildChallenge(words));
  const [slots, setSlots] = useState<Slot[]>(challenge.slots);
  const [bank, setBank] = useState<string[]>(challenge.bank);

  const handlePickFromBank = (word: string) => {
    const firstEmpty = slots.findIndex(
      (s) => s.filled === null && challenge.hiddenIdxSet.has(s.index),
    );
    if (firstEmpty === -1) return;
    setSlots((prev) =>
      prev.map((s, i) =>
        i === firstEmpty ? { ...s, filled: word } : s,
      ),
    );
    setBank((prev) => prev.filter((w) => w !== word));
  };

  const handleResetSlot = (slotIdx: number) => {
    const slot = slots[slotIdx];
    if (!slot || slot.filled === null) return;
    if (!challenge.hiddenIdxSet.has(slot.index)) return;
    const removed = slot.filled;
    setSlots((prev) =>
      prev.map((s, i) =>
        i === slotIdx ? { ...s, filled: null } : s,
      ),
    );
    setBank((prev) => [...prev, removed]);
  };

  const allFilled = slots.every((s) => s.filled !== null);
  const allCorrect =
    allFilled && slots.every((s) => s.filled === words[s.index]);

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
            fontSize: 13,
            fontWeight: 600,
            textAlign: "center",
          }}
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
          Select the missing words in the correct order. Pre-filled words
          are shown to anchor your place in the phrase — tap a filled slot
          to return its word to the bank.
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: 6,
          }}
        >
          {slots.map((slot, slotIdx) => {
            const isHidden = challenge.hiddenIdxSet.has(slot.index);
            const isEmpty = slot.filled === null;
            const isWrong =
              !isEmpty && slot.filled !== words[slot.index];
            const isRightAndHidden =
              !isEmpty && !isWrong && isHidden;

            // Pre-filled (correct, non-hidden) slots: muted/static.
            // Hidden + empty: dashed accent border, awaiting fill.
            // Hidden + filled correct: solid accent border.
            // Hidden + filled wrong: red border so user sees the error
            //   before they finish; tapping returns word to bank.
            const borderColor = isEmpty && isHidden
              ? "var(--gold)"
              : isRightAndHidden
                ? "var(--ok)"
                : isWrong
                  ? "var(--err)"
                  : "var(--fg-700)";
            const background = isEmpty && isHidden
              ? "rgba(242,180,65,0.04)"
              : isWrong
                ? "rgba(240,112,112,0.08)"
                : isHidden && !isEmpty
                  ? "rgba(88,200,140,0.08)"
                  : "rgba(0,0,0,0.20)";

            return (
              <button
                key={slot.index}
                type="button"
                disabled={!isHidden || isEmpty}
                onClick={() => handleResetSlot(slotIdx)}
                aria-label={
                  isHidden && isEmpty
                    ? `Word ${slot.index + 1}, empty`
                    : isHidden
                      ? `Word ${slot.index + 1}, ${slot.filled} (tap to remove)`
                      : `Word ${slot.index + 1}, ${slot.filled}`
                }
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "9px 10px",
                  borderRadius: 8,
                  fontFamily: "var(--f-mono)",
                  fontSize: 12,
                  border: `1px ${isEmpty && isHidden ? "dashed" : "solid"} ${borderColor}`,
                  background,
                  color: isEmpty
                    ? "var(--fg-500)"
                    : isHidden
                      ? "var(--fg-100)"
                      : "var(--fg-300)",
                  textAlign: "left",
                  cursor:
                    isHidden && !isEmpty ? "pointer" : "default",
                  minHeight: 36,
                  transition: "all 150ms var(--e-out)",
                }}
              >
                <span
                  style={{
                    fontSize: 10,
                    color: "var(--fg-500)",
                    minWidth: 18,
                  }}
                >
                  {slot.index + 1}.
                </span>
                <span style={{ flex: 1 }}>
                  {slot.filled ?? " "}
                </span>
              </button>
            );
          })}
        </div>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            padding: 12,
            background: "rgba(0,0,0,0.25)",
            border: "1px solid var(--fg-700)",
            borderRadius: 12,
            justifyContent: "center",
          }}
        >
          {bank.length === 0 ? (
            <div
              style={{
                fontFamily: "var(--f-mono)",
                fontSize: 11,
                color: "var(--fg-500)",
                padding: "4px 0",
              }}
            >
              All words placed
            </div>
          ) : (
            bank.map((word) => (
              <button
                key={word}
                type="button"
                onClick={() => handlePickFromBank(word)}
                style={{
                  padding: "7px 12px",
                  borderRadius: 8,
                  border: "1px solid rgba(242,180,65,0.4)",
                  background: "rgba(242,180,65,0.08)",
                  color: "var(--gold)",
                  fontFamily: "var(--f-mono)",
                  fontSize: 12.5,
                  fontWeight: 500,
                  cursor: "pointer",
                  transition: "all 150ms var(--e-out)",
                }}
              >
                {word}
              </button>
            ))
          )}
        </div>

        {allFilled && !allCorrect && (
          <div
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 11,
              color: "var(--err)",
              lineHeight: 1.4,
            }}
          >
            Some words are in the wrong position. Tap any red slot to
            return its word to the bank, then try again.
          </div>
        )}
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
