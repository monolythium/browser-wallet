import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cancelClipboardAutoClear,
  copyWithAutoClear,
  flushClipboardAutoClear,
  formatPhraseForClipboard,
} from "./clipboard-with-clear";

// Stub navigator.clipboard with an in-memory store. readText returns the
// current store (or rejects when `readTextRejects`); writeText sets it.
function installClipboard(readTextRejects = false) {
  let store = "";
  const writeText = vi.fn(async (t: string) => {
    store = t;
  });
  const readText = vi.fn(async () => {
    if (readTextRejects) throw new Error("readText denied");
    return store;
  });
  vi.stubGlobal("navigator", { clipboard: { writeText, readText } });
  return {
    writeText,
    readText,
    setStore: (v: string) => {
      store = v;
    },
    getStore: () => store,
  };
}

afterEach(() => {
  cancelClipboardAutoClear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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

describe("flushClipboardAutoClear (#39 wipe-on-unmount)", () => {
  it("wipes NOW when the clipboard still holds our copied phrase", async () => {
    const cb = installClipboard();
    await copyWithAutoClear("my-seed-phrase", 1_000_000);
    expect(cb.getStore()).toBe("my-seed-phrase");
    cb.writeText.mockClear();

    await flushClipboardAutoClear();

    expect(cb.writeText).toHaveBeenCalledWith("");
    expect(cb.getStore()).toBe("");
  });

  it("does NOT clobber a value the user copied after ours", async () => {
    const cb = installClipboard();
    await copyWithAutoClear("my-seed-phrase", 1_000_000);
    // User copies something else after the seed.
    cb.setStore("user-copied-this-later");
    cb.writeText.mockClear();

    await flushClipboardAutoClear();

    expect(cb.writeText).not.toHaveBeenCalled();
    expect(cb.getStore()).toBe("user-copied-this-later");
  });

  it("blind-wipes when readText is denied (seed-safety priority)", async () => {
    const cb = installClipboard(true); // readText rejects
    await copyWithAutoClear("my-seed-phrase", 1_000_000);
    cb.writeText.mockClear();

    await flushClipboardAutoClear();

    expect(cb.writeText).toHaveBeenCalledWith("");
  });

  it("is a no-op when no copy is pending", async () => {
    const cb = installClipboard();
    // cancelClipboardAutoClear in afterEach guarantees no pending copy.
    await flushClipboardAutoClear();
    expect(cb.writeText).not.toHaveBeenCalled();
    expect(cb.readText).not.toHaveBeenCalled();
  });

  it("the 30 s timer path still wipes if the component stays mounted", async () => {
    vi.useFakeTimers();
    const cb = installClipboard();
    await copyWithAutoClear("my-seed-phrase", 30_000);
    cb.writeText.mockClear();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(cb.writeText).toHaveBeenCalledWith("");
  });
});
