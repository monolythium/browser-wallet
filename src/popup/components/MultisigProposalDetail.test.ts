// Pure-helper tests for MultisigProposalDetail.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  formatLythoshiValue,
  formatRemaining,
  MultisigProposalDetail,
  shortenHex,
} from "./MultisigProposalDetail.js";
import type {
  MultisigSigner,
  PendingProposal,
} from "../../shared/multisig.js";

describe("formatRemaining", () => {
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  it('returns "expired" for negative ms', () => {
    expect(formatRemaining(-1)).toBe("expired");
    expect(formatRemaining(-1_000_000)).toBe("expired");
  });

  it('returns "<1m" for 0..59 seconds', () => {
    expect(formatRemaining(0)).toBe("<1m");
    expect(formatRemaining(59_000)).toBe("<1m");
  });

  it("returns minutes when in [1m, 1h)", () => {
    expect(formatRemaining(MIN)).toBe("1m");
    expect(formatRemaining(59 * MIN)).toBe("59m");
  });

  it("returns Hh Mm when in [1h, 1d)", () => {
    expect(formatRemaining(HOUR)).toBe("1h 0m");
    expect(formatRemaining(HOUR + 30 * MIN)).toBe("1h 30m");
    expect(formatRemaining(23 * HOUR + 59 * MIN)).toBe("23h 59m");
  });

  it("returns Nd Hh when >= 1d", () => {
    expect(formatRemaining(DAY)).toBe("1d 0h");
    expect(formatRemaining(7 * DAY)).toBe("7d 0h");
    expect(formatRemaining(7 * DAY + 5 * HOUR + 30 * MIN)).toBe("7d 5h");
  });
});

describe("formatLythoshiValue", () => {
  it('returns "0 LYTH" for zero/empty input', () => {
    expect(formatLythoshiValue("")).toBe("0 LYTH");
    expect(formatLythoshiValue("0x")).toBe("0 LYTH");
    expect(formatLythoshiValue("0x0")).toBe("0 LYTH");
  });

  it("formats hex lythoshi as native LYTH with 18-decimal precision", () => {
    // Chain migrated 8 → 18 decimals: 1 lythoshi == 1 wei == 10^-18 LYTH.
    expect(formatLythoshiValue("0x1")).toBe("0.000000000000000001 LYTH");
    expect(formatLythoshiValue("0xff")).toBe("0.000000000000000255 LYTH");
    expect(formatLythoshiValue("0x" + 1_000_000_000_000_000_000n.toString(16))).toBe(
      "1 LYTH",
    );
    expect(formatLythoshiValue("0x" + 1_234_567_890_000_000_000n.toString(16))).toBe(
      "1.23456789 LYTH",
    );
  });

  it("does not expose raw input for unparseable hex", () => {
    expect(formatLythoshiValue("not-hex")).toBe("? LYTH");
  });
});

describe("MultisigProposalDetail value display", () => {
  const NOW = 1_700_000_000_000;
  const ONE_LYTH_IN_LYTHOSHI_HEX = "0x" + 1_000_000_000_000_000_000n.toString(16);
  const signers: MultisigSigner[] = [
    {
      id: "s-1",
      label: "Signer 1",
      address: "0x" + "11".repeat(20),
      pubkey: "0x01",
      role: "self",
    },
    {
      id: "s-2",
      label: "Signer 2",
      address: "0x" + "22".repeat(20),
      pubkey: "0x02",
      role: "external",
    },
  ];

  function makeProposal(valueWeiHex: string): PendingProposal {
    return {
      id: "p-1",
      proposedBy: "s-1",
      createdAt: NOW,
      expiresAt: NOW + 60_000,
      vaultAddress: "0x" + "33".repeat(20),
      action: {
        kind: "send",
        to: "0x" + "44".repeat(20),
        valueWeiHex,
        chainIdHex: "0x10F2C",
      },
      approvals: [{ signerId: "s-1", signature: "0x01", signedAt: NOW }],
      rejections: [],
      status: "pending",
      txHash: null,
    };
  }

  it("renders native LYTH instead of the raw compatibility value", () => {
    const html = renderToStaticMarkup(
      createElement(MultisigProposalDetail, {
        proposal: makeProposal(ONE_LYTH_IN_LYTHOSHI_HEX),
        signers,
        threshold: 2,
        now: NOW,
      }),
    );

    expect(html).toContain(">Value</div>");
    expect(html).toContain(">1 LYTH</div>");
    expect(html).not.toContain("Value (wei)");
    expect(html).not.toContain("valueWeiHex");
    expect(html).not.toContain(">1000000000000000000</div>");
  });
});

describe("shortenHex", () => {
  it("returns empty for undefined/empty", () => {
    expect(shortenHex(undefined)).toBe("");
    expect(shortenHex("")).toBe("");
  });

  it("returns short strings unchanged", () => {
    expect(shortenHex("0x12")).toBe("0x12");
    expect(shortenHex("0xabcdef")).toBe("0xabcdef");
  });

  it("ellipsizes long hex strings", () => {
    const long = "0x" + "ab".repeat(40);
    const out = shortenHex(long);
    expect(out).toMatch(/^0x[a-f0-9]+…[a-f0-9]+$/);
    expect(out.startsWith("0xabab")).toBe(true);
    expect(out.endsWith("ababab")).toBe(true);
  });
});
