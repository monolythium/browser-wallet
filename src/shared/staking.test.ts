import { describe, expect, it } from "vitest";
import {
  bindingPerClusterCapBps,
  clusterLabel,
  destinationAtPerClusterCap,
  dualCapHeadroomBps,
  exceedsPerClusterCap,
  formatWeightBpsPercent,
  isPerWalletCapRevert,
  isWalletTotalCapRevert,
  preflightDelegationVerdict,
  PER_WALLET_CAP_REVERT_MESSAGE,
  resolveClusterLabel,
  walletTotalHeadroomBps,
  WALLET_TOTAL_CAP_REVERT_MESSAGE,
  DELEGATION_PER_WALLET_CAP_BPS,
} from "./staking.js";

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

describe("per-wallet delegation cap (WP §16.7, 0x0213 pre-flight)", () => {
  it("the per-wallet cap default is 50% (5000 bps)", () => {
    expect(DELEGATION_PER_WALLET_CAP_BPS).toBe(5000);
  });

  it("binding cap: the per-wallet floor applies when the aggregate cap is null (fail-closed)", () => {
    // v2: lyth_getDelegationCap reports the DISABLED aggregate cap → null. The
    // per-wallet floor must NOT lift.
    expect(bindingPerClusterCapBps(null)).toBe(5000);
  });

  it("binding cap: a tighter future-active aggregate cap wins; otherwise the floor binds", () => {
    expect(bindingPerClusterCapBps(3000)).toBe(3000);
    expect(bindingPerClusterCapBps(8000)).toBe(5000);
  });

  it("exceedsPerClusterCap: a destination already at 5000 + any move → over cap (the live failure)", () => {
    expect(exceedsPerClusterCap(5000, 1, null)).toBe(true);
    expect(exceedsPerClusterCap(5000, 1250, null)).toBe(true);
  });

  it("exceedsPerClusterCap: 4000 + 500 ≤ 5000 allowed; 4000 + 1500 > 5000 blocked; exactly 5000 not over", () => {
    expect(exceedsPerClusterCap(4000, 500, null)).toBe(false);
    expect(exceedsPerClusterCap(4000, 1500, null)).toBe(true);
    expect(exceedsPerClusterCap(4000, 1000, null)).toBe(false); // == 5000, at cap not over
  });

  it("exceedsPerClusterCap: a null aggregate cap no longer disables the guard (the bug fix)", () => {
    expect(exceedsPerClusterCap(5000, 1250, null)).toBe(true);
  });

  it("destinationAtPerClusterCap: true at/above 5000, false below", () => {
    expect(destinationAtPerClusterCap(5000, null)).toBe(true);
    expect(destinationAtPerClusterCap(4999, null)).toBe(false);
    expect(destinationAtPerClusterCap(5001, null)).toBe(true);
  });

  it("isPerWalletCapRevert: matches the 0x0213 code/tag + name, ignores other codes", () => {
    expect(isPerWalletCapRevert(null, 0x0213)).toBe(true);
    expect(isPerWalletCapRevert("PerWalletCapExceeded", null)).toBe(true);
    expect(isPerWalletCapRevert("reverted: 0x0213", null)).toBe(true);
    expect(isPerWalletCapRevert("execution reverted", null)).toBe(false);
    expect(isPerWalletCapRevert("WeightOutOfRange 0x0204", 0x0204)).toBe(false);
    expect(isPerWalletCapRevert(null, null)).toBe(false);
  });

  it("isWalletTotalCapRevert: matches the 0x0205 code/tag + name, ignores other codes", () => {
    expect(isWalletTotalCapRevert(null, 0x0205)).toBe(true);
    expect(isWalletTotalCapRevert("WalletTotalExceeded", null)).toBe(true);
    expect(isWalletTotalCapRevert("reverted: 0x0205", null)).toBe(true);
    expect(isWalletTotalCapRevert("execution reverted", null)).toBe(false);
    expect(isWalletTotalCapRevert(null, 0x0213)).toBe(false); // doesn't steal the per-wallet code
    expect(isWalletTotalCapRevert(null, null)).toBe(false);
  });
});

