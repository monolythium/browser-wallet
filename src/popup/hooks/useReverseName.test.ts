// Pure coverage for the reverse-name display preference (the React plumbing in
// useReverseName / useReverseNamesCached is thin over the fully-tested quorum
// engine + cache; this pins the display DECISION: a quorum `*.mono` name is
// preferred over the single-operator label, and the bech32m fallback stands
// when there is no name).

import { describe, expect, it } from "vitest";
import {
  preferReverseNameLabel,
  selectReverseNamesToResolve,
} from "./useReverseName.js";
import type { NameLabel } from "../../shared/name-resolution.js";
import {
  putReverseName,
  type ReverseNameCache,
} from "../../shared/reverse-name-cache.js";

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

describe("selectReverseNamesToResolve — the bounded eager-resolve guard", () => {
  const T0 = 1_000_000;
  const addr = (n: number) => "0x" + n.toString(16).padStart(40, "0");

  it("dedupes by unique address (one resolve per distinct counterparty, not per row)", () => {
    const rows = [addr(1), addr(1), addr(2), addr(1), addr(2)];
    expect(selectReverseNamesToResolve(rows, {}, T0, 30)).toEqual([addr(1), addr(2)]);
  });

  it("is cache-first — skips addresses already cached (a HIT or a cached MISS)", () => {
    let cache: ReverseNameCache = {};
    cache = putReverseName(cache, addr(1), "alice.mono", T0); // hit
    cache = putReverseName(cache, addr(2), null, T0); // cached miss
    const rows = [addr(1), addr(2), addr(3)];
    // only the uncached one is resolved
    expect(selectReverseNamesToResolve(rows, cache, T0, 30)).toEqual([addr(3)]);
  });

  it("re-resolves an entry that has gone STALE (past the TTL)", () => {
    const cache = putReverseName({}, addr(1), "alice.mono", T0);
    // 40 min later (> 30-min TTL) → treated as uncached
    expect(selectReverseNamesToResolve([addr(1)], cache, T0 + 40 * 60_000, 30)).toEqual([
      addr(1),
    ]);
  });

  it("is BOUNDED — caps at `max`, preserving row order (top rows first)", () => {
    const rows = Array.from({ length: 100 }, (_, i) => addr(i + 1));
    const picked = selectReverseNamesToResolve(rows, {}, T0, 30);
    expect(picked).toHaveLength(30);
    expect(picked[0]).toBe(addr(1));
    expect(picked[29]).toBe(addr(30));
  });

  it("lowercases addresses (cache keys + resolves stay canonical)", () => {
    const upper = "0x" + "AB".repeat(20);
    expect(selectReverseNamesToResolve([upper], {}, T0, 30)).toEqual([upper.toLowerCase()]);
  });
});
