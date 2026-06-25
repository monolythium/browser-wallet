import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { UndelegateRow } from "../../../shared/activity.js";
import { UndelegateRowBody } from "./UndelegateRowBody.js";

const row: UndelegateRow = {
  kind: "undelegate",
  blockHeight: 1000,
  txIndex: 0,
  logIndex: 0,
  cluster: 1,
  weightBps: 5000,
  clusterName: "halcyon",
};

describe("UndelegateRowBody (B + C + E)", () => {
  it("renders the named label + hover title, and the distinct `unstake` glyph", () => {
    const html = renderToStaticMarkup(<UndelegateRowBody row={row} clusterNameById={undefined} />);
    expect(html).toContain("Undelegated from halcyon");
    expect(html).toContain('title="Undelegated from halcyon"');
    // Distinct icon (E): undelegate uses `unstake` (node + ↓), not `stake`.
    expect(html).toContain('d="M12 11v7M8 14l4 4 4-4"');
    expect(html).not.toContain('cx="5" cy="7"'); // not the stake cluster
  });
});
