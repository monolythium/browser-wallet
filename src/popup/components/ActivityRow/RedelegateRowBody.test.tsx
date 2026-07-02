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
    principalLythoshi: "",
    ...p,
  };
}

describe("RedelegateRowBody — from→to label + % weight badge at the line end", () => {
  it("label is 'Redelegated from src to dst'; the % sits in the right weight badge", () => {
    const dir = new Map<number, string | null>([[2, "polar"]]);
    const html = renderToStaticMarkup(
      <RedelegateRowBody row={redelegateRow()} clusterNameById={dir} />,
    );
    expect(html).toContain("Redelegated from halcyon to polar");
    expect(html).not.toContain("Moved delegation"); // old label gone
    // % moved OUT of the label into the right-side weight badge (like delegate).
    expect(html).toContain('class="ext-act-row__right"');
    expect(html).toContain("12.50%");
    expect(html).toContain(">weight<");
    // Hover title = the (no-%) label.
    expect(html).toContain('title="Redelegated from halcyon to polar"');
    // Distinct icon (E): `restake` — the delegate cluster satellites with a ↔
    // arrow at the center; not the generic swap glyph, not the stake center node.
    expect(html).toContain('d="M8 12h8M11 9l-3 3 3 3M13 9l3 3-3 3"'); // ↔ center arrow
    expect(html).toContain('cx="5" cy="7"'); // shares the delegate cluster satellites
    expect(html).not.toContain('cx="12" cy="12" r="3"'); // but not the stake center node
    expect(html).not.toContain("M7 10h14l-4-4M17 14H3l4 4"); // not the generic swap glyph
  });

  it("legacy (no captured bps) → no %, the badge shows the dash", () => {
    const dir = new Map<number, string | null>([[2, "polar"]]);
    const html = renderToStaticMarkup(
      <RedelegateRowBody row={redelegateRow({ weightBps: null })} clusterNameById={dir} />,
    );
    expect(html).toContain("Redelegated from halcyon to polar");
    expect(html).not.toContain("12.50%");
    expect(html).toContain('class="ext-act-row__right"'); // badge present (shows "—")
  });

  it("unknown destination (toCluster null) drops the ' to …' segment; % still in the badge", () => {
    const html = renderToStaticMarkup(
      <RedelegateRowBody row={redelegateRow({ toCluster: null })} clusterNameById={undefined} />,
    );
    expect(html).toContain("Redelegated from halcyon");
    expect(html).not.toContain(" to ");
    expect(html).toContain("12.50%");
  });

  it("unnamed source falls back to 'Cluster #<id>'", () => {
    const row: RedelegateRow = {
      kind: "redelegate",
      blockHeight: 1000,
      txIndex: 0,
      logIndex: 0,
      cluster: 3,
      toCluster: null,
      weightBps: 1250,
      principalLythoshi: "",
    };
    const html = renderToStaticMarkup(
      <RedelegateRowBody row={row} clusterNameById={undefined} />,
    );
    expect(html).toContain("Redelegated from Cluster #3");
  });
});
