// bech32m wallet-side coverage. The codec itself lives in
// @monolythium/core-sdk and is spec-tested there (BIP-350 polymod
// constant, raw encode/decode round-trip). These tests cover the
// wallet's shim: typed-HRP routing, `"eoa"` → SDK `"user"` translation,
// display helpers, and the paste-into-Send guard.

import { describe, expect, it } from "vitest";

import {
  addressToBech32m,
  bech32mToAddress,
  decodeBech32mTyped,
  hrpForKind,
  kindForHrp,
  shortBech32m,
  tryDecodeBech32m,
  type AddressKind,
} from "./bech32m.js";

describe("bech32m shim", () => {
  it("round-trips Sprintnet test wallet addresses", () => {
    const wallets = [
      "0x0d1c8d3e7c6c5b6e8d4f8a8c0b9d6e5f4a3b2c1d",
      "0x9ba4e5f6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e2f4",
      "0x5f0b6e7d8c9e0f1a2b3c4d5e6f708192a3b4c5d6",
      "0x941420e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2",
    ];
    for (const w of wallets) {
      const bech = addressToBech32m(w);
      expect(bech.startsWith("mono1")).toBe(true);
      const back = bech32mToAddress(bech);
      expect(back.toLowerCase()).toBe(w.toLowerCase());
    }
  });

  it("round-trips the all-zero address", () => {
    const zero = "0x0000000000000000000000000000000000000000";
    const bech = addressToBech32m(zero);
    expect(bech32mToAddress(bech)).toBe(zero);
  });

  it("accepts uppercase 0x prefix", () => {
    const a = "0X9Ba4E5F6C7D8E9F0A1B2C3D4E5F6A7B8C9D0E2F4";
    const bech = addressToBech32m(a);
    expect(bech).toMatch(/^mono1[a-z0-9]+$/);
  });

  it("rejects mid-string corruption (checksum mismatch)", () => {
    const ok = addressToBech32m("0x9ba4e5f6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e2f4");
    // Flip a character in the middle — the checksum must catch it.
    const broken = ok.slice(0, 12) + (ok[12] === "q" ? "p" : "q") + ok.slice(13);
    expect(tryDecodeBech32m(broken)).toBeNull();
    expect(() => bech32mToAddress(broken)).toThrow();
  });

  it("rejects the wrong-length hex input", () => {
    expect(() => addressToBech32m("0x1234")).toThrow(/20-byte/);
    expect(() =>
      addressToBech32m(
        "0x9ba4e5f6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e2f499",
      ),
    ).toThrow(/20-byte/);
  });

  it("shortBech32m truncates with the 'mono1' prefix preserved", () => {
    const addr = "0x9ba4e5f6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e2f4";
    const short = shortBech32m(addr);
    expect(short.startsWith("mono1")).toBe(true);
    expect(short).toContain("…");
    expect(short.length).toBeLessThan(addressToBech32m(addr).length);
  });

  it("shortBech32m returns the full string when n exceeds body length", () => {
    const addr = "0x9ba4e5f6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e2f4";
    const full = addressToBech32m(addr);
    expect(shortBech32m(addr, 999)).toBe(full);
  });

  it("rejects mixed-case bech32m strings", () => {
    const ok = addressToBech32m("0x9ba4e5f6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e2f4");
    const mixed = ok.slice(0, 5) + ok.slice(5, 6).toUpperCase() + ok.slice(6);
    expect(tryDecodeBech32m(mixed)).toBeNull();
    expect(() => bech32mToAddress(mixed)).toThrow();
  });

  // ────────────────────────────────────────────────────────────────────
  // Whitepaper §22.7 typed-HRP coverage
  // ────────────────────────────────────────────────────────────────────

  it("hrpForKind / kindForHrp round-trip the v4.1 wallet-originated HRP set", () => {
    const pairs: [AddressKind, string][] = [
      ["eoa", "mono"],
      ["smartAccount", "monos"],
      ["contract", "monoc"],
      ["cluster", "monok"],
      ["multisig", "monom"],
      ["systemModule", "monox"],
    ];
    for (const [kind, hrp] of pairs) {
      expect(hrpForKind(kind)).toBe(hrp);
      expect(kindForHrp(hrp)).toBe(kind);
    }
    // HRPs the wallet doesn't originate (reserved HRPs handled by the SDK,
    // arbitrary HRPs from external chains) return null at the wallet shim.
    expect(kindForHrp("monor")).toBeNull();
    expect(kindForHrp("monop")).toBeNull();
    expect(kindForHrp("cosmos")).toBeNull();
    expect(kindForHrp("monoz")).toBeNull();
  });

  it("encodes a cluster id with the 'monok' HRP", () => {
    const addr = "0x9ba4e5f6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e2f4";
    const bech = addressToBech32m(addr, "cluster");
    expect(bech.startsWith("monok1")).toBe(true);
    const back = bech32mToAddress(bech, "cluster");
    expect(back.toLowerCase()).toBe(addr.toLowerCase());
  });

  it("encodes a multisig with the 'monom' HRP", () => {
    const addr = "0xaaaa11112222333344445555666677778888aaaa";
    const bech = addressToBech32m(addr, "multisig");
    expect(bech.startsWith("monom1")).toBe(true);
    const back = bech32mToAddress(bech, "multisig");
    expect(back.toLowerCase()).toBe(addr.toLowerCase());
  });

  it("default kind is 'eoa' and produces 'mono1' (no breaking change)", () => {
    const addr = "0x0d1c8d3e7c6c5b6e8d4f8a8c0b9d6e5f4a3b2c1d";
    expect(addressToBech32m(addr).startsWith("mono1")).toBe(true);
    // Implicit-default decode also accepts only EOA.
    expect(() =>
      bech32mToAddress(addressToBech32m(addr, "cluster")),
    ).toThrow(/hrp/i);
  });

  it("rejects a cluster-kind decode when an EOA is expected (paste-into-Send guard)", () => {
    const addr = "0x9ba4e5f6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e2f4";
    const clusterBech = addressToBech32m(addr, "cluster");
    expect(() => bech32mToAddress(clusterBech, "eoa")).toThrow(/hrp/i);
  });

  it("decodeBech32mTyped(null) returns the discovered kind for routing", () => {
    const addr = "0x9ba4e5f6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e2f4";
    const bech = addressToBech32m(addr, "contract");
    const typed = decodeBech32mTyped(bech, null);
    expect(typed.kind).toBe("contract");
    expect(typed.addr0x.toLowerCase()).toBe(addr.toLowerCase());
  });

  it("shortBech32m for cluster preserves the 'monok1' prefix", () => {
    const addr = "0x9ba4e5f6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e2f4";
    const short = shortBech32m(addr, 8, "cluster");
    expect(short.startsWith("monok1")).toBe(true);
    expect(short).toContain("…");
  });

  it("tryDecodeBech32m returns null for malformed input", () => {
    expect(tryDecodeBech32m("not-bech32m")).toBeNull();
    expect(tryDecodeBech32m("mono1qqqqqqqqqqqqqqqqqqqqqqqqq")).toBeNull();
    expect(tryDecodeBech32m("")).toBeNull();
  });

  it("tryDecodeBech32m returns hrp + kind for valid input", () => {
    const addr = "0x9ba4e5f6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e2f4";
    const bech = addressToBech32m(addr, "multisig");
    const out = tryDecodeBech32m(bech);
    expect(out).not.toBeNull();
    expect(out!.hrp).toBe("monom");
    expect(out!.kind).toBe("multisig");
    expect(out!.addr0x.toLowerCase()).toBe(addr.toLowerCase());
  });
});
