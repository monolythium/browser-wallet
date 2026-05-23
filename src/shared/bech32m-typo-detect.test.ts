// Phase 11 Commit 7 — bech32m typo detection tests.

import { describe, expect, it } from "vitest";
import { addressToBech32m } from "./bech32m.js";
import {
  classifyAddressInput,
  suggestBech32mCorrection,
} from "./bech32m-typo-detect.js";

// Canonical test addresses derived from real 20-byte hex addresses.
const HEX_A = "0x1122334455667788990011223344556677889900";
const HEX_B = "0xaabbccddeeff00112233445566778899aabbccdd";
const BECH_A = addressToBech32m(HEX_A);
const BECH_B = addressToBech32m(HEX_B);

describe("classifyAddressInput", () => {
  it("classifies empty string as empty", () => {
    expect(classifyAddressInput("").kind).toBe("empty");
    expect(classifyAddressInput("   ").kind).toBe("empty");
  });

  it("classifies a 20-byte 0x address as hex", () => {
    const r = classifyAddressInput(HEX_A);
    expect(r.kind).toBe("hex");
    if (r.kind === "hex") {
      expect(r.address).toBe(HEX_A);
    }
  });

  it("classifies a valid mono1 address as bech32m-valid", () => {
    const r = classifyAddressInput(BECH_A);
    expect(r.kind).toBe("bech32m-valid");
  });

  it("classifies a mono1 with one-char typo as bech32m-typo with suggestion", () => {
    // Substitute one character of the payload to break the checksum
    // while keeping the bech32m shape.
    const pos = 10;
    const orig = BECH_A.charAt(pos);
    // Pick a different valid charset character.
    const replacement = orig === "q" ? "p" : "q";
    const typo = BECH_A.slice(0, pos) + replacement + BECH_A.slice(pos + 1);
    const r = classifyAddressInput(typo);
    expect(r.kind).toBe("bech32m-typo");
    if (r.kind === "bech32m-typo") {
      // The suggestion should be the original. Note: the first valid
      // 1-edit is returned, which may not necessarily be the original
      // address — but for a well-distributed bech32m, it almost always is.
      expect(r.suggestion).toBe(BECH_A);
    }
  });

  it("classifies a mono1 with multi-char garbage as bech32m-malformed", () => {
    const garbage = "mono1zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
    const r = classifyAddressInput(garbage);
    expect(r.kind).toBe("bech32m-malformed");
  });

  it("classifies a junk string as unknown", () => {
    expect(classifyAddressInput("not an address").kind).toBe("unknown");
    expect(classifyAddressInput("alice@example.com").kind).toBe("unknown");
  });

  it("is case-insensitive on bech32m input", () => {
    // Bech32m forbids mixed case but the function normalises the user
    // input — uppercase only should still pass once lowered.
    const r = classifyAddressInput(BECH_A.toUpperCase());
    expect(r.kind).toBe("bech32m-valid");
  });

  it("accepts hex with leading/trailing whitespace", () => {
    const r = classifyAddressInput(`  ${HEX_A}  `);
    expect(r.kind).toBe("hex");
  });
});

describe("suggestBech32mCorrection", () => {
  it("returns null for an already-valid address", () => {
    expect(suggestBech32mCorrection(BECH_A)).toBeNull();
  });

  it("returns null for non-mono1 input", () => {
    expect(suggestBech32mCorrection(HEX_A)).toBeNull();
    expect(suggestBech32mCorrection("bc1qarbitrary")).toBeNull();
  });

  it("recovers a one-char substitution for a real address", () => {
    // Substitute char at position 15 with a different charset char.
    const pos = 15;
    const orig = BECH_B.charAt(pos);
    const replacement = orig === "q" ? "p" : "q";
    const typo = BECH_B.slice(0, pos) + replacement + BECH_B.slice(pos + 1);
    const suggestion = suggestBech32mCorrection(typo);
    expect(suggestion).toBe(BECH_B);
  });

  it("returns null when no 1-edit fix exists (deep garbage)", () => {
    const garbage = "mono1zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
    expect(suggestBech32mCorrection(garbage)).toBeNull();
  });

  it("returns null for too-short inputs (likely partial type)", () => {
    expect(suggestBech32mCorrection("mono1abc")).toBeNull();
  });

  it("returns null for absurdly long inputs", () => {
    const tooLong = "mono1" + "a".repeat(200);
    expect(suggestBech32mCorrection(tooLong)).toBeNull();
  });
});
