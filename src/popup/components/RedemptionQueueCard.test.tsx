import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  ClusterDirectoryEntry,
  RedemptionQueueRow,
  RedemptionQueueView,
} from "../../shared/staking.js";
import {
  formatRedemptionQueueAmount,
  RedemptionQueueCard,
  redemptionTicketStatus,
} from "./RedemptionQueueCard.js";

const clusters: ClusterDirectoryEntry[] = [
  {
    clusterId: 7,
    name: "halcyon.cluster.mono",
    size: 10,
    threshold: 7,
    health: "healthy",
    regions: ["fsn1", "hel1"],
    active: true,
    entity: "independent",
  },
];

function ticket(partial: Partial<RedemptionQueueRow>): RedemptionQueueRow {
  return {
    index: 0,
    cluster: 7,
    weightBps: 2500,
    amountLythoshi: null,
    amountWei: "0x0",
    unlockAt: null,
    createdHeight: "100",
    maturityHeight: "120",
    mature: false,
    ...partial,
  };
}

function queue(rows: RedemptionQueueRow[]): RedemptionQueueView {
  return {
    wallet: "0x" + "11".repeat(20),
    rows,
  };
}

describe("RedemptionQueueCard", () => {
  it("renders live height-based tickets without inventing zero amounts or unlock timestamps", () => {
    const html = renderToStaticMarkup(
      <RedemptionQueueCard
        queue={queue([
          ticket({
            index: 0,
            mature: true,
            amountLythoshi: "1000000000000000000",
            amountWei: "0x5f5e100",
            createdHeight: "10",
            maturityHeight: "20",
          }),
          ticket({
            index: 1,
            cluster: 9,
            weightBps: 1000,
            mature: false,
            createdHeight: "12",
            maturityHeight: "22",
          }),
          ticket({
            index: 2,
            cluster: 7,
            weightBps: 333,
            mature: null,
            createdHeight: "14",
            maturityHeight: "24",
          }),
        ])}
        isMock={false}
        error={null}
        clusters={clusters}
      />,
    );

    expect(html).toContain("Redemption queue");
    expect(html).toContain("3 tickets");
    expect(html).toContain("halcyon.cluster.mono");
    expect(html).toContain("cluster-9");
    expect(html).toContain("Ready to redeem");
    expect(html).toContain(
      "This ticket has matured. Complete the redemption to return the principal to your balance.",
    );
    expect(html).toContain("Maturing");
    expect(html).toContain(
      "Matures at block 22; the principal becomes redeemable then.",
    );
    expect(html).toContain("Probe pending");
    expect(html).toContain("25.00%");
    expect(html).toContain("10.00%");
    expect(html).toContain("3.33%");
    expect(html).toContain("block 10");
    expect(html).toContain("block 22");
    expect(html).toContain("1 LYTH");
    expect(html).not.toContain("0 LYTH");
    expect(html).not.toContain("Unlock");
    expect(html).not.toContain("Mature at the probed block height");
    // The false escrow-accounting claim must be gone everywhere.
    expect(html).not.toContain("unavailable until chain escrow accounting");
    // No onComplete handler passed → no per-ticket action rendered.
    expect(html).not.toMatch(/<button\b/i);
  });

  it("renders a Complete redemption action for matured tickets when onComplete is wired", () => {
    const html = renderToStaticMarkup(
      <RedemptionQueueCard
        queue={queue([
          ticket({
            index: 0,
            mature: true,
            amountLythoshi: "1000000000000000000",
            createdHeight: "10",
            maturityHeight: "20",
          }),
          ticket({
            index: 1,
            mature: false,
            createdHeight: "12",
            maturityHeight: "22",
          }),
        ])}
        isMock={false}
        error={null}
        clusters={clusters}
        onComplete={() => {}}
      />,
    );

    expect(html).toContain("Ready to redeem");
    expect(html).toContain("Complete redemption");
    expect(html).toMatch(/<button\b/i);
    // The not-yet-mature ticket must not expose the action.
    expect((html.match(/Complete redemption/g) ?? []).length).toBe(1);
    expect(html).not.toContain("unavailable until chain escrow accounting");
  });

  it("disables the in-flight ticket's Complete redemption button", () => {
    const html = renderToStaticMarkup(
      <RedemptionQueueCard
        queue={queue([
          ticket({
            index: 0,
            mature: true,
            amountLythoshi: "1000000000000000000",
            createdHeight: "10",
            maturityHeight: "20",
          }),
        ])}
        isMock={false}
        error={null}
        clusters={clusters}
        onComplete={() => {}}
        completingIndex={0}
      />,
    );

    expect(html).toContain("Completing");
    expect(html).toMatch(/<button\b[^>]*disabled/i);
  });

  it("renders an honest empty live queue", () => {
    const html = renderToStaticMarkup(
      <RedemptionQueueCard
        queue={queue([])}
        isMock={false}
        error={null}
        clusters={clusters}
      />,
    );

    expect(html).toContain("0 tickets");
    expect(html).toContain("No redemption tickets are queued for this wallet.");
  });

  it("keeps the empty mock fallback explicit", () => {
    const html = renderToStaticMarkup(
      <RedemptionQueueCard
        queue={queue([])}
        isMock={true}
        error={null}
        clusters={clusters}
      />,
    );

    expect(html).toContain("fallback");
    expect(html).toContain(
      "Live redemption queue is unavailable; no local mock tickets are shown.",
    );
  });

  it("surfaces malformed live reads as errors instead of an empty queue", () => {
    const html = renderToStaticMarkup(
      <RedemptionQueueCard
        queue={null}
        isMock={false}
        error="malformed lyth_redemptionQueue response"
        clusters={clusters}
      />,
    );

    expect(html).toContain("malformed lyth_redemptionQueue response");
    expect(html).not.toContain("No redemption tickets are queued");
  });
});

describe("redemption queue formatting helpers", () => {
  it("formats only real optional amount fields", () => {
    // Chain migrated 8 → 18 decimals: 1 lythoshi == 1 wei, 1 LYTH = 10^18 lythoshi.
    expect(formatRedemptionQueueAmount("1")).toBe("0.000000000000000001 LYTH");
    expect(formatRedemptionQueueAmount("1000000000000000000")).toBe("1 LYTH");
    expect(formatRedemptionQueueAmount(null)).toBeNull();
    expect(formatRedemptionQueueAmount("not-a-quantity")).toBeNull();
  });

  it("maps mature, cooldown, and unknown probes to accurate redemption labels", () => {
    expect(redemptionTicketStatus(ticket({ mature: true })).label).toBe(
      "Ready to redeem",
    );
    expect(redemptionTicketStatus(ticket({ mature: true })).detail).toContain(
      "Complete the redemption to return the principal",
    );
    expect(redemptionTicketStatus(ticket({ mature: true })).tone).toBe("ready");
    expect(redemptionTicketStatus(ticket({ mature: false })).label).toBe(
      "Maturing",
    );
    expect(redemptionTicketStatus(ticket({ mature: null })).label).toBe(
      "Probe pending",
    );
    // The false escrow-accounting claim must be gone from every status.
    for (const m of [true, false, null] as const) {
      expect(redemptionTicketStatus(ticket({ mature: m })).detail).not.toContain(
        "unavailable until chain escrow accounting",
      );
    }
  });
});
