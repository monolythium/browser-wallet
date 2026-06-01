import { describe, expect, it } from "vitest";
import { clusterLabel, formatWeightBpsPercent } from "./staking.js";

describe("formatWeightBpsPercent", () => {
  it("renders basis points as a 2-dp percent (the delegation-weight display)", () => {
    expect(formatWeightBpsPercent(107)).toBe("1.07%");
    expect(formatWeightBpsPercent(1)).toBe("0.01%");
    expect(formatWeightBpsPercent(500)).toBe("5.00%");
    expect(formatWeightBpsPercent(10000)).toBe("100.00%");
  });

  it("never emits a 'bps' string and degrades to em-dash on null/non-finite", () => {
    expect(formatWeightBpsPercent(107)).not.toContain("bps");
    expect(formatWeightBpsPercent(null)).toBe("—");
    expect(formatWeightBpsPercent(Number.NaN)).toBe("—");
  });
});

describe("clusterLabel", () => {
  it("renders the real captured *.cluster.mono name when present", () => {
    expect(clusterLabel(0, "halcyon.cluster.mono")).toBe("halcyon.cluster.mono");
    expect(clusterLabel(7, "salt.cluster.mono")).toBe("salt.cluster.mono");
  });

  it("falls back to an honest 'Cluster #<id>' using the RAW id when no name is known", () => {
    expect(clusterLabel(0)).toBe("Cluster #0");
    expect(clusterLabel(0, undefined)).toBe("Cluster #0");
    expect(clusterLabel(0, null)).toBe("Cluster #0");
    expect(clusterLabel(0, "")).toBe("Cluster #0");
    expect(clusterLabel(7)).toBe("Cluster #7");
  });

  it("never fabricates a synthetic name (no off-by-one 'C-001', no fake .cluster.mono)", () => {
    // cluster 0 was the original "#0" bug: synthetic showed "C-001.cluster.mono".
    expect(clusterLabel(0)).not.toContain("C-001");
    expect(clusterLabel(0)).not.toContain(".cluster.mono");
    // The raw id is preserved exactly (no +1).
    expect(clusterLabel(0)).toBe("Cluster #0");
  });
});
