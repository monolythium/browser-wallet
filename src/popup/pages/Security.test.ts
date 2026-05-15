// Phase 9 Commit 3 — pure-helper tests for the Security page.
//
// Validate the wei/LYTH conversion helpers + slider-stop mapping.
// The React rendering of Security itself is not snapshot-tested
// (codebase ships no React render harness — same posture as
// MultisigCreateModal); manual verification happens via the dev popup.

import { describe, expect, it } from "vitest";
import {
  closestStopIndex,
  lythToWeiStr,
  weiStrToLythStr,
} from "./Security.js";

describe("weiStrToLythStr", () => {
  it("round-trips 1 LYTH", () => {
    expect(weiStrToLythStr("1000000000000000000")).toBe("1");
  });

  it("round-trips 100 LYTH", () => {
    expect(weiStrToLythStr("100000000000000000000")).toBe("100");
  });

  it("renders fractional LYTH with 4 dp ceiling", () => {
    // 1.5 LYTH
    expect(weiStrToLythStr("1500000000000000000")).toBe("1.5");
    // 0.0001 LYTH — bottom of the slider isn't this granular but the
    // converter is, useful for the daily-cap readout
    expect(weiStrToLythStr("100000000000000")).toBe("0.0001");
  });

  it("trims trailing zeros in the fractional part", () => {
    // 2.5000 LYTH → "2.5"
    expect(weiStrToLythStr("2500000000000000000")).toBe("2.5");
  });

  it("falls back to '?' on malformed input", () => {
    expect(weiStrToLythStr("not a number")).toBe("?");
  });
});

describe("lythToWeiStr", () => {
  it("multiplies by 1e18", () => {
    expect(lythToWeiStr(1)).toBe("1000000000000000000");
    expect(lythToWeiStr(100)).toBe("100000000000000000000");
  });

  it("avoids float imprecision at large values", () => {
    // Naive float math would land at "10000000000000000000000.000..." or
    // similar. BigInt path guarantees the integer-zero suffix.
    expect(lythToWeiStr(10_000)).toBe("10000000000000000000000");
  });

  it("floors fractional inputs (slider stops are integers anyway)", () => {
    expect(lythToWeiStr(1.9)).toBe("1000000000000000000");
  });
});

describe("closestStopIndex", () => {
  // SLIDER_STOPS_LYTH = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000, 10000]
  it("snaps to the exact stop at default", () => {
    // 100 LYTH = stop index 5
    expect(closestStopIndex(lythToWeiStr(100))).toBe(5);
  });

  it("snaps to the nearest stop for off-grid values", () => {
    // 75 LYTH is closer to 50 than to 100 (|75-50|=25, |75-100|=25 —
    // tie goes to the lower stop since the loop keeps the first
    // best). Spot-check the non-tie cases instead.
    expect(closestStopIndex(lythToWeiStr(80))).toBe(5); // 100
    expect(closestStopIndex(lythToWeiStr(60))).toBe(4); // 50
  });

  it("clamps to the highest stop for very large values", () => {
    expect(closestStopIndex(lythToWeiStr(50_000))).toBe(10); // 10_000
  });

  it("clamps to the lowest stop for zero / sub-1-LYTH", () => {
    expect(closestStopIndex("0")).toBe(0); // 1 LYTH stop
  });

  it("returns the default stop on malformed input", () => {
    // 100 LYTH is the index-5 default
    expect(closestStopIndex("not a number")).toBe(5);
  });
});
