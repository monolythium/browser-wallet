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
            amountLythoshi: "100000000",
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
    expect(html).toContain("Mature");
    expect(html).toContain("Cooldown");
    expect(html).toContain("Pending");
    expect(html).toContain("25.00%");
    expect(html).toContain("10.00%");
    expect(html).toContain("3.33%");
    expect(html).toContain("block 10");
    expect(html).toContain("block 22");
    expect(html).toContain("1 LYTH");
    expect(html).not.toContain("0 LYTH");
    expect(html).not.toContain("Unlock");
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
    expect(formatRedemptionQueueAmount("1")).toBe("0.00000001 LYTH");
    expect(formatRedemptionQueueAmount("100000000")).toBe("1 LYTH");
    expect(formatRedemptionQueueAmount(null)).toBeNull();
    expect(formatRedemptionQueueAmount("not-a-quantity")).toBeNull();
  });

  it("maps mature, cooldown, and unknown probes to distinct labels", () => {
    expect(redemptionTicketStatus(ticket({ mature: true })).label).toBe("Mature");
    expect(redemptionTicketStatus(ticket({ mature: false })).label).toBe("Cooldown");
    expect(redemptionTicketStatus(ticket({ mature: null })).label).toBe("Pending");
  });
});
