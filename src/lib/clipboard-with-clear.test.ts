import { describe, expect, it } from "vitest";

import { formatPhraseForClipboard } from "./clipboard-with-clear";

describe("formatPhraseForClipboard", () => {
  it("copies bare words with no ordinal numbers", () => {
    const phrase =
      "abandon ability able about above absent absorb abstract " +
      "absurd abuse access accident account accuse achieve acid " +
      "acoustic acquire across act action actor actress actual";
    const out = formatPhraseForClipboard(phrase);

    expect(out).toBe(phrase);
    // No "1." / "2." … ordinal prefixes anywhere.
    expect(out).not.toMatch(/\d+\./);
    // Word order is preserved exactly.
    expect(out.split(" ")).toHaveLength(24);
    expect(out.split(" ")[0]).toBe("abandon");
    expect(out.split(" ")[23]).toBe("actual");
  });

  it("normalizes stray whitespace so onboarding + Settings copies match byte-for-byte", () => {
    // Onboarding (MnemonicGrid) splits on /\s+/ then joins; Settings
    // (RevealPhrase) feeds the raw mnemonic. Both route through this helper,
    // so a clean phrase and a padded one must yield the identical payload.
    const clean = "alpha bravo charlie delta";
    expect(formatPhraseForClipboard(clean)).toBe(clean);
    expect(formatPhraseForClipboard("  alpha   bravo  charlie delta  ")).toBe(
      clean,
    );
  });
});
