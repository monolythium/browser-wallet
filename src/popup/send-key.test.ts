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

import {
  autoCompoundKeyParams,
  claimKeyParams,
  emergencyKeyParams,
  nameAcceptKeyParams,
  nameProposeKeyParams,
  nameRegisterKeyParams,
  nextSendKey,
  unstakeAllKeyParams,
  type SendKeyState,
} from "./send-key";

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

// ── The shape-D surfaces converted afterwards ───────────────────────────────
//
// `nextSendKey` above is proven to break a carry when params differ. That only
// protects a surface if the surface's params actually CONTAIN its editable
// field, which is a property of the builder, not of the rule. These assert the
// property — that editing the field changes the key — rather than the exact
// string, so a rewording of the params format cannot make them pass vacuously
// while the guard silently stops working.

/** Retry the same logical send with `params`, starting from a key minted
 *  against `mintedAgainst`. Returns the key the retry would carry. */
function keyAfterRetry(mintedAgainst: string, params: string): string | null {
  const first = nextSendKey(null, "submit", mintedAgainst, minter("original"));
  return nextSendKey(first.next, "retry", params, minter("fresh")).use;
}

describe("auto-compound: the toggle target is part of the identity", () => {
  const CHAIN = "0x10F2C";

  it("carries the key when the user retries the SAME target", () => {
    const p = autoCompoundKeyParams(true, CHAIN);
    expect(keyAfterRetry(p, p)).toBe("original");
  });

  it("MINTS FRESH when a failed enable is abandoned and a disable confirmed", () => {
    // Row 3 for this surface. Enabling also claims pending rewards, so replaying
    // it while the modal says Disable moves funds the user just decided against.
    const enable = autoCompoundKeyParams(true, CHAIN);
    const disable = autoCompoundKeyParams(false, CHAIN);
    expect(enable).not.toBe(disable);
    expect(keyAfterRetry(enable, disable)).toBe("fresh");
  });

  it("MINTS FRESH across a chain switch", () => {
    expect(
      keyAfterRetry(autoCompoundKeyParams(true, CHAIN), autoCompoundKeyParams(true, "0x1")),
    ).toBe("fresh");
  });
});

describe("emergency-key registration: the public key is part of the identity", () => {
  const V = "vault-1";
  const CHAIN = "0x10F2C";
  const PK_A = "aa".repeat(32);
  const PK_B = "bb".repeat(32);

  it("carries the key when retrying the same registration", () => {
    const p = emergencyKeyParams(V, PK_A, CHAIN);
    expect(keyAfterRetry(p, p)).toBe("original");
  });

  it("MINTS FRESH when the backup was cleared and regenerated", () => {
    // Same vault id, different key material. Without the pubkey in params this
    // would replay the registration of a key the user just replaced.
    expect(
      keyAfterRetry(emergencyKeyParams(V, PK_A, CHAIN), emergencyKeyParams(V, PK_B, CHAIN)),
    ).toBe("fresh");
  });
});

describe("claim: no editable field, so the release is what keeps it safe", () => {
  const CHAIN = "0x10F2C";

  it("is constant for a chain — the guard cannot break a claim carry", () => {
    expect(claimKeyParams(CHAIN)).toBe(claimKeyParams(CHAIN));
    expect(keyAfterRetry(claimKeyParams(CHAIN), claimKeyParams(CHAIN))).toBe("original");
  });

  it("a claim that SUCCEEDED releases, so the next claim is independent", () => {
    // This is the whole safety argument for constant params: without the
    // release, one key would cover every future claim on the chain.
    const p = claimKeyParams(CHAIN);
    const first = nextSendKey(null, "submit", p, minter("original"));
    const released = nextSendKey(first.next, "success", p, minter("unused"));
    expect(released.next).toBeNull();
    expect(nextSendKey(released.next, "submit", p, minter("second")).use).toBe("second");
  });

  it("still separates chains", () => {
    expect(keyAfterRetry(claimKeyParams(CHAIN), claimKeyParams("0x1"))).toBe("fresh");
  });
});

// ── Unstake-all walk-through ────────────────────────────────────────────────
//
// PER ITEM, and the reason is mechanical rather than a preference: a
// `SendBinding` holds one `wireHex`. A batch-wide key would replay the first
// cluster's signed bytes for a later cluster — undelegating one cluster while
// the screen names another.

