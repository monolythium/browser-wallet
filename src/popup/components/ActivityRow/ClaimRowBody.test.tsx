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
  });

  it("renders bare 'Rewards claimed' (no amount) when the figure is absent — no-mock, never a 0", () => {
    const html = renderToStaticMarkup(
      <ClaimRowBody row={claimRow({ amountDecimal: "0" })} />,
    );
    expect(html).toContain("Rewards claimed");
    expect(html).not.toContain("+0");
  });
});
