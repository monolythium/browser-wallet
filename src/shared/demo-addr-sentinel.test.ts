import { describe, expect, it } from "vitest";

import {
  DEMO_ADDR_SENTINELS_LOWER,
  isDemoAddrSentinel,
} from "./demo-addr-sentinel.js";

describe("demo-addr-sentinel", () => {
  it("includes the three 0x-shaped popup ACCOUNTS fixture addresses", () => {
    // The mvk: fixture (ACCOUNTS[1].addr) is intentionally NOT in the
    // set — it's non-0x-shaped so address-keyed write paths already
    // reject it by their hex-prefix guard. The list tracks ONLY the
    // 0x-shaped fixtures that can otherwise leak through hex-shaped
    // address filters.
    expect(DEMO_ADDR_SENTINELS_LOWER).toContain(
      "0xa9f2000000000000000000000000000000000001",
    );
    expect(DEMO_ADDR_SENTINELS_LOWER).toContain(
      "0x77bd000000000000000000000000000000000003",
    );
    expect(DEMO_ADDR_SENTINELS_LOWER).toContain(
      "0xc9a3000000000000000000000000000000000004",
    );
    expect(DEMO_ADDR_SENTINELS_LOWER).toHaveLength(3);
  });

  it("isDemoAddrSentinel matches sentinel addresses (case-insensitive)", () => {
    expect(
      isDemoAddrSentinel("0xa9f2000000000000000000000000000000000001"),
    ).toBe(true);
    expect(
      isDemoAddrSentinel("0xA9F2000000000000000000000000000000000001"),
    ).toBe(true);
    expect(
      isDemoAddrSentinel("0x77bd000000000000000000000000000000000003"),
    ).toBe(true);
    expect(
      isDemoAddrSentinel("0xc9a3000000000000000000000000000000000004"),
    ).toBe(true);
  });

  it("isDemoAddrSentinel rejects real-shaped addresses", () => {
    // 2026-05-26 storage dump active vault addr — must not be flagged.
    expect(
      isDemoAddrSentinel("0x01029862840d227ee9e76a845c8cbb80ba1d7d23"),
    ).toBe(false);
    // Second-vault addr from the same dump.
    expect(
      isDemoAddrSentinel("0x4e8f00dbec7c9d23dfb369062e2ff8c8c02d3a3d"),
    ).toBe(false);
    expect(
      isDemoAddrSentinel("0x0000000000000000000000000000000000000000"),
    ).toBe(false);
  });

  it("isDemoAddrSentinel returns false for null / undefined / empty / non-string", () => {
    expect(isDemoAddrSentinel(null)).toBe(false);
    expect(isDemoAddrSentinel(undefined)).toBe(false);
    expect(isDemoAddrSentinel("")).toBe(false);
  });
});