describe("unstake-all: each cluster is its own logical send", () => {
  const CHAIN = "0x10F2C";

  it("gives different clusters different params", () => {
    // The property that stops one item replaying another's bytes.
    const ids = [1, 2, 3, 40].map((c) => unstakeAllKeyParams(c, CHAIN));
    expect(new Set(ids).size).toBe(4);
  });

  it("REUSES the key when the same cluster is retried — mint never called", () => {
    // Asserting `use === "original"` alone would pass even if the key had been
    // regenerated to an equal value. The binding property is that no NEW key was
    // minted, so the service worker recognises the confirmation.
    const p = unstakeAllKeyParams(7, CHAIN);
    const first = nextSendKey(null, "submit", p, minter("item-7"));
    const mint = vi.fn(() => "should-never-be-called");
    const retry = nextSendKey(first.next, "retry", p, mint);
    expect(retry.use).toBe("item-7");
    expect(mint).not.toHaveBeenCalled();
  });

  it("MINTS FRESH when the cluster changes under a carried state", () => {
    // The guard behind the guard. Advancing normally clears the error so the
    // next item reads "submit" anyway; this proves that even if a retry action
    // reached the next cluster, its bytes could not be replayed.
    expect(
      keyAfterRetry(unstakeAllKeyParams(7, CHAIN), unstakeAllKeyParams(9, CHAIN)),
    ).toBe("fresh");
  });

  it("MINTS FRESH for every item of a walk-through, so no two share a key", () => {
    // Walk three clusters as the flow does: submit, release on success, submit.
    const mint = minter("k1", "k2", "k3");
    let state: SendKeyState = null;
    const used: (string | null)[] = [];
    for (const cluster of [7, 9, 11]) {
      const d = nextSendKey(state, "submit", unstakeAllKeyParams(cluster, CHAIN), mint);
      used.push(d.use);
      state = null; // released on success, exactly as the handler does
    }
    expect(used).toEqual(["k1", "k2", "k3"]);
    expect(new Set(used).size).toBe(3);
  });

  it("MINTS FRESH across a chain switch", () => {
    expect(
      keyAfterRetry(unstakeAllKeyParams(7, CHAIN), unstakeAllKeyParams(7, "0x1")),
    ).toBe("fresh");
  });

  it("cannot carry into the single-cluster undelegate flow", () => {
    // Both encode the same calldata for the same cluster, so distinct prefixes
    // are what keep one flow's key out of the other's.
    expect(unstakeAllKeyParams(7, CHAIN)).not.toBe(`undelegate|7||0x0|${CHAIN}`);
  });
});

// ── Name operations ─────────────────────────────────────────────────────────
//
// Row 3 with a permanent on-chain consequence: replaying under an edit here
// means the user pays real LYTH to register a name they just decided against,
// while the screen shows the new one. Two of the three ops spend real value.

describe("name register: the name is the request", () => {
  const CHAIN = "0x10F2C";

  it("carries the key when the user retries the SAME name", () => {
    const p = nameRegisterKeyParams("alice.mono", CHAIN);
    expect(keyAfterRetry(p, p)).toBe("original");
  });

  it("MINTS FRESH when the user edits the name and retries", () => {
    // The assertion this whole pass exists for. Without it the wallet would
    // re-broadcast the signed registration of `alice.mono` while the form —
    // and the confirm card — say `bob.mono`.
    expect(
      keyAfterRetry(
        nameRegisterKeyParams("alice.mono", CHAIN),
        nameRegisterKeyParams("bob.mono", CHAIN),
      ),
    ).toBe("fresh");
  });

  it("MINTS FRESH on a one-character edit", () => {
    expect(
      keyAfterRetry(
        nameRegisterKeyParams("alice.mono", CHAIN),
        nameRegisterKeyParams("alicee.mono", CHAIN),
      ),
    ).toBe("fresh");
  });

  it("treats a case-only difference as the SAME name", () => {
    // The chain-side validator canonicalises to lower case, so these are one
    // registration. Minting here would silently disable the mechanism for any
    // user whose keyboard capitalised the first letter.
    expect(nameRegisterKeyParams("Alice.Mono", CHAIN)).toBe(
      nameRegisterKeyParams("alice.mono", CHAIN),
    );
  });

  it("MINTS FRESH across a chain switch", () => {
    expect(
      keyAfterRetry(
        nameRegisterKeyParams("alice.mono", CHAIN),
        nameRegisterKeyParams("alice.mono", "0x1"),
      ),
    ).toBe("fresh");
  });
});

