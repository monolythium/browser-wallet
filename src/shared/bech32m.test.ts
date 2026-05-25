// bech32m codec coverage — wire-format round-trip + the BIP-350 polymod
// constant pinned against an external vector. The "a1lqfn3a" vector comes
// straight from the BIP-350 specification; if the polymod constant is ever
// wrong (e.g. left at BIP-173's 1) decoding it fails, even if our own
// round-trips would still pass.

import { describe, expect, it } from "vitest";

import {
  addressToBech32m,
  bech32mDecode,
  bech32mEncode,
  bech32mToAddress,
  decodeBech32mTyped,
  hrpForKind,
  kindForHrp,
  shortBech32m,
  type AddressKind,
} from "./bech32m.js";

describe("bech32m codec", () => {
  it("decodes the BIP-350 'a1lqfn3a' polymod-constant vector", () => {
    const decoded = bech32mDecode("a1lqfn3a");
    expect(decoded).not.toBeNull();
    expect(decoded!.hrp).toBe("a");
    expect(decoded!.data).toEqual([]);
  });

  it("encodes empty data with HRP 'a' to the BIP-350 vector", () => {
    expect(bech32mEncode("a", [])).toBe("a1lqfn3a");
  });

  it("rejects the 'A1G7SGD8' vector (bech32 checksum, not bech32m)", () => {
    // 'A1G7SGD8' is a valid bech32 string for HRP 'A' with empty data
    // under polymod-constant 1 — it MUST be rejected by a bech32m decoder.
    expect(bech32mDecode("A1G7SGD8")).toBeNull();
    expect(bech32mDecode("a1g7sgd8")).toBeNull();
  });

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

  it("rejects wrong HRP", () => {
    // Encode with HRP 'cosmos' and try to decode-as-mono. The new
    // typed-HRP layer rejects this as "unrecognized HRP" because
    // 'cosmos' is not in the v4.1 chain-type table.
    const data5 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const bech = bech32mEncode("cosmos", data5);
    expect(() => bech32mToAddress(bech)).toThrow(/HRP/);
  });

  it("rejects mid-string corruption (checksum mismatch)", () => {
    const ok = addressToBech32m("0x9ba4e5f6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e2f4");
    // Flip a character in the middle — the checksum must catch it.
    const broken = ok.slice(0, 12) + (ok[12] === "q" ? "p" : "q") + ok.slice(13);
    expect(bech32mDecode(broken)).toBeNull();
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
    // Must be shorter than the full bech32m form.
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
    expect(bech32mDecode(mixed)).toBeNull();
  });

  // ────────────────────────────────────────────────────────────────────
  // Whitepaper §22.7 typed-HRP coverage
  // ────────────────────────────────────────────────────────────────────

  it("hrpForKind / kindForHrp round-trip the v4.1 typed-HRP set", () => {
    const pairs: [AddressKind, string][] = [
      ["eoa", "mono"],
      ["smartAccount", "monos"],
      ["contract", "monoc"],
      ["cluster", "monok"],
      ["multisig", "monom"],
      ["systemModule", "monox"],
      ["reservedRecovery", "monor"],
      ["reservedPrivacy", "monop"],
      ["reservedIssuer", "monoi"],
      ["reservedAgent", "monoa"],
    ];
    for (const [kind, hrp] of pairs) {
      expect(hrpForKind(kind)).toBe(hrp);
      expect(kindForHrp(hrp)).toBe(kind);
    }
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
    expect(() => bech32mToAddress(addressToBech32m(addr, "cluster"))).toThrow(
      /wrong HRP/,
    );
  });

  it("rejects a cluster-kind decode when an EOA is expected (paste-into-Send guard)", () => {
    const addr = "0x9ba4e5f6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e2f4";
    const clusterBech = addressToBech32m(addr, "cluster");
    expect(() => bech32mToAddress(clusterBech, "eoa")).toThrow(/wrong HRP/);
  });

  it("decodeBech32mTyped(null) returns the discovered kind for routing", () => {
    const addr = "0x9ba4e5f6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e2f4";
    const bech = addressToBech32m(addr, "contract");
    const typed = decodeBech32mTyped(bech, null);
    expect(typed.kind).toBe("contract");
    expect(typed.addr0x.toLowerCase()).toBe(addr.toLowerCase());
  });

  it("decodeBech32mTyped rejects unrecognized HRPs", () => {
    const data5: number[] = new Array(32).fill(0);
    const cosmosBech = bech32mEncode("cosmos", data5);
    expect(() => decodeBech32mTyped(cosmosBech, null)).toThrow(
      /unrecognized HRP/,
    );
  });

  it("shortBech32m for cluster preserves the 'monok1' prefix", () => {
    const addr = "0x9ba4e5f6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e2f4";
    const short = shortBech32m(addr, 8, "cluster");
    expect(short.startsWith("monok1")).toBe(true);
    expect(short).toContain("…");
  });
});
