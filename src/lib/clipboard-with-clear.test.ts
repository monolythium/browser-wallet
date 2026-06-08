import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cancelClipboardAutoClear,
  copyWithAutoClear,
  flushClipboardAutoClear,
  formatPhraseForClipboard,
} from "./clipboard-with-clear";

// Stub navigator.clipboard with an in-memory store. readText returns the
// current store (or rejects when `readTextRejects`); writeText sets it.
function installClipboard(readTextRejects = false, writeEmptyRejects = false) {
  let store = "";
  const writeText = vi.fn(async (t: string) => {
    // Optionally reject only the CLEAR write (writeText("")) while letting the
    // initial copy succeed — mirrors Chromium denying a non-gesture writeText
    // when the extension lacks clipboardWrite.
    if (writeEmptyRejects && t === "") throw new Error("writeText denied");
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
  vi.restoreAllMocks();
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

describe("pagehide backstop (popup-close best-effort wipe)", () => {
  // The pagehide listener is armed lazily inside copyWithAutoClear and bound
  // by reference to the current `window`. Each test stubs a fresh EventTarget
  // as `window`; the module re-binds to it on the next copy.
  function installWindow() {
    const target = new EventTarget();
    const addSpy = vi.spyOn(target, "addEventListener");
    vi.stubGlobal("window", target);
    return {
      addSpy,
      firePagehide: () => target.dispatchEvent(new Event("pagehide")),
    };
  }

  it("wipes a pending seed copy when the document unloads (pagehide)", async () => {
    const win = installWindow();
    const cb = installClipboard();
    await copyWithAutoClear("my-seed-phrase", 1_000_000);
    expect(cb.getStore()).toBe("my-seed-phrase");
    cb.writeText.mockClear();

    win.firePagehide();
    await Promise.resolve(); // let the fire-and-forget wipe settle

    expect(cb.writeText).toHaveBeenCalledWith("");
    expect(cb.getStore()).toBe("");
  });

  it("is a no-op on a later pagehide once nothing is pending", async () => {
    const win = installWindow();
    const cb = installClipboard();
    await copyWithAutoClear("my-seed-phrase", 1_000_000);
    win.firePagehide(); // wipes and clears the pending copy
    await Promise.resolve();
    cb.writeText.mockClear();

    win.firePagehide(); // nothing pending now → no-op
    await Promise.resolve();

    expect(cb.writeText).not.toHaveBeenCalled();
  });

  it("arms the pagehide listener once across multiple copies", async () => {
    const win = installWindow();
    installClipboard();
    await copyWithAutoClear("seed-1", 1_000_000);
    await copyWithAutoClear("seed-2", 1_000_000);

    const pagehideAdds = win.addSpy.mock.calls.filter(
      ([type]) => type === "pagehide",
    );
    expect(pagehideAdds).toHaveLength(1);
  });
});

describe("clear-write failure is surfaced (#clipboardWrite)", () => {
  it("warns (without throwing) when the flush clear write is denied", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cb = installClipboard(false, true); // writeText("") rejects
    await copyWithAutoClear("my-seed-phrase", 1_000_000); // copy succeeds
    cb.writeText.mockClear();

    await expect(flushClipboardAutoClear()).resolves.toBeUndefined();

    expect(cb.writeText).toHaveBeenCalledWith(""); // the clear was attempted
    expect(warn).toHaveBeenCalled(); // and the denial was surfaced
  });

  it("warns (without throwing) when the 30 s timer clear write is denied", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cb = installClipboard(false, true);
    await copyWithAutoClear("my-seed-phrase", 30_000);
    cb.writeText.mockClear();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(cb.writeText).toHaveBeenCalledWith("");
    expect(warn).toHaveBeenCalled();
  });
});
