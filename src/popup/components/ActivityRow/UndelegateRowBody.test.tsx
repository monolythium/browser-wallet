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
  principalLythoshi: "",
};

describe("UndelegateRowBody (B + C + E)", () => {
  it("renders the named label + hover title, and the distinct `unstake` glyph", () => {
    const html = renderToStaticMarkup(<UndelegateRowBody row={row} clusterNameById={undefined} />);
    expect(html).toContain("Undelegated from halcyon");
    expect(html).toContain('title="Undelegated from halcyon"');
    // Distinct icon (E): undelegate uses `unstake` (cluster + center ↓),
    // harmonious with delegate's `stake` but NOT its center node.
    expect(html).toContain('d="M12 7v8M9 13l3 3 3-3"');
    expect(html).not.toContain('cx="12" cy="12" r="3"'); // not the stake center node
  });
});
