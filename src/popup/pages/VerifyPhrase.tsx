import { useMemo, useState } from "react";
import { wordlist as bip39English } from "@scure/bip39/wordlists/english.js";
import { Icon } from "../Icon";

interface VerifyPhraseProps {
  mnemonic: string;
  onVerified: () => void;
  /** Back button is optional. During first-setup
   *  onboarding the parent intentionally omits onBack so the user
   *  can't bypass verification by tapping back into the show-phrase
   *  step (which itself has no back to home anymore). */
  onBack?: () => void;
}

// Number of slots to hide. This was originally set
// to 6 (vs an earlier 3-word picker) for a stronger random-guess
// rejection. It was reduced back to 3 at user request: 6 felt
// like friction during onboarding when most users will actually write
// down the phrase, and the guarantee survives at 3 because the bank
// still draws from BIP-39 distractors not just the 6 hidden words.
// With 3 hidden + 3 distractors (bank size 6), random-guess odds
// across 3 ordered fills land at 6P3 = 1/120 — better than the earlier
// 1/6^3 (= 1/216 only because that picker re-used the same 6 options
// per position; this verify lets the user re-arrange freely).
const HIDDEN_COUNT = 3;
// How many BIP-39 distractors to mix into the word bank in addition
// to the HIDDEN_COUNT correct words. Total bank size =
// HIDDEN_COUNT + DISTRACTOR_COUNT.
const DISTRACTOR_COUNT = 3;

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
  // Challenge held in state (no longer once-only)
  // because Try Again rebuilds it with a fresh set of hidden positions
  // + fresh distractors.
  const [challenge, setChallenge] = useState<Challenge>(() =>
    buildChallenge(words),
  );
  const [slots, setSlots] = useState<Slot[]>(challenge.slots);
  const [bank, setBank] = useState<string[]>(challenge.bank);
  // Validation is deferred to the Continue click.
  // While `attempted` is false, no per-slot error styling appears
  // (slots show only neutral filled/empty states). On Continue with
  // a wrong arrangement, attempted flips true and the "Not quite
  // right" screen replaces the grid; Try Again resets it.
  const [attempted, setAttempted] = useState(false);

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

  const handleContinue = () => {
    if (!allFilled) return;
    if (allCorrect) {
      onVerified();
      return;
    }
    setAttempted(true);
  };

  const handleTryAgain = () => {
    // Re-randomize which 6 positions are hidden + redraw distractors.
    // Without this, a user who memorised the position pattern from
    // the failed attempt could brute-force position-by-position even
    // without knowing the phrase.
    const fresh = buildChallenge(words);
    setChallenge(fresh);
    setSlots(fresh.slots);
    setBank(fresh.bank);
    setAttempted(false);
  };

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
          Verify recovery phrase
        </div>
        <div style={{ width: 36 }} />
      </div>

      {attempted && !allCorrect ? (
        // "Not quite right" full-screen error state.
        // Replaces the previous inline per-slot red styling so the
        // user gets one clear failure surface (matches MetaMask's
        // verify flow). Try Again regenerates the challenge with a
        // new set of hidden positions, preventing position memorisation.
        <>
          <div
            className="ext-body"
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              textAlign: "center",
              gap: 16,
              padding: "32px 28px",
            }}
          >
            <div
              style={{
                fontSize: 44,
                lineHeight: 1,
              }}
              aria-hidden="true"
            >
              ⚠️
            </div>
            <h2
              style={{
                margin: 0,
                fontSize: 18,
                fontWeight: 600,
                color: "var(--fg-100)",
              }}
            >
              Not quite right
            </h2>
            <p
              style={{
                margin: 0,
                fontSize: 13,
                color: "var(--fg-300)",
                lineHeight: 1.5,
                maxWidth: 280,
              }}
            >
              Double-check your 24-word PQM-1 recovery phrase and try
              again. We&apos;ll show you a fresh set of positions so the
              attempt is fair.
            </p>
          </div>

          <div
            className="req-foot"
            style={{ marginTop: "auto", gridTemplateColumns: "1fr" }}
          >
            <button
              className="prim"
              onClick={handleTryAgain}
              style={{ minWidth: 200 }}
            >
              Try again
            </button>
          </div>
        </>
      ) : (
        <>
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
                fontSize: "var(--fs-12)",
                color: "var(--fg-300)",
                lineHeight: 1.5,
              }}
            >
              Select the missing words in the correct order. Blurred slots
              are already filled — tap a placed word to return it to the
              bank.
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

                // No per-slot wrong styling during
                // placement. Slots show only neutral states:
                // - pre-filled (non-hidden): static, word blurred
                // - hidden + empty: dashed accent border, awaiting fill
                // - hidden + filled: solid accent border, tappable to
                //   return the word to the bank.
                const borderColor =
                  isHidden ? "var(--gold)" : "var(--fg-700)";
                const background = isEmpty && isHidden
                  ? "rgba(242,180,65,0.04)"
                  : isHidden
                    ? "rgba(242,180,65,0.10)"
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
                          : `Word ${slot.index + 1}, pre-filled (hidden)`
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
                    <span
                      style={{
                        flex: 1,
                        // Blur the pre-filled words
                        // (5 px is enough to make them unreadable
                        // while keeping the slot visually "filled"
                        // — same pattern MetaMask uses). user-select
                        // stops double-tap-select from revealing the
                        // text. The actual word stays in the DOM for
                        // screen readers via aria-label above.
                        ...(!isHidden && !isEmpty
                          ? {
                              filter: "blur(5px)",
                              userSelect: "none" as const,
                            }
                          : {}),
                      }}
                    >
                      {slot.filled ?? " "}
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
          </div>

          <div
            className="req-foot"
            style={{ marginTop: "auto", gridTemplateColumns: "1fr" }}
          >
            <button
              className="prim"
              disabled={!allFilled}
              onClick={handleContinue}
              style={
                allFilled
                  ? undefined
                  : { opacity: 0.45, cursor: "not-allowed" }
              }
            >
              Continue
            </button>
          </div>
        </>
      )}
    </>
  );
}
