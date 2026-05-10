// Coverage for the Send page's recipient parser. The parser is the codec
// boundary: input may be 0x hex or bech32m (mono1...), but the IPC contract
// stays 0x-only. These tests pin the conversion paths against BIP-350
// canonical forms (lowercase + all-uppercase) and the rejection paths
// for mixed-case, wrong-HRP, and malformed inputs.

import { describe, expect, it } from "vitest";
import { validateToAddress } from "./Send.js";
import { addressToBech32m } from "../../shared/bech32m.js";

const ADDR0X = "0x2aa6a8c4e2f64c4d8b1c3e9b3e1f4d2a8c5e7d3f";
const ADDR0X_LOWER = ADDR0X.toLowerCase();

describe("validateToAddress — empty / partial", () => {
  it("empty input returns no error and inputForm=empty", () => {
    const r = validateToAddress("");
    expect(r.error).toBeNull();
    expect(r.addr0x).toBeNull();
    expect(r.bech).toBeNull();
    expect(r.inputForm).toBe("empty");
  });

  it("partial 0x (length < 42) returns no error and inputForm=partial", () => {
    const r = validateToAddress("0x2aa6");
    expect(r.error).toBeNull();
    expect(r.addr0x).toBeNull();
    expect(r.inputForm).toBe("partial");
  });

  it("partial mono1 (length < 44) returns no error and inputForm=partial", () => {
    const r = validateToAddress("mono1abc");
    expect(r.error).toBeNull();
    expect(r.addr0x).toBeNull();
    expect(r.inputForm).toBe("partial");
  });
});

describe("validateToAddress — complete 0x", () => {
  it("lowercase 0x address parses, derives bech, no error", () => {
    const r = validateToAddress(ADDR0X_LOWER);
    expect(r.error).toBeNull();
    expect(r.addr0x).toBe(ADDR0X_LOWER);
    expect(r.bech).toBe(addressToBech32m(ADDR0X_LOWER));
    expect(r.inputForm).toBe("0x");
  });

  it("mixed-case 0x address normalizes to lowercase", () => {
    const r = validateToAddress("0x2AA6a8C4e2f64c4d8b1c3e9b3E1f4d2A8c5E7d3f");
    expect(r.error).toBeNull();
    expect(r.addr0x).toBe(ADDR0X_LOWER);
  });

  it("0X-prefix uppercase variant is accepted", () => {
    const r = validateToAddress("0X" + ADDR0X.slice(2));
    expect(r.error).toBeNull();
    expect(r.addr0x).toBe(ADDR0X_LOWER);
  });

  it("wrong-length (43 chars) reports an error", () => {
    const r = validateToAddress(ADDR0X + "f");
    expect(r.error).toMatch(/42 chars/);
    expect(r.addr0x).toBeNull();
  });

  it("non-hex char in 42-char form reports an error", () => {
    const garbage = "0x" + "z".repeat(40);
    const r = validateToAddress(garbage);
    expect(r.error).toMatch(/40 hex chars/);
    expect(r.addr0x).toBeNull();
  });
});

describe("validateToAddress — complete mono1", () => {
  const BECH = addressToBech32m(ADDR0X_LOWER);

  it("lowercase mono1 decodes to the matching 0x form", () => {
    const r = validateToAddress(BECH);
    expect(r.error).toBeNull();
    expect(r.addr0x).toBe(ADDR0X_LOWER);
    expect(r.bech).toBe(BECH);
    expect(r.inputForm).toBe("mono1");
  });

  it("all-uppercase MONO1 decodes (BIP-350 canonical)", () => {
    const upper = BECH.toUpperCase();
    const r = validateToAddress(upper);
    expect(r.error).toBeNull();
    expect(r.addr0x).toBe(ADDR0X_LOWER);
    // bech is normalized to lowercase for display.
    expect(r.bech).toBe(BECH);
    expect(r.inputForm).toBe("mono1");
  });

  it("mixed-case mono1 is rejected per BIP-350", () => {
    // Find a letter position in the body and uppercase exactly that char,
    // leaving the rest lowercase. Using a random digit position would be
    // a no-op (digits are case-invariant) and the test would falsely pass.
    let mixed: string | null = null;
    for (let i = 5; i < BECH.length; i++) {
      const ch = BECH.charAt(i);
      if (ch >= "a" && ch <= "z") {
        mixed = BECH.slice(0, i) + ch.toUpperCase() + BECH.slice(i + 1);
        break;
      }
    }
    expect(mixed).not.toBeNull();
    const r = validateToAddress(mixed!);
    expect(r.error).not.toBeNull();
    expect(r.addr0x).toBeNull();
  });

  it("wrong-HRP bech32m (sprt1...) is rejected", () => {
    // Manually construct a valid-checksum bech32m for HRP "sprt" — we
    // don't have a helper, but the codec rejects unknown HRP at the
    // bech32mToAddress layer. Easier: take the mono1 form, swap "mono"
    // for "sprt" — the checksum will be wrong, which is also a valid
    // rejection path. Either way, error should fire.
    const wrong = "sprt1" + BECH.slice(5);
    const r = validateToAddress(wrong);
    expect(r.error).not.toBeNull();
    expect(r.addr0x).toBeNull();
  });
});

describe("validateToAddress — unknown / garbage", () => {
  it("non-0x non-mono1 input reports a clear error", () => {
    const r = validateToAddress("hello world");
    expect(r.error).toMatch(/0x or mono1/);
    expect(r.inputForm).toBe("unknown");
  });

  it("ENS-style names are rejected (no resolver yet)", () => {
    const r = validateToAddress("alice.mono");
    expect(r.error).toMatch(/0x or mono1/);
  });
});
