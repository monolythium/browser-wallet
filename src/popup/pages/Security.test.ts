// Pure-helper tests for the Security page.
//
// Validate the lythoshi/LYTH conversion helpers + slider-stop mapping.
// The React rendering of Security itself is not snapshot-tested
// (codebase ships no React render harness — same posture as
// MultisigCreateModal); manual verification happens via the dev popup.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_PASSKEY_LIMIT_LYTHOSHI,
  MAX_PASSKEY_LIMIT_LYTHOSHI,
  MIN_PASSKEY_LIMIT_LYTHOSHI,
} from "../../shared/passkey.js";
import {
  closestStopIndex,
  lythoshiStrToLythStr,
  lythToLythoshiStr,
} from "./Security.js";

describe("lythoshiStrToLythStr", () => {
  // Chain migrated 8 → 18 decimals: 1 LYTH = 10^18 lythoshi.
  it("round-trips 1 LYTH", () => {
    expect(lythoshiStrToLythStr("1000000000000000000")).toBe("1");
  });

  it("round-trips 100 LYTH", () => {
    expect(lythoshiStrToLythStr("100000000000000000000")).toBe("100");
  });

  it("renders fractional LYTH with 18-decimal native precision", () => {
    // 1.5 LYTH
    expect(lythoshiStrToLythStr("1500000000000000000")).toBe("1.5");
    // 1 lythoshi — bottom of the slider isn't this granular but the
    // converter is, useful for the daily-cap readout
    expect(lythoshiStrToLythStr("1")).toBe("0.000000000000000001");
    expect(lythoshiStrToLythStr("123456780000000000")).toBe("0.12345678");
  });

  it("trims trailing zeros in the fractional part", () => {
    // 2.5000 LYTH → "2.5"
    expect(lythoshiStrToLythStr("2500000000000000000")).toBe("2.5");
  });

  it("falls back to '?' on malformed input", () => {
    expect(lythoshiStrToLythStr("not a number")).toBe("?");
  });
});

describe("lythToLythoshiStr", () => {
  it("multiplies by 10^18", () => {
    expect(lythToLythoshiStr(1)).toBe("1000000000000000000");
    expect(lythToLythoshiStr(100)).toBe("100000000000000000000");
  });

  it("avoids float imprecision at large values", () => {
    // Naive float math could emit a non-integer suffix; BigInt keeps
    // slider outputs as exact lythoshi strings.
    expect(lythToLythoshiStr(10_000)).toBe("10000000000000000000000");
  });

  it("floors fractional inputs (slider stops are integers anyway)", () => {
    expect(lythToLythoshiStr(1.9)).toBe("1000000000000000000");
  });
});

describe("closestStopIndex", () => {
  // SLIDER_STOPS_LYTH = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000, 10000]
  it("snaps to the exact stop at default", () => {
    // 100 LYTH = stop index 5
    expect(closestStopIndex(lythToLythoshiStr(100))).toBe(5);
    expect(closestStopIndex(DEFAULT_PASSKEY_LIMIT_LYTHOSHI.toString())).toBe(5);
  });

  it("snaps to the nearest stop for off-grid values", () => {
    // 75 LYTH is closer to 50 than to 100 (|75-50|=25, |75-100|=25 —
    // tie goes to the lower stop since the loop keeps the first
    // best). Spot-check the non-tie cases instead.
    expect(closestStopIndex(lythToLythoshiStr(80))).toBe(5); // 100
    expect(closestStopIndex(lythToLythoshiStr(60))).toBe(4); // 50
  });

  it("clamps to the highest stop for very large values", () => {
    expect(closestStopIndex(lythToLythoshiStr(50_000))).toBe(10); // 10_000
  });

  it("clamps to the lowest stop for zero / sub-1-LYTH", () => {
    expect(closestStopIndex("0")).toBe(0); // 1 LYTH stop
  });

  it("maps min/default/max constants onto slider stops", () => {
    expect(closestStopIndex(MIN_PASSKEY_LIMIT_LYTHOSHI.toString())).toBe(0);
    expect(closestStopIndex(DEFAULT_PASSKEY_LIMIT_LYTHOSHI.toString())).toBe(5);
    expect(closestStopIndex(MAX_PASSKEY_LIMIT_LYTHOSHI.toString())).toBe(10);
  });

  it("returns the default stop on malformed input", () => {
    // 100 LYTH is the index-5 default
    expect(closestStopIndex("not a number")).toBe(5);
  });
});
