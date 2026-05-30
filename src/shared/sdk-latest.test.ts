import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLatestSdkVersion, compareSemver } from "./sdk-latest.js";

describe("compareSemver", () => {
  it("orders by numeric core (not string compare)", () => {
    // The bug a string compare would hit: "0.3.9" > "0.3.10" lexically.
    expect(compareSemver("0.3.10", "0.3.9")).toBe(1);
    expect(compareSemver("0.3.9", "0.3.10")).toBe(-1);
    expect(compareSemver("0.3.10", "0.3.10")).toBe(0);
    expect(compareSemver("1.0.0", "0.9.9")).toBe(1);
  });

  it("ignores pre-release metadata and unparseable input", () => {
    expect(compareSemver("0.3.10-rc.1", "0.3.10")).toBe(0);
    expect(compareSemver("x.y.z", "0.0.0")).toBe(0);
  });
});

describe("fetchLatestSdkVersion", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns the version on a successful response", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: "0.3.11" }),
    })) as unknown as typeof fetch;
    expect(await fetchLatestSdkVersion()).toBe("0.3.11");
  });

  it("returns null on non-ok, malformed body, or a thrown fetch (graceful)", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      json: async () => ({ version: "0.3.11" }),
    })) as unknown as typeof fetch;
    expect(await fetchLatestSdkVersion()).toBeNull();

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    expect(await fetchLatestSdkVersion()).toBeNull();

    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await fetchLatestSdkVersion()).toBeNull();
  });
});
