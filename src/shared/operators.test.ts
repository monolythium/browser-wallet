// Unit coverage for the operator-override shared helpers. The SW-level
// IPC tests in service-worker.eip1193.test.ts cover the integrated path
// (storage + onChanged listener + IPC dispatch); these tests pin the
// pure logic so refactors of the validator or the merge function show
// up without dragging in the SW boot harness.

import { describe, expect, it } from "vitest";
import {
  validateOperatorList,
  mergeOperatorOverride,
  type OperatorEntry,
} from "./operators.js";

const DEFAULTS: ReadonlyArray<OperatorEntry> = [
  { name: "default-1", region: "x", rpc: "http://1.example" },
  { name: "default-2", region: "y", rpc: "http://2.example" },
];

describe("validateOperatorList", () => {
  it("accepts a well-formed non-empty array", () => {
    const r = validateOperatorList([
      { name: "n1", region: "r1", rpc: "http://x.example" },
      { name: "n2", region: "r2", rpc: "https://y.example" },
    ]);
    expect(r).toEqual([
      { name: "n1", region: "r1", rpc: "http://x.example" },
      { name: "n2", region: "r2", rpc: "https://y.example" },
    ]);
  });

  it("rejects a non-array", () => {
    expect(validateOperatorList(null)).toBeNull();
    expect(validateOperatorList(undefined)).toBeNull();
    expect(validateOperatorList({})).toBeNull();
    expect(validateOperatorList("string")).toBeNull();
  });

  it("rejects an empty array", () => {
    expect(validateOperatorList([])).toBeNull();
  });

  it("rejects entries with missing or empty name", () => {
    expect(
      validateOperatorList([{ name: "", region: "r", rpc: "http://x.example" }]),
    ).toBeNull();
    expect(
      validateOperatorList([{ region: "r", rpc: "http://x.example" }]),
    ).toBeNull();
  });

  it("rejects entries with non-string region", () => {
    expect(
      validateOperatorList([{ name: "n", region: 123, rpc: "http://x.example" }]),
    ).toBeNull();
  });

  it("rejects entries with non-URL rpc", () => {
    expect(
      validateOperatorList([{ name: "n", region: "r", rpc: "not-a-url" }]),
    ).toBeNull();
  });

  it("rejects entries with name length > 64", () => {
    const longName = "a".repeat(65);
    expect(
      validateOperatorList([{ name: longName, region: "r", rpc: "http://x.example" }]),
    ).toBeNull();
  });
});

describe("mergeOperatorOverride", () => {
  it("returns defaults when override is null", () => {
    const r = mergeOperatorOverride(DEFAULTS, null);
    expect(r).toEqual(DEFAULTS);
    // Must be a fresh copy (callers may mutate).
    expect(r).not.toBe(DEFAULTS);
  });

  it("returns defaults when override is empty", () => {
    const r = mergeOperatorOverride(DEFAULTS, []);
    expect(r).toEqual(DEFAULTS);
  });

  it("returns override verbatim when non-empty", () => {
    const override: OperatorEntry[] = [
      { name: "user-1", region: "local", rpc: "http://127.0.0.1:8545" },
    ];
    const r = mergeOperatorOverride(DEFAULTS, override);
    expect(r).toEqual(override);
    // Must be a fresh copy so caller mutation can't corrupt.
    expect(r).not.toBe(override);
  });
});
