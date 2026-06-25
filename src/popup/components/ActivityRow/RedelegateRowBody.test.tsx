import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { RedelegateRow } from "../../../shared/activity.js";
import { RedelegateRowBody } from "./RedelegateRowBody.js";

function redelegateRow(p: Partial<RedelegateRow> = {}): RedelegateRow {
  return {
    kind: "redelegate",
    blockHeight: 1000,
    txIndex: 0,
    logIndex: 0,
    cluster: 1,
    toCluster: 2,
    weightBps: 1250,
    clusterName: "halcyon",
    ...p,
  };
}

describe("RedelegateRowBody — named confirmed label (B)", () => {
  it("renders 'Redelegated 12.50% from halcyon to polar' (dst from the directory)", () => {
    const dir = new Map<number, string | null>([[2, "polar"]]);
    const html = renderToStaticMarkup(
      <RedelegateRowBody row={redelegateRow()} clusterNameById={dir} />,
    );
    expect(html).toContain("Redelegated 12.50% from halcyon to polar");
    expect(html).not.toContain("Moved delegation"); // old label gone
    // The duplicate right-side weight badge is dropped (the % is in the line).
    expect(html).not.toContain('class="ext-act-row__right"');
    // Full label on hover (C): the title carries the untruncated string.
    expect(html).toContain('title="Redelegated 12.50% from halcyon to polar"');
  });

  it("legacy (no captured bps) → 'Redelegated from halcyon to polar', no %", () => {
    const dir = new Map<number, string | null>([[2, "polar"]]);
    const html = renderToStaticMarkup(
      <RedelegateRowBody row={redelegateRow({ weightBps: null })} clusterNameById={dir} />,
    );
    expect(html).toContain("Redelegated from halcyon to polar");
    expect(html).not.toContain("12.50%");
  });

  it("unknown destination (toCluster null) drops the ' to …' segment", () => {
    const html = renderToStaticMarkup(
      <RedelegateRowBody row={redelegateRow({ toCluster: null })} clusterNameById={undefined} />,
    );
    expect(html).toContain("Redelegated 12.50% from halcyon");
    expect(html).not.toContain(" to ");
  });

  it("unnamed source falls back to 'Cluster #<id>'", () => {
    // No captured `clusterName` → honest #id (omit the optional field entirely).
    const row: RedelegateRow = {
      kind: "redelegate",
      blockHeight: 1000,
      txIndex: 0,
      logIndex: 0,
      cluster: 3,
      toCluster: null,
      weightBps: 1250,
    };
    const html = renderToStaticMarkup(
      <RedelegateRowBody row={row} clusterNameById={undefined} />,
    );
    expect(html).toContain("Redelegated 12.50% from Cluster #3");
  });
});
