import { describe, it, expect } from "vitest";
import {
  validateNameLedger,
  addOwnedNameEntry,
  getOwnedNames,
  MAX_LEDGER_ENTRIES_PER_ADDRESS,
  type NameLedger,
} from "./name-ledger.js";

const ADDR = "0xABCDEF0123456789abcdef0123456789ABCDEF01";
const entry = (name: string, addedAt = 1) => ({ name, category: "human", addedAt });

describe("name-ledger", () => {
  it("adds an entry under the lowercased address", () => {
    const led = addOwnedNameEntry({}, ADDR, entry("alice.mono"));
    expect(getOwnedNames(led, ADDR.toLowerCase())).toEqual([
      { name: "alice.mono", category: "human", addedAt: 1 },
    ]);
    // lookup is case-insensitive
    expect(getOwnedNames(led, ADDR)).toHaveLength(1);
  });

  it("de-dupes by name (newest wins) and lowercases the name", () => {
    let led: NameLedger = {};
    led = addOwnedNameEntry(led, ADDR, entry("Alice.mono", 1));
    led = addOwnedNameEntry(led, ADDR, entry("alice.mono", 5));
    const names = getOwnedNames(led, ADDR);
    expect(names).toHaveLength(1);
    expect(names[0]).toEqual({ name: "alice.mono", category: "human", addedAt: 5 });
  });

  it("keeps separate lists per address", () => {
    let led: NameLedger = {};
    led = addOwnedNameEntry(led, ADDR, entry("alice.mono"));
    led = addOwnedNameEntry(led, "0x" + "22".repeat(20), entry("bob.mono"));
    expect(getOwnedNames(led, ADDR)).toHaveLength(1);
    expect(getOwnedNames(led, "0x" + "22".repeat(20))).toHaveLength(1);
  });

  it("caps per-address entries, dropping the oldest", () => {
    let led: NameLedger = {};
    for (let i = 0; i < MAX_LEDGER_ENTRIES_PER_ADDRESS + 10; i++) {
      led = addOwnedNameEntry(led, ADDR, entry(`n${i}.mono`, i));
    }
    const names = getOwnedNames(led, ADDR);
    expect(names).toHaveLength(MAX_LEDGER_ENTRIES_PER_ADDRESS);
    // oldest (n0..n9) dropped; newest retained
    expect(names[names.length - 1]!.name).toBe(
      `n${MAX_LEDGER_ENTRIES_PER_ADDRESS + 9}.mono`,
    );
    expect(names.some((e) => e.name === "n0.mono")).toBe(false);
  });

  it("does not mutate the input ledger (pure)", () => {
    const led: NameLedger = {};
    const next = addOwnedNameEntry(led, ADDR, entry("alice.mono"));
    expect(led).toEqual({});
    expect(next).not.toBe(led);
  });

  it("validates a well-formed ledger and lowercases the address keys", () => {
    const raw = {
      "0xAA": [{ name: "alice.mono", category: "human", addedAt: 1 }],
    };
    const v = validateNameLedger(raw);
    expect(v).not.toBeNull();
    expect(Object.keys(v!)).toEqual(["0xaa"]);
  });

  it("rejects malformed blobs", () => {
    expect(validateNameLedger(null)).toBeNull();
    expect(validateNameLedger("nope")).toBeNull();
    expect(validateNameLedger({ "0xaa": "not-an-array" })).toBeNull();
    expect(validateNameLedger({ "0xaa": [{ name: 1, category: "human", addedAt: 1 }] })).toBeNull();
    expect(validateNameLedger({ "0xaa": [{ name: "x.mono", addedAt: 1 }] })).toBeNull();
  });
});
