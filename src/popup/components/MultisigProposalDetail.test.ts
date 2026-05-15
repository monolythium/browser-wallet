// Phase 8 Commit 3 — pure-helper tests for MultisigProposalDetail.

import { describe, expect, it } from "vitest";
import {
  formatHexValue,
  formatRemaining,
  shortenHex,
} from "./MultisigProposalDetail.js";

describe("formatRemaining", () => {
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  it('returns "expired" for negative ms', () => {
    expect(formatRemaining(-1)).toBe("expired");
    expect(formatRemaining(-1_000_000)).toBe("expired");
  });

  it('returns "<1m" for 0..59 seconds', () => {
    expect(formatRemaining(0)).toBe("<1m");
    expect(formatRemaining(59_000)).toBe("<1m");
  });

  it("returns minutes when in [1m, 1h)", () => {
    expect(formatRemaining(MIN)).toBe("1m");
    expect(formatRemaining(59 * MIN)).toBe("59m");
  });

  it("returns Hh Mm when in [1h, 1d)", () => {
    expect(formatRemaining(HOUR)).toBe("1h 0m");
    expect(formatRemaining(HOUR + 30 * MIN)).toBe("1h 30m");
    expect(formatRemaining(23 * HOUR + 59 * MIN)).toBe("23h 59m");
  });

  it("returns Nd Hh when >= 1d", () => {
    expect(formatRemaining(DAY)).toBe("1d 0h");
    expect(formatRemaining(7 * DAY)).toBe("7d 0h");
    expect(formatRemaining(7 * DAY + 5 * HOUR + 30 * MIN)).toBe("7d 5h");
  });
});

describe("formatHexValue", () => {
  it('returns "0" for zero/empty input', () => {
    expect(formatHexValue("")).toBe("0");
    expect(formatHexValue("0x")).toBe("0");
    expect(formatHexValue("0x0")).toBe("0");
  });

  it("converts hex to decimal string", () => {
    expect(formatHexValue("0x1")).toBe("1");
    expect(formatHexValue("0xff")).toBe("255");
    expect(formatHexValue("0xde0b6b3a7640000")).toBe("1000000000000000000");
  });

  it("returns the raw input for unparseable hex", () => {
    expect(formatHexValue("not-hex")).toBe("not-hex");
  });
});

describe("shortenHex", () => {
  it("returns empty for undefined/empty", () => {
    expect(shortenHex(undefined)).toBe("");
    expect(shortenHex("")).toBe("");
  });

  it("returns short strings unchanged", () => {
    expect(shortenHex("0x12")).toBe("0x12");
    expect(shortenHex("0xabcdef")).toBe("0xabcdef");
  });

  it("ellipsizes long hex strings", () => {
    const long = "0x" + "ab".repeat(40);
    const out = shortenHex(long);
    expect(out).toMatch(/^0x[a-f0-9]+…[a-f0-9]+$/);
    expect(out.startsWith("0xabab")).toBe(true);
    expect(out.endsWith("ababab")).toBe(true);
  });
});
