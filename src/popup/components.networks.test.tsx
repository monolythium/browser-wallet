import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Networks } from "./components.js";
import type { ChainEntry } from "./bg.js";

const TESTNET: ChainEntry = {
  chainId: "0x10F2C",
  name: "Monolythium Testnet",
  rpc: "http://op:8545",
  chainIdNum: 69420,
  builtin: true,
  official: true,
  active: true,
};

function render(canAddCustom: boolean): string {
  return renderToStaticMarkup(
    <Networks
      current={TESTNET}
      chains={[TESTNET]}
      onBack={() => {}}
      onOpenDetail={() => {}}
      onOpenAddCustom={() => {}}
      canAddCustom={canAddCustom}
    />,
  );
}

describe("Networks — add-custom-chain entry gating", () => {
  it("shows the Add custom chain entry when allowed (dev build + DEVELOPER_MODE)", () => {
    const html = render(true);
    expect(html).toContain("Add custom chain");
    expect(html).not.toContain("available in this build");
  });

  it("hides the entry + shows the note when not allowed (hardened build)", () => {
    const html = render(false);
    expect(html).not.toContain("Add custom chain");
    expect(html).toContain("available in this build");
  });
});
