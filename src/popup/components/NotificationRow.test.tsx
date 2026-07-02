import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { NotificationRecord } from "../../shared/notifications.js";
import { NotificationRow } from "./NotificationRow.js";

function record(over: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: "69420:0xab",
    txHash: "0x" + "ab".repeat(32),
    status: "confirmed",
    blockNumber: 100,
    kind: "redelegate",
    amountDecimal: "0",
    counterparty: "0x" + "11".repeat(20),
    clusterId: 1,
    clusterName: "halcyon",
    createdAtMs: 1_700_000_000_000,
    read: true,
    schemaVersion: 0,
    ...over,
  };
}

describe("NotificationRow — distinct delegation icon + failed-red (E)", () => {
  it("a FAILED redelegate renders the distinct `restake` glyph in the error tone", () => {
    const html = renderToStaticMarkup(
      <NotificationRow record={record({ status: "failed" })} onOpen={() => {}} showUnread={false} />,
    );
    expect(html).toContain("Redelegate failed"); // notificationTitle redelegate/failed
    expect(html).toContain('d="M8 12h8M11 9l-3 3 3 3M13 9l3 3-3 3"'); // restake glyph center ↔ arrow (not stake)
    expect(html).toContain("var(--err"); // red status ring + icon color
    expect(html).not.toContain("var(--ok"); // not the confirmed-green tone
  });

  it("a CONFIRMED undelegate uses the `unstake` glyph in the green tone", () => {
    const html = renderToStaticMarkup(
      <NotificationRow record={record({ kind: "undelegate", status: "confirmed" })} onOpen={() => {}} showUnread={false} />,
    );
    expect(html).toContain('d="M12 7v8M9 13l3 3 3-3"'); // unstake glyph
    expect(html).toContain("var(--ok"); // confirmed-green ring
  });
});
