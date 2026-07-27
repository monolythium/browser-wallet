// The send-idempotency key scoping rule.
//
// The key identifies one logical send. A retry of that send must reuse it, so
// the service worker re-broadcasts the bytes it already signed instead of
// deriving a new nonce and landing a SECOND transaction. Anything that is not a
// retry must mint a fresh key so a genuine second send gets its own nonce.
//
// The rule is CARRIED BY THE ACTION, not derived from form state: the surfaces
// that reach a submit have four different retry shapes and three of them have
// no usable form tuple, so there is nothing uniform to derive from.
//
// ROW 3 IS THE DANGEROUS ONE and most of this file is about it. In the
// form-round-trip shape the retry returns the user to the form, so they can EDIT
// the transaction and then confirm. Carrying the key blindly would replay the
// ORIGINAL transaction while the interface shows the edited one — funds to a
// recipient the user just decided against, with the UI saying otherwise. That is
// a WYSIWYS violation and it is worse than the double-send this work prevents,
// because a double-send at least goes where the user chose. Hence the params
// guard: a carried key is honoured only if the submit still matches what the key
// was minted against.

import { describe, expect, it, vi } from "vitest";

import { nextSendKey, type SendKeyState } from "./send-key";

/** Deterministic mint so assertions can name exact keys. */
function minter(...values: string[]): () => string {
  let i = 0;
  return () => values[i++] ?? `overflow-${i}`;
}

const P1 = "0xalice|0x64|normal";
const P2 = "0xbob|0x64|normal";

describe("submit — always a new logical send", () => {
  it("mints when there is no prior state", () => {
    const r = nextSendKey(null, "submit", P1, minter("k1"));
    expect(r.use).toBe("k1");
    expect(r.next).toEqual({ key: "k1", params: P1 });
  });

  it("mints AGAIN after a previous attempt — a repeat press is not a retry", () => {
    // Shape D (no retry affordance) relies on this: pressing the primary button
    // again is ambiguous, so it is treated as a new send, never as a replay.
    const prev: SendKeyState = { key: "k1", params: P1 };
    const r = nextSendKey(prev, "submit", P1, minter("k2"));
    expect(r.use).toBe("k2");
    expect(r.next).toEqual({ key: "k2", params: P1 });
  });
});

describe("retry — reuses ONLY when the transaction is unchanged", () => {
  it("reuses the key when params match", () => {
    const prev: SendKeyState = { key: "k1", params: P1 };
    const mint = vi.fn(() => "SHOULD-NOT-BE-USED");
    const r = nextSendKey(prev, "retry", P1, mint);
    expect(r.use).toBe("k1");
    expect(r.next).toEqual({ key: "k1", params: P1 });
    expect(mint).not.toHaveBeenCalled();
  });

  it("ROW 3: mints fresh when the RECIPIENT changed — never replays the original", () => {
    const prev: SendKeyState = { key: "k1", params: P1 };
    const r = nextSendKey(prev, "retry", P2, minter("k2"));
    expect(r.use).toBe("k2");
    expect(r.use).not.toBe("k1");
    expect(r.next).toEqual({ key: "k2", params: P2 });
  });

  it("ROW 3: mints fresh when the AMOUNT changed", () => {
    const prev: SendKeyState = { key: "k1", params: "0xalice|0x64|normal" };
    const r = nextSendKey(prev, "retry", "0xalice|0x65|normal", minter("k2"));
    expect(r.use).toBe("k2");
  });

  it("ROW 3: mints fresh when the FEE TIER changed", () => {
    const prev: SendKeyState = { key: "k1", params: "0xalice|0x64|normal" };
    const r = nextSendKey(prev, "retry", "0xalice|0x64|fast", minter("k2"));
    expect(r.use).toBe("k2");
  });

  it("ROW 3: a single character of difference is enough to mint fresh", () => {
    // The comparison is exact. Anything that changes the transaction the user
    // is looking at must break the carry.
    const prev: SendKeyState = { key: "k1", params: P1 };
    const r = nextSendKey(prev, "retry", P1 + " ", minter("k2"));
    expect(r.use).toBe("k2");
  });

  it("ROW 4: edited away and back again REUSES — the original may have landed", () => {
    // The user changes the amount, changes it back, then confirms. The
    // transaction is identical to the one that may already be on-chain, so the
    // carry is correct and a replay is what protects them.
    const prev: SendKeyState = { key: "k1", params: P1 };
    const r = nextSendKey(prev, "retry", P1, minter("k2"));
    expect(r.use).toBe("k1");
  });

  it("ROW 7: mints fresh when there is no prior state — a reopened popup", () => {
    // Component state died with the popup. Nothing to carry; the normal path is
    // the honest fallback. This is the residual row 7 leaves open.
    const r = nextSendKey(null, "retry", P1, minter("k2"));
    expect(r.use).toBe("k2");
    expect(r.next).toEqual({ key: "k2", params: P1 });
  });

  it("is idempotent — retrying twice unchanged keeps one key", () => {
    let s: SendKeyState = { key: "k1", params: P1 };
    const first = nextSendKey(s, "retry", P1, minter("nope-1"));
    s = first.next;
    const second = nextSendKey(s, "retry", P1, minter("nope-2"));
    expect(first.use).toBe("k1");
    expect(second.use).toBe("k1");
  });
});

describe("success — a landed send releases the key", () => {
  it("clears the state so a deliberate second identical send gets its own nonce", () => {
    // ROW 2. Without this, sending the same amount to the same address twice
    // would be swallowed as a replay of the first.
    const prev: SendKeyState = { key: "k1", params: P1 };
    const r = nextSendKey(prev, "success", P1, minter("unused"));
    expect(r.use).toBeNull();
    expect(r.next).toBeNull();
  });

  it("a submit after success mints a DIFFERENT key", () => {
    const cleared = nextSendKey({ key: "k1", params: P1 }, "success", P1, minter("x"));
    const again = nextSendKey(cleared.next, "submit", P1, minter("k2"));
    expect(again.use).toBe("k2");
  });
});

describe("reset — starting over is a new send", () => {
  it("clears the state", () => {
    // Shape C wipes its form on retry, so that retry is genuinely 'start over'.
    const r = nextSendKey({ key: "k1", params: P1 }, "reset", P1, minter("unused"));
    expect(r.use).toBeNull();
    expect(r.next).toBeNull();
  });

  it("a retry after a reset cannot resurrect the old key", () => {
    const cleared = nextSendKey({ key: "k1", params: P1 }, "reset", P1, minter("x"));
    const r = nextSendKey(cleared.next, "retry", P1, minter("k2"));
    expect(r.use).toBe("k2");
  });
});

describe("the mint function is called only when a key is actually needed", () => {
  it("never mints on success or reset", () => {
    const mint = vi.fn(() => "SHOULD-NOT-BE-USED");
    nextSendKey({ key: "k1", params: P1 }, "success", P1, mint);
    nextSendKey({ key: "k1", params: P1 }, "reset", P1, mint);
    expect(mint).not.toHaveBeenCalled();
  });

  it("mints exactly once per new logical send", () => {
    const mint = vi.fn(() => "k1");
    nextSendKey(null, "submit", P1, mint);
    expect(mint).toHaveBeenCalledTimes(1);
  });
});
