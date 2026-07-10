// Pure coverage for the reverse-name display preference (the React plumbing in
// useReverseName / useReverseNamesCached is thin over the fully-tested quorum
// engine + cache; this pins the display DECISION: a quorum `*.mono` name is
// preferred over the single-operator label, and the bech32m fallback stands
// when there is no name).

import { describe, expect, it } from "vitest";
import { preferReverseNameLabel } from "./useReverseName.js";
import type { NameLabel } from "../../shared/name-resolution.js";

const ADDR = "0x" + "ab".repeat(20);
const operatorLabel: NameLabel = {
  address: ADDR,
  category: "human",
  displayName: "operator-assigned",
  updatedAtBlock: 5,
};

describe("preferReverseNameLabel", () => {
  it("prefers the quorum `*.mono` name over the operator label", () => {
    const r = preferReverseNameLabel(ADDR, "alice.mono", operatorLabel);
    expect(r?.displayName).toBe("alice.mono");
    expect(r?.category).toBe("human");
  });

  it("classifies the category from the name structure", () => {
    expect(preferReverseNameLabel(ADDR, "bot.agent.alice.mono", null)?.category).toBe("agent");
    expect(preferReverseNameLabel(ADDR, "acme.cluster.mono", null)?.category).toBe("cluster");
  });

  it("falls back to the operator label when there is no quorum name", () => {
    expect(preferReverseNameLabel(ADDR, undefined, operatorLabel)).toBe(operatorLabel);
  });

  it("returns undefined (→ show bech32m) when neither a name nor a label exists", () => {
    expect(preferReverseNameLabel(ADDR, undefined, undefined)).toBeUndefined();
  });

  it("still produces a label for a name even if it can't be parsed (defensive default)", () => {
    // The quorum layer only admits parseable names, so this is belt-and-suspenders.
    const r = preferReverseNameLabel(ADDR, "weird", null);
    expect(r?.displayName).toBe("weird");
    expect(r?.category).toBe("human");
  });
});
