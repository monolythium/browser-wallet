import { describe, it, expect } from "vitest";
import {
  validateReverseNameCache,
  getReverseName,
  putReverseName,
  evictExpiredReverseNames,
  REVERSE_NAME_TTL_MS,
  type ReverseNameCache,
} from "./reverse-name-cache.js";

const ADDR = "0xABCDEF0123456789abcdef0123456789ABCDEF01";
const T0 = 1_000_000;

describe("reverse-name-cache", () => {
  it("puts + gets a name (case-insensitive key)", () => {
    const c = putReverseName({}, ADDR, "alice.mono", T0);
    expect(getReverseName(c, ADDR, T0)?.name).toBe("alice.mono");
    expect(getReverseName(c, ADDR.toLowerCase(), T0)?.name).toBe("alice.mono");
  });

  it("caches a confirmed miss as null", () => {
    const c = putReverseName({}, ADDR, null, T0);
    const hit = getReverseName(c, ADDR, T0);
    expect(hit).toBeDefined();
    expect(hit?.name).toBeNull();
  });

  it("treats an entry past the TTL as absent", () => {
    const c = putReverseName({}, ADDR, "alice.mono", T0);
    expect(getReverseName(c, ADDR, T0 + REVERSE_NAME_TTL_MS - 1)?.name).toBe("alice.mono");
    expect(getReverseName(c, ADDR, T0 + REVERSE_NAME_TTL_MS)).toBeUndefined();
  });

  it("evicts only stale entries, returning the same object when nothing expired", () => {
    let c: ReverseNameCache = {};
    c = putReverseName(c, ADDR, "alice.mono", T0);
    c = putReverseName(c, "0x" + "22".repeat(20), "bob.mono", T0 + REVERSE_NAME_TTL_MS); // fresher
    const evicted = evictExpiredReverseNames(c, T0 + REVERSE_NAME_TTL_MS + 1);
    expect(Object.keys(evicted)).toEqual(["0x" + "22".repeat(20)]);
    // nothing stale → same reference (no spurious write)
    const noop = evictExpiredReverseNames(evicted, T0 + REVERSE_NAME_TTL_MS + 2);
    expect(noop).toBe(evicted);
  });

  it("is pure (put returns a new object)", () => {
    const base: ReverseNameCache = {};
    const next = putReverseName(base, ADDR, "alice.mono", T0);
    expect(base).toEqual({});
    expect(next).not.toBe(base);
  });

  it("validates + lowercases keys, rejecting malformed blobs", () => {
    const v = validateReverseNameCache({ "0xAA": { name: "alice.mono", ts: T0 } });
    expect(Object.keys(v!)).toEqual(["0xaa"]);
    expect(validateReverseNameCache({ "0xAA": { name: null, ts: T0 } })).not.toBeNull();
    expect(validateReverseNameCache(null)).toBeNull();
    expect(validateReverseNameCache("x")).toBeNull();
    expect(validateReverseNameCache({ "0xAA": { name: 1, ts: T0 } })).toBeNull();
    expect(validateReverseNameCache({ "0xAA": { name: "a.mono" } })).toBeNull();
  });
});
