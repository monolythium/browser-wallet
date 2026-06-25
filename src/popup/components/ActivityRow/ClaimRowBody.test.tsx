import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ClaimRow } from "../../../shared/activity.js";
import { ClaimRowBody } from "./ClaimRowBody.js";

function claimRow(partial: Partial<ClaimRow> = {}): ClaimRow {
  return {
    kind: "claim",
    blockHeight: 500,
    txIndex: 0,
    logIndex: 0,
    amountDecimal: "1.5",
    ...partial,
  };
}

describe("ClaimRowBody (#3)", () => {
  it("renders a confirmed claim as 'Rewards claimed' + the LYTH amount", () => {
    const html = renderToStaticMarkup(
      <ClaimRowBody row={claimRow({ amountDecimal: "1.5" })} />,
    );
    expect(html).toContain("Rewards claimed");
    expect(html).toContain("1.5");
    expect(html).toContain("LYTH");
    expect(html).toContain("block 500");
    // Distinct rewards icon (gift box), not the plain receive arrow.
    expect(html).toContain('d="M5 12v9h14v-9"');
    expect(html).not.toContain("M12 5v14M5 12l7 7 7-7");
  });

  it("renders bare 'Rewards claimed' (no amount) when the figure is absent — no-mock, never a 0", () => {
    const html = renderToStaticMarkup(
      <ClaimRowBody row={claimRow({ amountDecimal: "0" })} />,
    );
    expect(html).toContain("Rewards claimed");
    expect(html).not.toContain("+0");
  });
});