describe("dual-cap headroom (delegate form — per-cluster floor ∩ wallet-total)", () => {
  it("walletTotalHeadroomBps: 100% ceiling across all clusters, never negative", () => {
    expect(walletTotalHeadroomBps(0)).toBe(10000);
    expect(walletTotalHeadroomBps(5100)).toBe(4900);
    expect(walletTotalHeadroomBps(10000)).toBe(0);
    expect(walletTotalHeadroomBps(10500)).toBe(0); // clamps, no negative
  });

  it("dualCapHeadroomBps: a null aggregate cap floors the cluster term to 5000, not 10000", () => {
    expect(dualCapHeadroomBps(null, 0, 0)).toBe(5000); // floor binds (the fix)
    expect(dualCapHeadroomBps(null, 4000, 0)).toBe(1000); // 5000 − 4000 cluster floor
  });

  it("dualCapHeadroomBps: the global ceiling binds when it is tighter than the floor", () => {
    expect(dualCapHeadroomBps(null, 0, 9000)).toBe(1000); // global 1000 < floor 5000
    expect(dualCapHeadroomBps(null, 0, 10000)).toBe(0); // fully delegated
  });

  it("dualCapHeadroomBps: a tighter future-active aggregate cap wins over the floor", () => {
    expect(dualCapHeadroomBps(2500, 0, 0)).toBe(2500); // aggregate 2500 < floor 5000
  });

  it("dualCapHeadroomBps: never returns negative headroom (already past the cap)", () => {
    expect(dualCapHeadroomBps(5000, 6000, 0)).toBe(0);
  });
});

describe("preflightDelegationVerdict (on-submit dual-cap block)", () => {
  const base = {
    action: "delegate" as const,
    dstExistingWeightBps: 0,
    totalDelegatedBps: 0,
    moveBps: 1000,
    capBps: null,
  };

  it("ok when under BOTH caps", () => {
    expect(preflightDelegationVerdict(base)).toEqual({ ok: true });
  });

  it("blocks (per-cluster) when the cluster move would exceed the 50% cap", () => {
    const v = preflightDelegationVerdict({
      ...base,
      dstExistingWeightBps: 4500,
      moveBps: 1000, // 5500 > 5000
    });
    expect(v).toEqual({ ok: false, message: PER_WALLET_CAP_REVERT_MESSAGE });
  });

  it("per-cluster fails closed to 5000 when capBps is null (disabled aggregate)", () => {
    // capBps null must NOT be read as 'unlimited' — the 5000 floor binds.
    expect(
      preflightDelegationVerdict({ ...base, dstExistingWeightBps: 5000, moveBps: 1, capBps: null }),
    ).toEqual({ ok: false, message: PER_WALLET_CAP_REVERT_MESSAGE });
  });

  it("blocks (wallet-total) when the delegate would push total past 100%", () => {
    const v = preflightDelegationVerdict({
      ...base,
      dstExistingWeightBps: 0, // per-cluster ok
      totalDelegatedBps: 9500,
      moveBps: 1000, // 10500 > 10000
    });
    expect(v).toEqual({ ok: false, message: WALLET_TOTAL_CAP_REVERT_MESSAGE });
  });

  it("redelegate is NOT flagged over-total (moves weight, total unchanged)", () => {
    // Same inputs that block a delegate on total — a redelegate must pass.
    const v = preflightDelegationVerdict({
      ...base,
      action: "redelegate",
      dstExistingWeightBps: 0,
      totalDelegatedBps: 9500,
      moveBps: 1000,
    });
    expect(v).toEqual({ ok: true });
  });

  it("redelegate STILL blocks on the destination per-cluster cap", () => {
    const v = preflightDelegationVerdict({
      ...base,
      action: "redelegate",
      dstExistingWeightBps: 4800,
      moveBps: 500, // 5300 > 5000 at the destination
    });
    expect(v).toEqual({ ok: false, message: PER_WALLET_CAP_REVERT_MESSAGE });
  });

  it("undelegate is never flagged (removes weight)", () => {
    const v = preflightDelegationVerdict({
      ...base,
      action: "undelegate",
      dstExistingWeightBps: 9000,
      totalDelegatedBps: 10000,
      moveBps: 5000,
    });
    expect(v).toEqual({ ok: true });
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

describe("resolveClusterLabel", () => {
  const dir = new Map<number, string | null>([
    [0, "halcyon.cluster.mono"],
    [3, null], // present but unnamed
  ]);

  it("prefers the captured name over the directory name", () => {
    expect(resolveClusterLabel(0, "captured.cluster.mono", dir)).toBe(
      "captured.cluster.mono",
    );
  });

  it("falls back to the directory name when no captured name", () => {
    expect(resolveClusterLabel(0, null, dir)).toBe("halcyon.cluster.mono");
    expect(resolveClusterLabel(0, undefined, dir)).toBe("halcyon.cluster.mono");
  });

  it("falls back to 'Cluster #<id>' when neither source names it (no-mock)", () => {
    expect(resolveClusterLabel(3, null, dir)).toBe("Cluster #3"); // present-but-null
    expect(resolveClusterLabel(9, null, dir)).toBe("Cluster #9"); // absent from dir
    expect(resolveClusterLabel(9, null, undefined)).toBe("Cluster #9"); // no dir at all
    expect(resolveClusterLabel(9, "", dir)).toBe("Cluster #9"); // empty captured name
  });
});
