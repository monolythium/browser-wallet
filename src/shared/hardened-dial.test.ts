import { describe, expect, it } from "vitest";

import { hardenedOperators, hardenedChains } from "./hardened-dial.js";
import type { OperatorEntry } from "./operators.js";

const DEFAULTS: ReadonlyArray<OperatorEntry> = [
  { name: "operator-1", region: "fsn1", rpc: "http://10.0.0.1:8545" },
  { name: "operator-2", region: "hel1", rpc: "http://10.0.0.2:8545" },
];
const OVERRIDE: OperatorEntry[] = [
  { name: "custom", region: "x", rpc: "http://198.51.100.7:8545" },
];

describe("hardenedOperators — the operator brick-preventer", () => {
  it("HARDENED ignores a stored override and returns the allowlisted defaults", () => {
    // The override REPLACES the fleet, so under the strict CSP it would brick
    // every RPC. Hardened builds must always dial the defaults.
    const got = hardenedOperators(DEFAULTS, OVERRIDE, true);
    expect(got.map((o) => o.rpc)).toEqual([
      "http://10.0.0.1:8545",
      "http://10.0.0.2:8545",
    ]);
    expect(got.map((o) => o.rpc)).not.toContain("http://198.51.100.7:8545");
  });

  it("HARDENED with no override → defaults", () => {
    expect(hardenedOperators(DEFAULTS, null, true).map((o) => o.rpc)).toEqual([
      "http://10.0.0.1:8545",
      "http://10.0.0.2:8545",
    ]);
  });

  it("DEV honors the stored override (replace semantics, unchanged)", () => {
    const got = hardenedOperators(DEFAULTS, OVERRIDE, false);
    expect(got.map((o) => o.rpc)).toEqual(["http://198.51.100.7:8545"]);
  });

  it("DEV with no override → defaults (unchanged)", () => {
    expect(hardenedOperators(DEFAULTS, null, false).map((o) => o.rpc)).toEqual([
      "http://10.0.0.1:8545",
      "http://10.0.0.2:8545",
    ]);
  });

  it("returns fresh copies (mutating the result can't corrupt the defaults)", () => {
    const got = hardenedOperators(DEFAULTS, null, true);
    got[0]!.rpc = "mutated";
    expect(DEFAULTS[0]!.rpc).toBe("http://10.0.0.1:8545");
  });
});

describe("hardenedChains — the custom-chain brick-preventer", () => {
  const builtin = { "0x10F2C": { name: "Monolythium Testnet", builtin: true } };
  const user = { "0x1": { name: "Custom EVM", builtin: false } };

  it("HARDENED dials only the built-in chain(s); custom chains are dropped", () => {
    const got = hardenedChains(builtin, user, true);
    expect(Object.keys(got)).toEqual(["0x10F2C"]);
    expect(got["0x1"]).toBeUndefined();
  });

  it("DEV merges built-in + user chains (unchanged)", () => {
    const got = hardenedChains(builtin, user, false);
    expect(Object.keys(got).sort()).toEqual(["0x1", "0x10F2C"]);
  });

  it("HARDENED returns a copy, not the builtin reference", () => {
    expect(hardenedChains(builtin, user, true)).not.toBe(builtin);
  });
});
