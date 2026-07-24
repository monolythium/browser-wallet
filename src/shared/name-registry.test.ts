import { describe, it, expect } from "vitest";
import { NAME_REGISTRY_SELECTORS } from "@monolythium/core-sdk";
import {
  validateRegisterableName,
  quoteNameCostLythoshi,
  nameFeeUnitLythoshi,
  encodeNameRegisterCall,
  encodeNameProposeTransferCall,
  encodeNameAcceptTransferCall,
  nameRegistryAddressHex,
  NAME_FORBIDDEN_PREFIXES,
} from "./name-registry.js";

// The live testnet base price floors at the economic minimum 1e9
// (config.rs INITIAL_BASE_PRICE_PER_EXECUTION_UNIT_LYTHOSHI); use it as the
// canonical fee unit for the cost pins.
const FLOOR = 1_000_000_000n;

function hexOfUtf8(s: string): string {
  return Array.from(new TextEncoder().encode(s))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("name-registry — validation (mirrors validate.rs, scoped to Human/Agent)", () => {
  it("accepts a human name", () => {
    const r = validateRegisterableName("alice.mono");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.category).toBe("human");
    expect(r.registerableCategory).toBe("human");
    expect(r.primaryLabelLen).toBe(5);
    expect(r.parentName).toBeNull();
    expect(r.canonical).toBe("alice.mono");
  });

  it("accepts an agent name and derives the parent", () => {
    const r = validateRegisterableName("bob.agent.alice.mono");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.category).toBe("agent");
    expect(r.primaryLabelLen).toBe(3);
    expect(r.parentName).toBe("alice.mono");
  });

  it("accepts legitimate mono-stem names (not the bech32m `1` HRP)", () => {
    for (const ok of ["monolythium.mono", "money.mono", "monolith.mono"]) {
      expect(validateRegisterableName(ok).ok).toBe(true);
    }
  });

  it("rejects each of the 11 forbidden prefixes on the primary label", () => {
    for (const p of NAME_FORBIDDEN_PREFIXES) {
      const r = validateRegisterableName(`${p}foo.mono`);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.reason).toBe("forbidden-prefix");
    }
  });

  it("rejects a forbidden prefix on an agent's parent label too", () => {
    const r = validateRegisterableName("bot.agent.0xalice.mono");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("forbidden-prefix");
  });

  it("rejects malformed names (charset / hyphen / uppercase / unknown tld / depth)", () => {
    for (const bad of [
      "Alice.mono",
      "alice_x.mono",
      "ali--ce.mono",
      "-alice.mono",
      "alice.com",
      "x.agent.alice.agent.mono",
      "alice..mono",
    ]) {
      const r = validateRegisterableName(bad);
      expect(r.ok, `should reject ${bad}`).toBe(false);
      if (r.ok) continue;
      expect(["malformed", "forbidden-prefix"]).toContain(r.reason);
    }
  });

  it("rejects structural reserves used as a primary label", () => {
    for (const bad of ["agent.mono", "cluster.mono", "contract.mono", "system.mono"]) {
      const r = validateRegisterableName(bad);
      expect(r.ok, `should reject ${bad}`).toBe(false);
    }
  });

  it("classifies cluster/contract/system as not-registerable (not malformed)", () => {
    for (const [name, needle] of [
      ["halcyon.cluster.mono", "operator"],
      ["swap.contract.mono", "contract"],
      ["foundation.system.mono", "reserved"],
    ] as const) {
      const r = validateRegisterableName(name);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.reason).toBe("not-registerable");
      expect(r.message.toLowerCase()).toContain(needle);
    }
  });

  it("rejects empty input", () => {
    const r = validateRegisterableName("");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("empty");
  });
});

describe("name-registry — cost quote (parity with the chain U-curve)", () => {
  it("matches base × modX10 × feeUnit / 10 for pinned samples at the 1e9 floor", () => {
    // human len 5 → modX10 30, base 5 → 5×30×1e9/10 = 15e9
    expect(quoteNameCostLythoshi("human", 5, FLOOR)).toBe(15_000_000_000n);
    // human len 6 → modX10 10 → 5×10×1e9/10 = 5e9
    expect(quoteNameCostLythoshi("human", 6, FLOOR)).toBe(5_000_000_000n);
    // human len 1 → modX10 1000 → 5×1000×1e9/10 = 500e9
    expect(quoteNameCostLythoshi("human", 1, FLOOR)).toBe(500_000_000_000n);
    // human len 63 → modX10 500 → 5×500×1e9/10 = 250e9
    expect(quoteNameCostLythoshi("human", 63, FLOOR)).toBe(250_000_000_000n);
    // agent len 8 → modX10 10, base 2 → 2×10×1e9/10 = 2e9
    expect(quoteNameCostLythoshi("agent", 8, FLOOR)).toBe(2_000_000_000n);
  });

  it("falls back to the 1e12 unit only when the base fee reads zero (matches the chain)", () => {
    expect(nameFeeUnitLythoshi(0n)).toBe(1_000_000_000_000n);
    expect(nameFeeUnitLythoshi(FLOOR)).toBe(FLOOR);
    // human len 6 at fallback → 5×10×1e12/10 = 5e12
    expect(quoteNameCostLythoshi("human", 6, 0n)).toBe(5_000_000_000_000n);
  });
});

describe("name-registry — encoders (chain-conformant calldata; WYSIWYS round-trip)", () => {
  it("register calldata carries the register selector and round-trips the name", () => {
    const data = encodeNameRegisterCall("alice.mono");
    expect(data.startsWith(NAME_REGISTRY_SELECTORS.register)).toBe(true);
    expect(data.includes(hexOfUtf8("alice.mono"))).toBe(true);
  });

  it("propose/accept calldata carry their selectors and the name", () => {
    const propose = encodeNameProposeTransferCall(
      "alice.mono",
      "0x00000000000000000000000000000000000000aa",
    );
    expect(propose.startsWith(NAME_REGISTRY_SELECTORS.proposeTransfer)).toBe(true);
    expect(propose.includes(hexOfUtf8("alice.mono"))).toBe(true);

    const accept = encodeNameAcceptTransferCall("alice.mono");
    expect(accept.startsWith(NAME_REGISTRY_SELECTORS.acceptTransfer)).toBe(true);
    expect(accept.includes(hexOfUtf8("alice.mono"))).toBe(true);
  });

  it("exposes the 0x110E precompile address", () => {
    expect(nameRegistryAddressHex().toLowerCase().endsWith("110e")).toBe(true);
  });
});
