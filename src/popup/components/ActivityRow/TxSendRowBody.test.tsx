import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { TxSendRow } from "../../../shared/activity.js";
import type { NameLabel } from "../../../shared/name-resolution.js";
import { TxSendRowBody } from "./TxSendRowBody.js";

const row: TxSendRow = {
  kind: "tx_send",
  blockHeight: 100,
  txIndex: 0,
  logIndex: 0,
  counterparty: "0x" + "22".repeat(20),
  amountDecimal: "5",
};

describe("TxSendRowBody — full label on hover (C)", () => {
  it("title is the PLAIN-text line (displayName only, never the CategoryBadge JSX)", () => {
    const label: NameLabel = {
      address: "0x" + "22".repeat(20),
      category: "contract",
      displayName: "alice.mono",
      updatedAtBlock: 1,
    };
    const html = renderToStaticMarkup(
      <TxSendRowBody row={row} counterpartyLabel={label} />,
    );
    // A title attribute can only hold text — the counterparty resolves to the
    // bare displayName, not the badge JSX shown in the visible line.
    expect(html).toContain('title="Sent 5 LYTH to alice.mono"');
  });

  it("title falls back to the short bech32m when no label is resolved", () => {
    const html = renderToStaticMarkup(
      <TxSendRowBody row={row} counterpartyLabel={undefined} />,
    );
    expect(html).toMatch(/title="Sent 5 LYTH to mono1[^"]+"/);
  });
});
