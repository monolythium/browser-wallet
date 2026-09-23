// The intent digest is what stops a surviving idempotency key from replaying a
// transaction the user has since edited (§0 / row 3). These pin BOTH halves of
// that contract: every field that constitutes a different transaction changes
// the digest, and the fields deliberately left out do not — because including
// them would make every retry read as an edit and kill idempotency, which is the
// double-send the binding store exists to prevent.

import { describe, expect, it } from "vitest";

import { sendIntentDigest, type SendIntent } from "./send-intent-digest";

const BASE: SendIntent = {
  from: "0x1111111111111111111111111111111111111111",
  to: "0x2222222222222222222222222222222222222222",
  value: "0xde0b6b3a7640000",
  data: "0x",
  chainIdHex: "0x10F2C",
};

describe("sendIntentDigest — the same intent digests the same", () => {
  it("is deterministic", () => {
    expect(sendIntentDigest(BASE)).toBe(sendIntentDigest({ ...BASE }));
  });

  it("ignores hex CASING — 0xAB and 0xab are the same address, not an edit", () => {
    expect(sendIntentDigest({ ...BASE, to: BASE.to!.toUpperCase() })).toBe(
      sendIntentDigest(BASE),
    );
    expect(sendIntentDigest({ ...BASE, chainIdHex: "0x10f2c" })).toBe(
      sendIntentDigest(BASE),
    );
  });
});

describe("sendIntentDigest — a different transaction digests differently", () => {
  // The row-3 case itself: the recipient is what the hand test changed.
  it("CHANGES when the recipient changes", () => {
    expect(
      sendIntentDigest({
        ...BASE,
        to: "0x3333333333333333333333333333333333333333",
      }),
    ).not.toBe(sendIntentDigest(BASE));
  });

  it("CHANGES when the amount changes", () => {
    expect(sendIntentDigest({ ...BASE, value: "0x1" })).not.toBe(
      sendIntentDigest(BASE),
    );
  });

  it("CHANGES when the calldata changes — staking, names and policy ops live here", () => {
    expect(sendIntentDigest({ ...BASE, data: "0xdeadbeef" })).not.toBe(
      sendIntentDigest(BASE),
    );
  });

  it("CHANGES when the chain changes", () => {
    expect(sendIntentDigest({ ...BASE, chainIdHex: "0x1" })).not.toBe(
      sendIntentDigest(BASE),
    );
  });

  it("CHANGES when the sender changes — a vault switch between attempts", () => {
    expect(
      sendIntentDigest({
        ...BASE,
        from: "0x4444444444444444444444444444444444444444",
      }),
    ).not.toBe(sendIntentDigest(BASE));
  });

  it("distinguishes an absent field from an empty one — no run-together collision", () => {
    // Without a separator, {to:"0xab", value:"0xcd"} and {to:"0xabcd", value:""}
    // would render alike. The delimiter is what makes that impossible.
    const a = sendIntentDigest({ ...BASE, to: "0xab", value: "0xcd" });
    const b = sendIntentDigest({ ...BASE, to: "0xabcd", value: "" });
    expect(a).not.toBe(b);
  });
});

describe("sendIntentDigest — the deliberate exclusions", () => {
  // THE LOAD-BEARING ONE. `multisig-execute` calls suggestFee at execute time
  // and the name ops re-quote from the live base fee immediately before signing,
  // so the fee legitimately differs between two attempts at the SAME request.
  // If it were in the digest, every retry there would read as an edit, the
  // binding would never fire, and the double-send would come back.
  it("does NOT depend on any fee field — a re-quoted fee is not an edit", () => {
    const withFees = {
      ...BASE,
      maxFeePerGas: "0x9",
      maxPriorityFeePerGas: "0x1",
      gas: "0x5208",
    } as SendIntent;
    expect(sendIntentDigest(withFees)).toBe(sendIntentDigest(BASE));
  });

  // The nonce is derived inside the submit path, never chosen by the user. A
  // differing nonce means the tracker moved on — the exact case the replay
  // exists to serve.
  it("does NOT depend on the nonce", () => {
    const withNonce = { ...BASE, nonce: "0x7" } as SendIntent;
    expect(sendIntentDigest(withNonce)).toBe(sendIntentDigest(BASE));
  });
});