describe("name propose: the resolved recipient is part of the request", () => {
  const CHAIN = "0x10F2C";
  const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  it("carries the key on an unchanged retry", () => {
    const p = nameProposeKeyParams("alice.mono", A, CHAIN);
    expect(keyAfterRetry(p, p)).toBe("original");
  });

  it("MINTS FRESH when the recipient changes", () => {
    // Including the case where the user re-typed the same `.mono` recipient and
    // it resolved to a different owner: the signed address changed, so the
    // request changed.
    expect(
      keyAfterRetry(
        nameProposeKeyParams("alice.mono", A, CHAIN),
        nameProposeKeyParams("alice.mono", B, CHAIN),
      ),
    ).toBe("fresh");
  });

  it("MINTS FRESH when the name changes but the recipient does not", () => {
    expect(
      keyAfterRetry(
        nameProposeKeyParams("alice.mono", A, CHAIN),
        nameProposeKeyParams("bob.mono", A, CHAIN),
      ),
    ).toBe("fresh");
  });

  it("treats recipient address casing as display-only", () => {
    expect(nameProposeKeyParams("alice.mono", A.toUpperCase().replace("0X", "0x"), CHAIN)).toBe(
      nameProposeKeyParams("alice.mono", A, CHAIN),
    );
  });
});

describe("name accept: identified by the name alone", () => {
  const CHAIN = "0x10F2C";

  it("carries the key on an unchanged retry", () => {
    const p = nameAcceptKeyParams("alice.mono", CHAIN);
    expect(keyAfterRetry(p, p)).toBe("original");
  });

  it("MINTS FRESH when the name changes — this one re-charges the full cost", () => {
    expect(
      keyAfterRetry(
        nameAcceptKeyParams("alice.mono", CHAIN),
        nameAcceptKeyParams("bob.mono", CHAIN),
      ),
    ).toBe("fresh");
  });
});

describe("a re-quoted cost cannot break a name carry", () => {
  // The trap, asserted as a round trip rather than by inspection. `submitNameTx`
  // re-quotes the cost from the live base fee immediately before signing, so the
  // second attempt prices differently. Because params never see the cost, the
  // retry still matches — and `mint` is never called, which is the observable
  // proof that the original key was reused rather than a coincidentally equal
  // one being generated.
  it("reuses without minting across attempts priced differently", () => {
    const CHAIN = "0x10F2C";
    const attempt1 = nameRegisterKeyParams("alice.mono", CHAIN);
    const first = nextSendKey(null, "submit", attempt1, minter("original"));

    // Time passes; the base fee moves; the cost is re-quoted. Params are built
    // from intent alone, so they are identical.
    const attempt2 = nameRegisterKeyParams("alice.mono", CHAIN);
    expect(attempt2).toBe(attempt1);

    const mint = vi.fn(() => "should-never-be-called");
    const retry = nextSendKey(first.next, "retry", attempt2, mint);
    expect(retry.use).toBe("original");
    expect(mint).not.toHaveBeenCalled();
  });
});

describe("no builder embeds live-moving data", () => {
  // The trap send-key.ts documents: a quoted fee or gas estimate in params makes
  // every retry look like an edit, and the mechanism never fires. Observable as
  // determinism — same intent in, same string out, no matter when it is called.
  it("is deterministic for the same user intent", () => {
    expect(autoCompoundKeyParams(true, "0x10F2C")).toBe(autoCompoundKeyParams(true, "0x10F2C"));
    expect(emergencyKeyParams("v", "aa", "0x10F2C")).toBe(emergencyKeyParams("v", "aa", "0x10F2C"));
    expect(claimKeyParams("0x10F2C")).toBe(claimKeyParams("0x10F2C"));
    expect(nameRegisterKeyParams("a.mono", "0x10F2C")).toBe(
      nameRegisterKeyParams("a.mono", "0x10F2C"),
    );
    expect(nameProposeKeyParams("a.mono", "0xab", "0x10F2C")).toBe(
      nameProposeKeyParams("a.mono", "0xab", "0x10F2C"),
    );
    expect(nameAcceptKeyParams("a.mono", "0x10F2C")).toBe(
      nameAcceptKeyParams("a.mono", "0x10F2C"),
    );
  });

  it("keeps the three name ops distinct from each other", () => {
    // Same name, same chain, three different transactions. A shared params
    // string would let a failed register carry its key into an accept.
    const N = "alice.mono";
    const C = "0x10F2C";
    const all = [
      nameRegisterKeyParams(N, C),
      nameProposeKeyParams(N, "0xab", C),
      nameAcceptKeyParams(N, C),
    ];
    expect(new Set(all).size).toBe(3);
  });
});
